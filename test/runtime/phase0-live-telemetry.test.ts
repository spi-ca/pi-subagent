import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { closePhase0LiveTelemetryForTest, PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV, PHASE0_LIVE_TELEMETRY_DIR_ENV, recordPhase0LiveTelemetry } from "../../src/runtime/phase0-live-telemetry.mjs";

const roots: string[] = [];
afterEach(async () => { closePhase0LiveTelemetryForTest(); delete process.env[PHASE0_LIVE_TELEMETRY_DIR_ENV]; delete process.env[PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV]; delete process.env.PI_SUBAGENT_PHASE0_LIVE; while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true }); });

async function privateRoot(): Promise<string> { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "phase0-telemetry-"))); await fs.chmod(root, 0o700); roots.push(root); return root; }

describe("Phase 0 live transport telemetry", () => {
  test("requires the explicit gate, canonical 0700 root, and 64-hex capability", async () => {
    const root = await privateRoot();
    process.env[PHASE0_LIVE_TELEMETRY_DIR_ENV] = root; process.env[PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV] = "a".repeat(64);
    assert.equal(recordPhase0LiveTelemetry("tmux", "backendRequests"), false);
    closePhase0LiveTelemetryForTest(); process.env.PI_SUBAGENT_PHASE0_LIVE = "1"; process.env[PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV] = "bad";
    assert.equal(recordPhase0LiveTelemetry("tmux", "backendRequests"), false);
    closePhase0LiveTelemetryForTest(); process.env[PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV] = "a".repeat(64); await fs.chmod(root, 0o755);
    assert.equal(recordPhase0LiveTelemetry("tmux", "backendRequests"), false);
  });

  test("writes bounded exclusive 0600 signed NDJSON without the capability", async () => {
    const root = await privateRoot(), capability = "b".repeat(64);
    process.env.PI_SUBAGENT_PHASE0_LIVE = "1"; process.env[PHASE0_LIVE_TELEMETRY_DIR_ENV] = root; process.env[PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV] = capability;
    assert.equal(recordPhase0LiveTelemetry("cmux", "backendRequests"), true);
    assert.equal(recordPhase0LiveTelemetry("cmux", "exactSnapshots", 1, "tree"), true);
    assert.equal(recordPhase0LiveTelemetry("cmux", "backendRequests", -1), false);
    closePhase0LiveTelemetryForTest();
    const names = await fs.readdir(root); assert.equal(names.length, 1);
    const file = path.join(root, names[0]!); assert.equal((await fs.lstat(file)).mode & 0o777, 0o600);
    const [line] = (await fs.readFile(file, "utf8")).trim().split("\n"), event = JSON.parse(line!);
    assert.equal(JSON.stringify(event).includes(capability), false);
    const payload = JSON.stringify({ version: 1, type: "counter", pid: process.pid, backend: "cmux", metric: "backendRequests", value: 1 });
    assert.equal(event.tag, crypto.createHmac("sha256", Buffer.from(capability, "hex")).update(payload).digest("hex"));
  });
});
