import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TmuxControlClient, tmuxCommand, type TmuxControlDisconnectDetail } from "../../src/runtime/tmux-control";
import { captureManagedChildPiExecutableGeneration, revalidateManagedChildPiExecutableGeneration, type ManagedChildPiExecutableGeneration } from "./managed-child-pi-executable";

const gate = "PI_SUBAGENT_TMUX_CONTROL_STRESS_PROBE";
const tmuxBinEnv = "TMUX_BIN";
const sessionName = "pi-subagent-control-stress";

if (process.env[gate] !== "1") {
	console.log(JSON.stringify({ mode: "tmux-control-stress-probe", state: "not-run", reason: `${gate}=1 required`, mutation: "none" }));
	process.exit(0);
}

/** The mutating probe never falls back from an explicit executable to PATH. */
function resolveTmuxBin(): ManagedChildPiExecutableGeneration {
	const requested = process.env[tmuxBinEnv]?.trim();
	if (!requested || !path.isAbsolute(requested)) throw new Error("tmux control stress probe requires an explicit absolute TMUX_BIN");
	return captureManagedChildPiExecutableGeneration(requested);
}

/** Runs setup/teardown without ever publishing tmux stdout or stderr. */
async function tmux(generation: ManagedChildPiExecutableGeneration, args: string[], readStdout = false): Promise<string> {
	return await new Promise((resolve, reject) => {
		// Revalidate at the last possible point before every direct tmux spawn.
		revalidateManagedChildPiExecutableGeneration(generation);
		const child = spawn(generation.executable, args, { stdio: ["ignore", "pipe", "ignore"] });
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
let tmuxGeneration: ManagedChildPiExecutableGeneration | null = null;
let client: TmuxControlClient | null = null;
let disconnect: TmuxControlDisconnectDetail | null = null;
try {
	tmuxGeneration = resolveTmuxBin();
	root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-control-"));
	await fs.chmod(root, 0o700);
	socketPath = path.join(root, "socket");
	if (Buffer.byteLength(socketPath) >= 100) throw new Error("tmux stress socket path is too long");

	await tmux(tmuxGeneration, ["-S", socketPath, "new-session", "-d", "-s", sessionName, "/bin/sleep", "120"]);
	const sessionId = (await tmux(tmuxGeneration, ["-S", socketPath, "display-message", "-p", "-t", sessionName, "#{session_id}"], true)).trim();
	if (!/^\$[0-9]+$/.test(sessionId)) throw new Error("tmux stress session identity was invalid");

	// Revalidate independently before opening the long-lived control client.
	revalidateManagedChildPiExecutableGeneration(tmuxGeneration);
	client = new TmuxControlClient({
		executable: tmuxGeneration.executable,
		socketPath,
		sessionId,
		onDisconnect: (detail) => { disconnect = detail; },
	});
	await client.start();

	// Mutations are issued exactly once. A disconnect rejects them as unknown;
	// this probe intentionally performs no retry or replay.
	const windows = Promise.all(Array.from({ length: 16 }, async () => {
		const [windowId] = await client!.execute(tmuxCommand("new-window", ["-d", "-t", sessionId, "-P", "-F", "#{window_id}", "/bin/sleep", "120"]), { name: "new-window", mutation: true });
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
	if (socketPath && tmuxGeneration) await tmux(tmuxGeneration, ["-S", socketPath, "kill-server"]).catch(() => undefined);
	if (root) await fs.rm(root, { recursive: true, force: true });
}
