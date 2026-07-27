import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  LIVE_CMUX_PRESENCE_GATE,
  LIVE_CMUX_PRESENCE_TRUST,
  PRESENCE_ENV,
  PRESENCE_SNAPSHOT_FILES,
  parseCmuxListStatus,
  parseCmuxListStatusPresence,
  parsePresenceCmuxLiveArgs,
  replacePresenceEnv,
  requirePresenceCmuxLiveGate,
  requirePresenceCmuxPresenceTrust,
  runBoundedCmuxCommand,
  stageTrustedPresenceSnapshot,
} from "./presence-cmux-live";

const trustedStageEnv = { [LIVE_CMUX_PRESENCE_TRUST]: "1" };

type PresenceFixture = { parent: string; checkout: string; evidence: string };

async function createPresenceFixture(): Promise<PresenceFixture> {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.homedir(), ".pi-subagent-presence-stage-")));
  const checkout = path.join(parent, "pi-cmux-presence"), source = path.join(checkout, "src"), evidence = path.join(parent, "evidence");
  await fs.mkdir(source, { recursive: true, mode: 0o700 });
  await fs.mkdir(evidence, { mode: 0o700 });
  for (const relative of PRESENCE_SNAPSHOT_FILES) {
    const file = path.join(checkout, relative);
    await fs.writeFile(file, relative === "package.json" ? '{"name":"pi-cmux-presence"}\n' : "export {};\n", { mode: 0o600 });
    await fs.chmod(file, 0o600);
  }
  await Promise.all([parent, checkout, source, evidence].map((directory) => fs.chmod(directory, 0o700)));
  return { parent, checkout, evidence };
}

async function removePresenceFixture(fixture: PresenceFixture): Promise<void> {
  await fs.rm(fixture.parent, { recursive: true, force: true });
}

describe("cmux presence live acceptance safety guards", () => {
  test("accepts only the explicit non-mutating dry-run argument", () => {
    assert.deepEqual(parsePresenceCmuxLiveArgs([]), { dryRun: false });
    assert.deepEqual(parsePresenceCmuxLiveArgs(["--dry-run"]), { dryRun: true });
    assert.throws(() => parsePresenceCmuxLiveArgs(["--keep"]), /usage/);
    assert.throws(() => parsePresenceCmuxLiveArgs(["--dry-run", "extra"]), /usage/);
  });

  test("requires separate mutation and trusted-sibling import gates", () => {
    assert.throws(() => requirePresenceCmuxLiveGate({}), new RegExp(`${LIVE_CMUX_PRESENCE_GATE}=1`));
    assert.doesNotThrow(() => requirePresenceCmuxLiveGate({ [LIVE_CMUX_PRESENCE_GATE]: "1" }));
    assert.throws(() => requirePresenceCmuxPresenceTrust({}), new RegExp(`${LIVE_CMUX_PRESENCE_TRUST}=1`));
    assert.doesNotThrow(() => requirePresenceCmuxPresenceTrust({ [LIVE_CMUX_PRESENCE_TRUST]: "1" }));
  });

  test("restores every presence and consumer-profile environment key exactly", () => {
    const profileToggles = ["PI_CMUX_PROFILE", "PI_CMUX_NOTIFY_LEVEL", "PI_CMUX_SIDEBAR_FLASH"] as const;
    assert.equal(profileToggles.every((key) => PRESENCE_ENV.includes(key)), true);
    const env: NodeJS.ProcessEnv = Object.fromEntries(PRESENCE_ENV.flatMap((key, index) => index % 3 === 0 ? [] : [[key, `before-${index}`]]));
    const restore = replacePresenceEnv(Object.fromEntries(PRESENCE_ENV.map((key) => [key, `during-${key}`])), env);
    for (const key of PRESENCE_ENV) assert.equal(env[key], `during-${key}`);
    restore.restore();
    assert.deepEqual(restore.verifyRestored(), []);
    for (const [index, key] of PRESENCE_ENV.entries()) assert.equal(env[key], index % 3 === 0 ? undefined : `before-${index}`);
  });

  test("bounds timed-out and overflowing commands as unknown failures", async () => {
    const timeout = await runBoundedCmuxCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {}, { timeoutMs: 50 });
    assert.equal(timeout.code, 1);
    assert.equal(timeout.unknown, true);
    for (const program of ["process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)", "process.stderr.write('x'.repeat(4096)); setInterval(() => {}, 1000)"]) {
      const overflow = await runBoundedCmuxCommand(process.execPath, ["-e", program], {}, { timeoutMs: 1_000, maxStdoutBytes: 128, maxStderrBytes: 128 });
      assert.equal(overflow.code, 1);
      assert.equal(overflow.unknown, true);
    }
  });

  test("parses only complete unique list-status rows and never treats malformed output as absence", () => {
    const key = "pi-presence:0123456789abcdef";
    const valid = `${key}=Subagents: running · 1 active icon=play color=#2563eb priority=30\n`;
    assert.deepEqual(parseCmuxListStatus(valid)?.get(key), {
      label: "Subagents: running · 1 active", icon: "play", color: "#2563eb", priority: 30,
    });
    assert.equal(parseCmuxListStatusPresence(valid, key), "present");
    assert.equal(parseCmuxListStatusPresence("other=Idle icon=circle color=#808080 priority=10\n", key), "absent");
    for (const malformed of [
      valid.slice(0, -1),
      `${key}=bad\u0001 icon=play color=#2563eb priority=30\n`,
      `${key}=one icon=play color=#2563eb priority=30\n${key}=two icon=play color=#2563eb priority=30\n`,
      `${key}=one icon=play color=blue priority=30\n`,
    ]) {
      assert.equal(parseCmuxListStatus(malformed), null);
      assert.equal(parseCmuxListStatusPresence(malformed, key), "unknown");
    }
  });

  test("stages the complete reviewed sibling allowlist in a private snapshot", async () => {
    const fixture = await createPresenceFixture();
    try {
      const staged = await stageTrustedPresenceSnapshot(fixture.evidence, fixture.checkout, trustedStageEnv);
      assert.equal(path.dirname(staged.root), fixture.evidence);
      assert.equal(staged.manifest.fileCount, PRESENCE_SNAPSHOT_FILES.length);
      assert.deepEqual(staged.manifest.files.map((file) => file.path), [...PRESENCE_SNAPSHOT_FILES].sort());
      assert.match(staged.manifest.sha256, /^[a-f0-9]{64}$/);
      assert.equal((await fs.lstat(staged.root)).mode & 0o777, 0o700);
      for (const relative of PRESENCE_SNAPSHOT_FILES) {
        assert.equal(await fs.readFile(path.join(staged.root, relative), "utf8"), relative === "package.json" ? '{"name":"pi-cmux-presence"}\n' : "export {};\n");
        assert.equal((await fs.lstat(path.join(staged.root, relative))).mode & 0o777, 0o600);
      }
    } finally { await removePresenceFixture(fixture); }
  });

  test("rejects writable ancestors, unsafe files, symlinks, and allowlist drift before staging", async () => {
    const ancestor = await createPresenceFixture();
    try {
      await fs.chmod(ancestor.parent, 0o777);
      await assert.rejects(() => stageTrustedPresenceSnapshot(ancestor.evidence, ancestor.checkout, trustedStageEnv), /ancestor is not a trusted real directory/);
    } finally { await removePresenceFixture(ancestor); }

    const unsafeFile = await createPresenceFixture();
    try {
      await fs.chmod(path.join(unsafeFile.checkout, "src", "presence.ts"), 0o666);
      await assert.rejects(() => stageTrustedPresenceSnapshot(unsafeFile.evidence, unsafeFile.checkout, trustedStageEnv), /canonical file is unsafe or absent/);
    } finally { await removePresenceFixture(unsafeFile); }

    const drift = await createPresenceFixture();
    try {
      await fs.writeFile(path.join(drift.checkout, "src", "unexpected.ts"), "export {};\n", { mode: 0o600 });
      await assert.rejects(() => stageTrustedPresenceSnapshot(drift.evidence, drift.checkout, trustedStageEnv), /exact staged allowlist/);
    } finally { await removePresenceFixture(drift); }

    const missing = await createPresenceFixture();
    try {
      await fs.rm(path.join(missing.checkout, "src", "usage.ts"));
      await assert.rejects(() => stageTrustedPresenceSnapshot(missing.evidence, missing.checkout, trustedStageEnv), /exact staged allowlist/);
    } finally { await removePresenceFixture(missing); }

    if (process.platform !== "win32") {
      const symlink = await createPresenceFixture();
      try {
        const target = path.join(symlink.checkout, "src", "identity.ts");
        await fs.rm(target);
        await fs.symlink(path.join(symlink.checkout, "src", "client.ts"), target);
        await assert.rejects(() => stageTrustedPresenceSnapshot(symlink.evidence, symlink.checkout, trustedStageEnv), /exact staged allowlist/);
      } finally { await removePresenceFixture(symlink); }
    }
  });
});
