import { spawn } from "node:child_process";
export interface TmuxControlMetrics {
    clientsSpawned: number;
    clientsClosed: number;
    commandsDispatched: number;
    notifications: number;
    commandNames: Record<string, number>;
}
export declare function resetTmuxControlMetrics(): void;
export declare function snapshotTmuxControlMetrics(): TmuxControlMetrics;
export type TmuxControlDisconnectCategory = "timeout" | "exit" | "closed" | "other" | "uncorrelated-ok-empty" | "uncorrelated-ok-nonempty" | "uncorrelated-error-empty" | "uncorrelated-error-nonempty" | "parser-framing" | "chunk" | "line" | "utf8";
export interface TmuxControlDisconnectDetail {
    /** A package-defined error code, never a process or tmux output message. */
    readonly code: string;
    /** A fixed internal failure-site category, never raw tmux output. */
    readonly category: TmuxControlDisconnectCategory;
}
export declare class TmuxControlError extends Error {
    readonly code: string;
    readonly disconnectCategory?: TmuxControlDisconnectCategory;
    constructor(code: string, message: string, disconnectCategory?: TmuxControlDisconnectCategory);
}
export declare class TmuxControlUnknownOutcomeError extends TmuxControlError {
    readonly commandName: string;
    constructor(commandName: string, cause?: unknown);
}
/** Encode exactly one tmux command-language token without shell evaluation. */
export declare function encodeTmuxToken(value: string): string;
export declare function tmuxCommand(name: string, args: string[]): string;
export interface TmuxControlNotification {
    name: string;
    line: string;
    resync: boolean;
}
export type TmuxParsedControlItem = {
    kind: "response";
    ok: boolean;
    lines: string[];
} | {
    kind: "notification";
    notification: TmuxControlNotification;
} | {
    kind: "output";
};
/** Stateful strict parser for the tmux control-mode format pinned to the 3.7b baseline. */
export declare class TmuxControlParser {
    private block;
    consume(line: string): TmuxParsedControlItem | null;
    finish(): void;
}
export interface TmuxControlCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    aborted: boolean;
    dispatched?: boolean;
}
/** Translate only this package's argv vocabulary to serialized tmux command text. */
export declare function createTmuxControlCommandRunner(client: TmuxControlClient, expectedSocketPath: string): (args: string[], options?: {
    signal?: AbortSignal;
}) => Promise<TmuxControlCommandResult>;
export interface TmuxControlClientOptions {
    executable: string;
    socketPath: string;
    sessionId: string;
    /** @deprecated Shared fallback for both deadlines; use the dedicated options. */
    timeoutMs?: number;
    /** Attach/startup deadline. Defaults to 5 seconds; values are bounded to 30 seconds. */
    startupTimeoutMs?: number;
    /** Per-command deadline. Defaults to 5 seconds; values are bounded to 30 seconds. */
    commandTimeoutMs?: number;
    onNotification?: (notification: TmuxControlNotification) => void;
    /** Receives sanitized static detail only; tmux output and process error text are never exposed. */
    onDisconnect?: (detail: TmuxControlDisconnectDetail) => void;
    spawnProcess?: typeof spawn;
}
/** One supervised serialized `tmux -C` process for one socket/session generation. */
export declare class TmuxControlClient {
    private readonly options;
    private process;
    private readonly parser;
    private readonly queue;
    private active;
    private buffer;
    private startupResolve;
    private startupReject;
    private notificationWaiters;
    private notificationGeneration;
    private closed;
    constructor(options: TmuxControlClientOptions);
    start(): Promise<void>;
    processId(): number | null;
    notificationSequence(): number;
    lastNotificationAt(): number | null;
    waitForNotification(timeoutMs: number): Promise<"notification" | "timeout" | "disconnect">;
    private settleNotificationWaiters;
    execute(line: string, options?: {
        name?: string;
        mutation?: boolean;
        reserved?: boolean;
        /** Number of successful tmux response blocks required for this command (validated to 1 or 2). */
        expectedResponses?: number;
    }): Promise<string[]>;
    private dispatch;
    private onData;
    private failItem;
    private fail;
    close(): void;
}
