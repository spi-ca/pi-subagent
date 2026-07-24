import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV,
  MANAGED_CHILD_BASE_MINIMUM_PI_VERSION,
  MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION,
  captureManagedChildPiExecutableGeneration,
  resolveManagedChildAcceptancePiExecutable,
  resolveManagedChildAcceptancePiGeneration,
  resolveManagedChildLiveAcceptancePiExecutable,
  revalidateManagedChildPiExecutableGeneration,
} from "./managed-child-pi-executable.js";

const candidate = (directory: string) => path.resolve(directory, "pi");
const elfMagic = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

async function writeNativeFixture(executable: string, magic = elfMagic): Promise<void> {
  await fs.writeFile(executable, Buffer.concat([magic, Buffer.alloc(4)]), { mode: 0o700 });
  await fs.chmod(executable, 0o700);
}

function resolverFor(versions: Record<string, string | null>) {
  const probes: string[] = [];
  return {
    probes,
    canonicalizeCandidate: (value: string) => Object.hasOwn(versions, value) ? `/canonical${value}` : null,
    probePiVersion: (value: string) => {
      probes.push(value);
      const source = value.slice("/canonical".length);
      return versions[source] ?? null;
    },
  };
}

describe("managed-child acceptance Pi resolution", () => {
  test("selects the highest compatible stable canonical executable instead of PATH's first Pi", () => {
    const old = candidate("/path/local-bin");
    const installed = candidate("/path/installed-bin");
    const prerelease = candidate("/path/prerelease-bin");
    const seam = resolverFor({ [old]: "0.78.0", [installed]: "0.81.1", [prerelease]: null });
    assert.equal(resolveManagedChildAcceptancePiExecutable({
      pathValue: ["/path/local-bin", "/path/installed-bin", "/path/prerelease-bin"].join(path.delimiter),
      minimumVersion: MANAGED_CHILD_BASE_MINIMUM_PI_VERSION,
      ...seam,
    }), `/canonical${installed}`);
    assert.deepEqual(seam.probes, [`/canonical${old}`, `/canonical${installed}`, `/canonical${prerelease}`]);
  });

  test("does not scan candidates beyond the configured bounded PATH prefix", () => {
    const early = candidate("/path/early");
    const late = candidate("/path/late");
    const seam = resolverFor({ [early]: "0.78.0", [late]: "0.81.1" });
    assert.throws(() => resolveManagedChildAcceptancePiExecutable({
      pathValue: ["/path/early", "/path/ignored", "/path/late"].join(path.delimiter),
      minimumVersion: MANAGED_CHILD_BASE_MINIMUM_PI_VERSION,
      maxPathCandidates: 2,
      ...seam,
    }), /stable Pi >= 0\.80\.10/);
    assert.deepEqual(seam.probes, [`/canonical${early}`]);
  });

  test("enforces the stricter live usage minimum without exposing candidate paths", () => {
    const baseOnly = candidate("/private/base-only");
    const seam = resolverFor({ [baseOnly]: "0.81.0" });
    let captured: unknown;
    try {
      resolveManagedChildAcceptancePiExecutable({
        pathValue: "/private/base-only",
        minimumVersion: MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION,
        ...seam,
      });
    } catch (error) {
      captured = error;
    }
    assert.ok(captured instanceof Error);
    assert.match(captured.message, /stable Pi >= 0\.81\.1/);
    assert.doesNotMatch(captured.message, /private|canonical/);
  });

  test("base profile uses its explicit safe 0.80.10 executable generation instead of PATH selection", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-"));
    const executable = path.join(root, "pi");
    try {
      await fs.chmod(root, 0o700);
      await fs.writeFile(executable, "#!/bin/sh\nprintf '0.80.10\\n'\n", { mode: 0o700 });
      await fs.chmod(executable, 0o700);
      const generation = resolveManagedChildAcceptancePiGeneration({
        liveNested: false,
        executable,
        pathValue: "/path/whose/highest-pi-must-not-be-selected",
        baseMinimumVersion: MANAGED_CHILD_BASE_MINIMUM_PI_VERSION,
        liveMinimumVersion: MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION,
      });
      assert.equal(generation.executable, await fs.realpath(executable));
      revalidateManagedChildPiExecutableGeneration(generation);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("base profile rejects explicitly configured versions above the exact 0.80.10 compatibility lane", async () => {
    if (process.platform === "win32") return;
    for (const version of ["0.80.11", "0.81.1"]) {
      const root = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-"));
      const executable = path.join(root, "pi");
      try {
        await fs.chmod(root, 0o700);
        await fs.writeFile(executable, `#!/bin/sh\nprintf '${version}\\n'\n`, { mode: 0o700 });
        await fs.chmod(executable, 0o700);
        assert.throws(() => resolveManagedChildAcceptancePiGeneration({
          liveNested: false,
          executable,
          pathValue: "/path/which-explicit-base-mode-must-not-search",
          baseMinimumVersion: MANAGED_CHILD_BASE_MINIMUM_PI_VERSION,
          liveMinimumVersion: MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION,
        }), /exact stable Pi 0\.80\.10/);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  test("live profile keeps the exact native executable but requires 0.81.1", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-"));
    const executable = path.join(root, "pi");
    try {
      await fs.chmod(root, 0o700);
      await writeNativeFixture(executable);
      assert.throws(() => resolveManagedChildLiveAcceptancePiExecutable({
        executable,
        minimumVersion: MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION,
        probePiVersion: () => "0.80.10",
      }), /stable Pi >= 0\.81\.1/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("live profile accepts an explicitly configured supported native format", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-"));
    const magics = [
      elfMagic,
      Buffer.from([0xfe, 0xed, 0xfa, 0xce]), Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
      Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
      Buffer.from([0xca, 0xfe, 0xba, 0xbe]), Buffer.from([0xbe, 0xba, 0xfe, 0xca]),
      Buffer.from([0xca, 0xfe, 0xba, 0xbf]), Buffer.from([0xbf, 0xba, 0xfe, 0xca]),
    ];
    try {
      await fs.chmod(root, 0o700);
      for (const [index, magic] of magics.entries()) {
        const executable = path.join(root, `pi-${index}`);
        await writeNativeFixture(executable, magic);
        const generation = resolveManagedChildLiveAcceptancePiExecutable({
          executable,
          minimumVersion: MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION,
          probePiVersion: () => "0.81.2",
        });
        assert.equal(generation.executable, await fs.realpath(executable));
        assert.equal(generation.nativeExecutable, true);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("live mode requires the explicit absolute executable instead of scanning PATH", () => {
    assert.throws(() => resolveManagedChildLiveAcceptancePiExecutable({
      executable: "pi",
      minimumVersion: MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION,
      probePiVersion: () => {
        throw new Error("must not probe a relative candidate");
      },
    }), new RegExp(`explicit absolute ${MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV}`));
  });

  test("live rejects an env-shebang script before any version probe despite attacker PATH", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-"));
    const attackerBin = path.join(root, "attacker-bin");
    const executable = path.join(root, "pi");
    const previousPath = process.env.PATH;
    let probes = 0;
    try {
      await fs.chmod(root, 0o700);
      await fs.mkdir(attackerBin, { mode: 0o700 });
      await fs.writeFile(path.join(attackerBin, "node"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
      await fs.chmod(path.join(attackerBin, "node"), 0o700);
      await fs.writeFile(executable, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
      await fs.chmod(executable, 0o700);
      process.env.PATH = attackerBin;
      let failure: unknown;
      try {
        resolveManagedChildLiveAcceptancePiExecutable({
          executable,
          minimumVersion: MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION,
          probePiVersion: () => {
            probes += 1;
            return "0.81.2";
          },
        });
      } catch (error) {
        failure = error;
      }
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /safe canonical native executable/);
      assert.doesNotMatch(failure.message, /attacker-bin|managed-child-pi-/);
      assert.equal(probes, 0);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("live revalidation rejects a native generation replaced with a script", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-"));
    const executable = path.join(root, "pi");
    try {
      await fs.chmod(root, 0o700);
      await writeNativeFixture(executable);
      const generation = resolveManagedChildLiveAcceptancePiExecutable({
        executable,
        minimumVersion: MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION,
        probePiVersion: () => "0.81.2",
      });
      await fs.rm(executable);
      await fs.writeFile(executable, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
      await fs.chmod(executable, 0o700);
      assert.throws(() => revalidateManagedChildPiExecutableGeneration(generation), /generation changed before spawn/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a group/world-writable executable ancestor", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-"));
    const ancestor = path.join(root, "unsafe");
    const executable = path.join(ancestor, "pi");
    try {
      await fs.chmod(root, 0o700);
      await fs.mkdir(ancestor, { mode: 0o700 });
      await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await fs.chmod(executable, 0o700);
      await fs.chmod(ancestor, 0o777);
      assert.throws(() => captureManagedChildPiExecutableGeneration(executable), /safe canonical regular executable/);
    } finally {
      await fs.chmod(ancestor, 0o700).catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a replaced executable generation before spawn", async () => {
    if (process.platform === "win32") return;
    const root = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-"));
    const executable = path.join(root, "pi");
    try {
      await fs.chmod(root, 0o700);
      await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await fs.chmod(executable, 0o700);
      const generation = captureManagedChildPiExecutableGeneration(executable);
      await fs.rm(executable);
      await fs.writeFile(executable, "#!/bin/sh\nexit 0\n# replacement\n", { mode: 0o700 });
      await fs.chmod(executable, 0o700);
      assert.throws(() => revalidateManagedChildPiExecutableGeneration(generation), /generation changed before spawn/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
