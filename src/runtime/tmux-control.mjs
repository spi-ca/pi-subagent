import { spawn } from "node:child_process";
import { recordPhase0LiveTelemetry } from "./phase0-live-telemetry.mjs";
const MAX_LINE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_LINES = 4096;
const MAX_QUEUE = 32;
const NORMAL_QUEUE_LIMIT = 24;
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const RESPONSE_RE = /^%(begin|end|error) ([0-9]+) ([0-9]+) ([0-9]+)$/;
const RESYNC_NOTIFICATIONS = ["%layout-change ", "%window-add ", "%window-close ", "%sessions-changed", "%session-changed ", "%subscription-changed ", "%exit"];
let nextRefreshSubscriptionId = 0;
const transportMetrics = { clientsSpawned: 0, clientsClosed: 0, commandsDispatched: 0, notifications: 0, commandNames: new Map() };
export function resetTmuxControlMetrics() {
    transportMetrics.clientsSpawned = 0; transportMetrics.clientsClosed = 0; transportMetrics.commandsDispatched = 0; transportMetrics.notifications = 0; transportMetrics.commandNames.clear();
}
export function snapshotTmuxControlMetrics() {
    return { clientsSpawned: transportMetrics.clientsSpawned, clientsClosed: transportMetrics.clientsClosed, commandsDispatched: transportMetrics.commandsDispatched, notifications: transportMetrics.notifications, commandNames: Object.fromEntries([...transportMetrics.commandNames.entries()].sort(([left], [right]) => left.localeCompare(right))) };
}
export class TmuxControlError extends Error {
    code;
    disconnectCategory;
    constructor(code, message, disconnectCategory) {
        super(message);
        this.code = code;
        this.disconnectCategory = disconnectCategory;
        this.name = "TmuxControlError";
    }
}
export class TmuxControlUnknownOutcomeError extends TmuxControlError {
    commandName;
    constructor(commandName, cause) {
        super("TMUX_UNKNOWN_OUTCOME", `tmux control mutation outcome is unknown: ${commandName}`);
        this.commandName = commandName;
        if (cause !== undefined)
            this.cause = cause;
    }
}
/** Encode exactly one tmux command-language token without shell evaluation. */
export function encodeTmuxToken(value) {
    if (typeof value !== "string" || /[\0\r\n]/.test(value))
        throw new TmuxControlError("TMUX_TOKEN", "tmux token contains a forbidden line byte");
    // cmd-parse.y suppresses backslash, tilde and variable expansion in single
    // quotes. A literal quote is emitted by closing, escaping, and reopening the
    // same token; no whitespace or separator is introduced.
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
export function tmuxCommand(name, args) {
    if (!/^[a-z][a-z-]*$/.test(name))
        throw new TmuxControlError("TMUX_COMMAND", "tmux command name is invalid");
    const line = [name, ...args.map(encodeTmuxToken)].join(" ");
    if (Buffer.byteLength(line) > MAX_LINE_BYTES)
        throw new TmuxControlError("TMUX_COMMAND", "tmux command exceeds the line limit");
    return line;
}
function boundedTimeout(value, fallback, option) {
    const timeoutMs = value ?? fallback;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)
        throw new TmuxControlError("TMUX_TIMEOUT", `${option} must be a positive integer no greater than ${MAX_TIMEOUT_MS}ms`);
    return timeoutMs;
}
function boundedExpectedResponses(value) {
    const expectedResponses = value ?? 1;
    if (!Number.isSafeInteger(expectedResponses) || expectedResponses < 1 || expectedResponses > 2)
        throw new TmuxControlError("TMUX_RESPONSES", "expectedResponses must be an integer from 1 through 2");
    return expectedResponses;
}
const PROTOCOL_DISCONNECT_CATEGORIES = new Set([
    "uncorrelated-ok-empty",
    "uncorrelated-ok-nonempty",
    "uncorrelated-error-empty",
    "uncorrelated-error-nonempty",
    "parser-framing",
    "chunk",
    "line",
    "utf8",
]);
function disconnectDetail(error) {
    const code = error instanceof TmuxControlError ? error.code : "TMUX_OTHER";
    let category = "other";
    if (code === "TMUX_TIMEOUT")
        category = "timeout";
    else if (code === "TMUX_PROTOCOL")
        // Protocol categories are assigned only at known client failure sites.
        category = error instanceof TmuxControlError && PROTOCOL_DISCONNECT_CATEGORIES.has(error.disconnectCategory ?? "") ? error.disconnectCategory : "parser-framing";
    else if (code === "TMUX_EOF" || code === "TMUX_EXIT")
        category = "exit";
    else if (code === "TMUX_CLOSED")
        category = "closed";
    return Object.freeze({ code, category });
}
function disconnectReason(error) {
    return disconnectDetail(error).category;
}
function protocolFailure(category, message) {
    return new TmuxControlError("TMUX_PROTOCOL", message, category);
}
/** Stateful strict parser for the tmux control-mode format pinned to the 3.7b baseline. */
export class TmuxControlParser {
    block = null;
    consume(line) {
        if (Buffer.byteLength(line) > MAX_LINE_BYTES || line.includes("\0") || line.includes("\r") || line.includes("\n"))
            throw new TmuxControlError("TMUX_PROTOCOL", "invalid tmux control line");
        const marker = line.match(RESPONSE_RE);
        if (this.block) {
            if (marker?.[1] === "begin")
                throw new TmuxControlError("TMUX_PROTOCOL", "nested tmux response block");
            if (marker?.[1] === "end" || marker?.[1] === "error") {
                const tuple = `${marker[2]} ${marker[3]} ${marker[4]}`;
                if (tuple !== this.block.tuple)
                    throw new TmuxControlError("TMUX_PROTOCOL", "tmux response tuple mismatch");
                const response = { kind: "response", ok: marker[1] === "end", lines: this.block.lines };
                this.block = null;
                return response;
            }
            if (/^%[a-z][a-z-]*(?: |$)/.test(line))
                throw new TmuxControlError("TMUX_PROTOCOL", "notification occurred inside a tmux response block");
            this.block.bytes += Buffer.byteLength(line) + 1;
            if (this.block.bytes > MAX_RESPONSE_BYTES || this.block.lines.length >= MAX_RESPONSE_LINES)
                throw new TmuxControlError("TMUX_PROTOCOL", "tmux response exceeds bounds");
            this.block.lines.push(line);
            return null;
        }
        if (marker) {
            if (marker[1] !== "begin")
                throw new TmuxControlError("TMUX_PROTOCOL", "tmux response ended without begin");
            this.block = { tuple: `${marker[2]} ${marker[3]} ${marker[4]}`, lines: [], bytes: 0 };
            return null;
        }
        if (line.startsWith("%output ") || line.startsWith("%extended-output "))
            return { kind: "output" };
        if (!line.startsWith("%"))
            throw new TmuxControlError("TMUX_PROTOCOL", "unexpected output outside tmux response block");
        const name = line.split(" ", 1)[0];
        return { kind: "notification", notification: { name, line, resync: RESYNC_NOTIFICATIONS.some((prefix) => line === prefix || line.startsWith(prefix)) } };
    }
    finish() { if (this.block)
        throw new TmuxControlError("TMUX_PROTOCOL", "EOF inside tmux response block"); }
}
const CONTROL_COMMAND_ALLOWLIST = new Set(["display-message", "list-panes", "split-window", "new-window", "if-shell", "send-keys", "kill-pane", "refresh-client"]);
const TMUX_PANE_ID_RE = /^%(?:0|[1-9][0-9]*)$/;
const REPO_GUARD_NOOP = "display-message -p -l pi-subagent-guard-noop";
function expectedResponsesForCommand(name, tokens) {
    if (name !== "if-shell" || tokens.length !== 6)
        return 1;
    const [formatFlag, targetFlag, target, condition, whenTrue, whenFalse] = tokens;
    const guardedCondition = /^#\{&&:#\{==:#\{pid},[1-9][0-9]*},#\{==:#\{pane_pid},[1-9][0-9]*}}$/.test(condition);
    const guardedMutation = whenTrue === `send-keys -t ${target} Escape` || whenTrue === `kill-pane -t ${target}`;
    return formatFlag === "-F" && targetFlag === "-t" && TMUX_PANE_ID_RE.test(target)
        && guardedCondition && guardedMutation && whenTrue.length > 0 && whenFalse === REPO_GUARD_NOOP ? 2 : 1;
}
/** Translate only this package's argv vocabulary to serialized tmux command text. */
export function createTmuxControlCommandRunner(client, expectedSocketPath) {
    return async (args, options = {}) => {
        if (options.signal?.aborted)
            return { exitCode: 130, stdout: "", stderr: "aborted", aborted: true };
        let commandArgs = args;
        if (args[0] === "-S") {
            if (args.length < 3 || args[1] !== expectedSocketPath)
                return { exitCode: 1, stdout: "", stderr: "tmux control socket mismatch", aborted: false };
            commandArgs = args.slice(2);
        }
        const [name, ...tokens] = commandArgs;
        if (!name || !CONTROL_COMMAND_ALLOWLIST.has(name))
            return { exitCode: 1, stdout: "", stderr: "unsupported tmux control command", aborted: false };
        const mutation = name === "split-window" || name === "new-window" || name === "if-shell" || name === "send-keys" || name === "kill-pane";
        try {
            const lines = await client.execute(tmuxCommand(name, tokens), { name, mutation, reserved: name === "if-shell" || name === "send-keys" || name === "kill-pane", expectedResponses: expectedResponsesForCommand(name, tokens) });
            return { exitCode: 0, stdout: lines.length ? `${lines.join("\n")}\n` : "", stderr: "", aborted: false, ...(mutation ? { dispatched: true } : {}) };
        }
        catch (error) {
            return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : "tmux control failure", aborted: false, ...(mutation ? { dispatched: true } : {}) };
        }
    };
}
/** One supervised serialized `tmux -C` process for one socket/session generation. */
export class TmuxControlClient {
    options;
    refreshSubscriptionName;
    process = null;
    parser = new TmuxControlParser();
    queue = [];
    active = null;
    buffer = Buffer.alloc(0);
    startupResolve = null;
    startupReject = null;
    notificationWaiters = new Set();
    notificationGeneration = 0;
    lastNotificationTimestamp = null;
    closed = false;
    requestBacklogHighWater = 0;
    lineBacklogHighWater = 0;
    byteBacklogHighWater = 0;
    startupTimeoutMs;
    commandTimeoutMs;
    constructor(options) {
        this.options = options;
        // Retain the old shared option as a compatibility fallback; the
        // dedicated values let callers bound attach and commands independently.
        this.startupTimeoutMs = boundedTimeout(options.startupTimeoutMs ?? options.timeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs");
        this.commandTimeoutMs = boundedTimeout(options.commandTimeoutMs ?? options.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS, "commandTimeoutMs");
        if (!/^\$[0-9]+$/.test(options.sessionId))
            throw new TmuxControlError("TMUX_SESSION", "tmux control session id is invalid");
        // tmux subscription names are server-global. Keep this client's name
        // token-safe and unique so another control client cannot replace it.
        if (nextRefreshSubscriptionId >= Number.MAX_SAFE_INTEGER)
            throw new TmuxControlError("TMUX_STATE", "tmux control subscription id is exhausted");
        this.refreshSubscriptionName = `pi-subagent-pane-dead-${process.pid}-${(++nextRefreshSubscriptionId).toString(36)}`;
    }
    async start() {
        if (this.process || this.closed)
            throw new TmuxControlError("TMUX_STATE", "tmux control client cannot start");
        const spawnProcess = this.options.spawnProcess ?? spawn;
        // tmux applies attach flags while creating the control client. Suppress pane
        // output here rather than with a post-attach command so no output can reach
        // this process before the client option takes effect.
        const child = spawnProcess(this.options.executable, ["-S", this.options.socketPath, "-C", "attach-session", "-f", "no-output", "-t", this.options.sessionId], { stdio: ["pipe", "pipe", "pipe"] });
        this.process = child;
        transportMetrics.clientsSpawned += 1;
        recordPhase0LiveTelemetry("tmux", "backendSpawns");
        recordPhase0LiveTelemetry("tmux", "persistentClientCreates");
        child.stdout.on("data", (chunk) => this.onData(chunk));
        child.stderr.on("data", () => { });
        child.once("error", (error) => this.fail(error));
        child.once("exit", () => this.fail(new TmuxControlError("TMUX_EOF", "tmux control client exited")));
        await new Promise((resolve, reject) => {
            this.startupResolve = resolve;
            this.startupReject = reject;
            const timer = setTimeout(() => this.fail(new TmuxControlError("TMUX_TIMEOUT", "tmux control startup timed out")), this.startupTimeoutMs);
            const done = () => clearTimeout(timer);
            const wrappedResolve = this.startupResolve;
            this.startupResolve = () => { done(); wrappedResolve?.(); };
            const wrappedReject = this.startupReject;
            this.startupReject = (error) => { done(); wrappedReject?.(error); };
        });
        await this.execute(tmuxCommand("refresh-client", ["-B", `${this.refreshSubscriptionName}:%*:#{pane_dead}`]), { name: "refresh-client", reserved: true });
    }
    processId() { return this.process?.pid ?? null; }
    notificationSequence() { return this.notificationGeneration; }
    lastNotificationAt() { return this.lastNotificationTimestamp; }
    waitForNotification(timeoutMs) {
        if (this.closed)
            return Promise.resolve("disconnect");
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
            return Promise.reject(new TmuxControlError("TMUX_TIMEOUT", "tmux notification timeout is invalid"));
        if (this.notificationWaiters.size >= MAX_QUEUE)
            return Promise.reject(new TmuxControlError("TMUX_OVERLOAD", "tmux notification waiter queue is full"));
        return new Promise((resolve) => {
            const waiter = { resolve, timer: undefined };
            waiter.timer = setTimeout(() => {
                this.notificationWaiters.delete(waiter);
                resolve("timeout");
            }, timeoutMs);
            this.notificationWaiters.add(waiter);
        });
    }
    settleNotificationWaiters(reason) {
        for (const waiter of this.notificationWaiters) {
            if (waiter.timer)
                clearTimeout(waiter.timer);
            waiter.resolve(reason);
        }
        this.notificationWaiters.clear();
    }
    execute(line, options = {}) {
        let expectedResponses;
        try {
            expectedResponses = boundedExpectedResponses(options.expectedResponses);
        }
        catch (error) {
            return Promise.reject(error);
        }
        if (!this.process || this.closed || /[\0\r\n]/.test(line) || Buffer.byteLength(line) > MAX_LINE_BYTES)
            return Promise.reject(new TmuxControlError("TMUX_STATE", "tmux control command is unavailable"));
        const pending = this.queue.length + (this.active ? 1 : 0);
        if (pending >= MAX_QUEUE || (!options.reserved && pending >= NORMAL_QUEUE_LIMIT))
            return Promise.reject(new TmuxControlError("TMUX_OVERLOAD", "tmux control queue is full"));
        return new Promise((resolve, reject) => {
            this.queue.push({ name: options.name ?? "command", line, mutation: options.mutation ?? false, expectedResponses, responses: 0, responseLines: 0, responseBytes: 0, lines: [], resolve, reject, written: false });
            const backlog = this.queue.length + (this.active ? 1 : 0);
            if (backlog > this.requestBacklogHighWater) { this.requestBacklogHighWater = backlog; recordPhase0LiveTelemetry("tmux", "requestBacklogHighWater", backlog); }
            this.dispatch();
        });
    }
    dispatch() {
        if (this.active || !this.process || this.closed)
            return;
        const item = this.queue.shift();
        if (!item)
            return;
        this.active = item;
        transportMetrics.commandsDispatched += 1;
        recordPhase0LiveTelemetry("tmux", "backendRequests");
        if (item.name === "list-panes" || item.name === "display-message") recordPhase0LiveTelemetry("tmux", "exactSnapshots", 1, item.name === "list-panes" ? "list-panes" : "display-message");
        if (item.name === "kill-pane") recordPhase0LiveTelemetry("tmux", "exactCleanupMutations", 1, "kill-pane");
        transportMetrics.commandNames.set(item.name, (transportMetrics.commandNames.get(item.name) ?? 0) + 1);
        item.timer = setTimeout(() => this.failItem(item, new TmuxControlError("TMUX_TIMEOUT", "tmux control command timed out")), this.commandTimeoutMs);
        item.written = true;
        this.process.stdin.write(`${item.line}\n`, (error) => { if (error)
            this.failItem(item, error); });
    }
    onData(chunk) {
        if (this.closed || chunk.length > MAX_RESPONSE_BYTES) {
            this.fail(protocolFailure("chunk", "tmux control input chunk exceeds bounds"));
            return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const bufferedLines = this.buffer.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0);
        if (this.buffer.length > this.byteBacklogHighWater) { this.byteBacklogHighWater = this.buffer.length; recordPhase0LiveTelemetry("tmux", "byteBacklogHighWater", this.buffer.length); }
        if (bufferedLines > this.lineBacklogHighWater) { this.lineBacklogHighWater = bufferedLines; recordPhase0LiveTelemetry("tmux", "lineBacklogHighWater", bufferedLines); }
        if (this.buffer.length > MAX_RESPONSE_BYTES && !this.buffer.includes(0x0a)) {
            this.fail(protocolFailure("line", "tmux control line exceeds bounds"));
            return;
        }
        while (true) {
            const lf = this.buffer.indexOf(0x0a);
            if (lf < 0)
                break;
            const bytes = this.buffer.subarray(0, lf);
            this.buffer = this.buffer.subarray(lf + 1);
            let line;
            try {
                line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            }
            catch {
                this.fail(protocolFailure("utf8", "tmux control output is not UTF-8"));
                return;
            }
            let parsed;
            try {
                parsed = this.parser.consume(line);
            }
            catch (error) {
                this.fail(error);
                return;
            }
            if (!parsed || parsed.kind === "output")
                continue;
            if (parsed.kind === "notification") {
                if (parsed.notification.name === "%exit") {
                    this.fail(new TmuxControlError("TMUX_EXIT", "tmux control client received an exit notification"));
                    return;
                }
                transportMetrics.notifications += 1;
                this.notificationGeneration += 1;
                this.lastNotificationTimestamp = Date.now();
                this.settleNotificationWaiters("notification");
                try {
                    this.options.onNotification?.(parsed.notification);
                }
                catch { /* observer only */ }
                continue;
            }
            if (this.startupResolve) {
                const resolve = this.startupResolve;
                const reject = this.startupReject;
                this.startupResolve = null;
                this.startupReject = null;
                if (parsed.ok)
                    resolve();
                else
                    reject?.(new TmuxControlError("TMUX_START", "tmux control attach failed"));
                continue;
            }
            const item = this.active;
            if (!item) {
                const category = parsed.ok
                    ? (parsed.lines.length === 0 ? "uncorrelated-ok-empty" : "uncorrelated-ok-nonempty")
                    : (parsed.lines.length === 0 ? "uncorrelated-error-empty" : "uncorrelated-error-nonempty");
                this.fail(protocolFailure(category, "uncorrelated tmux response"));
                return;
            }
            const blockBytes = parsed.lines.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
            if (item.responseLines + parsed.lines.length > MAX_RESPONSE_LINES || item.responseBytes + blockBytes > MAX_RESPONSE_BYTES) {
                this.failItem(item, protocolFailure("parser-framing", "tmux aggregate response exceeds bounds"));
                return;
            }
            if (!parsed.ok) {
                // A top-level if-shell error never schedules a nested command;
                // settle it now rather than waiting for a response that cannot arrive.
                this.active = null;
                if (item.timer)
                    clearTimeout(item.timer);
                item.reject(item.mutation ? new TmuxControlUnknownOutcomeError(item.name) : new TmuxControlError("TMUX_COMMAND", `${item.name} failed`));
                this.dispatch();
                continue;
            }
            item.responses += 1;
            item.responseLines += parsed.lines.length;
            item.responseBytes += blockBytes;
            item.lines.push(...parsed.lines);
            // Keep the original deadline running across both if-shell blocks.
            if (item.responses < item.expectedResponses)
                continue;
            this.active = null;
            if (item.timer)
                clearTimeout(item.timer);
            item.resolve(item.lines);
            this.dispatch();
        }
    }
    failItem(item, error) {
        if (this.active !== item)
            return;
        this.active = null;
        if (item.timer)
            clearTimeout(item.timer);
        if (item.mutation && item.written) { recordPhase0LiveTelemetry("tmux", "unknownOutcomes"); item.reject(new TmuxControlUnknownOutcomeError(item.name, error)); } else item.reject(error);
        this.fail(error);
    }
    fail(error) {
        if (this.closed)
            return;
        this.closed = true;
        transportMetrics.clientsClosed += 1;
        try {
            this.parser.finish();
        }
        catch (parserError) {
            error = parserError;
        }
        // The signed live artifact receives only a fixed category, never tmux
        // output, command text, or a process error's message.
        recordPhase0LiveTelemetry("tmux", "controlDisconnects", 1, disconnectReason(error));
        this.startupReject?.(error);
        this.startupResolve = null;
        this.startupReject = null;
        const active = this.active;
        this.active = null;
        if (active) {
            if (active.timer)
                clearTimeout(active.timer);
            if (active.mutation && active.written) { recordPhase0LiveTelemetry("tmux", "unknownOutcomes"); active.reject(new TmuxControlUnknownOutcomeError(active.name, error)); } else active.reject(error);
        }
        for (const item of this.queue.splice(0))
            item.reject(error);
        this.notificationGeneration += 1;
        this.settleNotificationWaiters("disconnect");
        this.process?.kill("SIGTERM");
        this.process = null;
        try {
            this.options.onDisconnect?.(disconnectDetail(error));
        }
        catch { /* observer only */ }
    }
    close() { this.fail(new TmuxControlError("TMUX_CLOSED", "tmux control client closed")); }
}
