import { getCmuxControlRequestManager } from "../../src/runtime/cmux-control-adapter.mjs";
import type { CmuxControlSocketClient } from "../../src/runtime/cmux-control-socket.mjs";

const gate = "PI_SUBAGENT_CMUX_CONTROL_PROBE";
if (process.env[gate] !== "1") {
	console.log(JSON.stringify({ mode: "cmux-control-probe", state: "not-run", reason: `${gate}=1 required`, mutation: "none" }));
	process.exit(0);
}

const manager = getCmuxControlRequestManager({ broker: true, env: process.env });
try {
	const handshake = await manager.ensureReady();
	await manager.call((client: CmuxControlSocketClient) => client.tree());
	console.log(JSON.stringify({
		mode: "cmux-control-probe",
		state: "production-read-only-gate-pass",
		phase1ProductionGate: true,
		mutation: "none",
		apiVersion: handshake.version,
		appVersion: handshake.detectedAppVersion,
		accessMode: handshake.access_mode,
	}));
} finally {
	manager.close();
}
