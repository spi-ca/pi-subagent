import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TmuxControlClient, tmuxCommand, type TmuxControlDisconnectDetail } from "../../src/runtime/tmux-control";

const gate = "PI_SUBAGENT_TMUX_CONTROL_STRESS_PROBE";
const sessionName = "pi-subagent-control-stress";

if (process.env[gate] !== "1") {
	console.log(JSON.stringify({ mode: "tmux-control-stress-probe", state: "not-run", reason: `${gate}=1 required`, mutation: "none" }));
	process.exit(0);
}

/** Runs setup/teardown without ever publishing tmux stdout or stderr. */
async function tmux(args: string[], readStdout = false): Promise<string> {
	return await new Promise((resolve, reject) => {
		const child = spawn("tmux", args, { stdio: ["ignore", "pipe", "ignore"] });
		const output: Buffer[] = [];
		let bytes = 0;
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 4096) { child.kill("SIGTERM"); reject(new Error("tmux stress setup output exceeded bounds")); return; }
			if (readStdout) output.push(chunk);
		});
		child.once("error", () => reject(new Error("tmux stress setup could not start")));
		child.once("exit", (code) => {
			if (code !== 0) { reject(new Error("tmux stress setup command failed")); return; }
			resolve(readStdout ? Buffer.concat(output).toString("utf8") : "");
		});
	});
}

let root: string | null = null;
let socketPath: string | null = null;
let client: TmuxControlClient | null = null;
let disconnect: TmuxControlDisconnectDetail | null = null;
try {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-control-"));
	await fs.chmod(root, 0o700);
	socketPath = path.join(root, "socket");
	if (Buffer.byteLength(socketPath) >= 100) throw new Error("tmux stress socket path is too long");

	await tmux(["-S", socketPath, "new-session", "-d", "-s", sessionName, "sleep 120"]);
	const sessionId = (await tmux(["-S", socketPath, "display-message", "-p", "-t", sessionName, "#{session_id}"], true)).trim();
	if (!/^\$[0-9]+$/.test(sessionId)) throw new Error("tmux stress session identity was invalid");

	client = new TmuxControlClient({
		executable: "tmux",
		socketPath,
		sessionId,
		onDisconnect: (detail) => { disconnect = detail; },
	});
	await client.start();

	// Mutations are issued exactly once. A disconnect rejects them as unknown;
	// this probe intentionally performs no retry or replay.
	const windows = Promise.all(Array.from({ length: 16 }, async () => {
		const [windowId] = await client!.execute(tmuxCommand("new-window", ["-d", "-t", sessionId, "-P", "-F", "#{window_id}", "sleep 120"]), { name: "new-window", mutation: true });
		if (!/^@[0-9]+$/.test(windowId ?? "")) throw new Error("tmux stress window identity was invalid");
		await client!.execute(tmuxCommand("kill-window", ["-t", windowId!]), { name: "kill-window", mutation: true, reserved: true });
	}));
	const reads = (async () => {
		for (let index = 0; index < 100; index += 1) {
			if (index % 2 === 0) await client!.execute(tmuxCommand("list-panes", ["-a", "-F", "#{pane_id}"]), { name: "list-panes" });
			else await client!.execute(tmuxCommand("display-message", ["-p", "-t", sessionId, "#{session_id}"]), { name: "display-message" });
		}
	})();
	await Promise.all([windows, reads]);
	client.close();
	client = null;
	console.log(JSON.stringify({
		mode: "tmux-control-stress-probe",
		state: "pass",
		privateServer: true,
		clients: 1,
		outputSuppressed: true,
		createdAndKilledDetachedWindows: 16,
		serializedReads: 100,
		disconnect,
	}));
} catch {
	if (client) client.close();
	console.log(JSON.stringify({ mode: "tmux-control-stress-probe", state: "failed", reason: "tmux-control-stress-failed", disconnect }));
	process.exitCode = 1;
} finally {
	if (socketPath) await tmux(["-S", socketPath, "kill-server"]).catch(() => undefined);
	if (root) await fs.rm(root, { recursive: true, force: true });
}
