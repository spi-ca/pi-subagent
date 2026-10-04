import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { verifyPiGraph } from "../../.github/scripts/verify-pi-graph.ts";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PI_CORE_DEPENDENCIES = {
  "@earendil-works/pi-agent-core": "1.0.2",
  "@earendil-works/pi-ai": "1.0.2",
  "@earendil-works/pi-coding-agent": "1.0.2",
  "@earendil-works/pi-tui": "1.0.2",
} as const;
const PI_GRAPH_PACKAGE_NAME = /^@earendil-works\/(?:pi-[a-z0-9][a-z0-9._-]*|chord)$/;
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CLEAN_CHECKOUT_DEV_DEPENDENCIES = { typebox: "1.1.38" } as const;
const PRESENCE_RELEASE_TAG = "v2-20261004-1";
const PRESENCE_TAG_OBJECT = "054ae6a14296b24ebe811bba0eea6b4cd81ea332";
const PRESENCE_RELEASE_COMMIT = "78256300e166b40e7a627c321fa0eb9a9e4e2b89";
const PRESENCE_DEPENDENCY = `github:spi-ca/pi-presence#${PRESENCE_RELEASE_TAG}`;
const PRESENCE_LOCK_RESOLUTION = PRESENCE_TAG_OBJECT.slice(0, 7);

function selectedPiCoreDependencies(raw = process.env.PI_GRAPH_EXPECTED): Record<keyof typeof PI_CORE_DEPENDENCIES, string> {
  if (raw === undefined) return { ...PI_CORE_DEPENDENCIES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PI_GRAPH_EXPECTED must be a JSON package/version map");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("PI_GRAPH_EXPECTED must be a JSON package/version map");
  }
  const graph = parsed as Record<string, unknown>;
  for (const [name, version] of Object.entries(graph)) {
    if (!PI_GRAPH_PACKAGE_NAME.test(name) || typeof version !== "string" || !EXACT_VERSION.test(version)) {
      throw new Error(`PI_GRAPH_EXPECTED has an invalid Pi graph entry: ${name}@${String(version)}`);
    }
  }
  const expected = {} as Record<keyof typeof PI_CORE_DEPENDENCIES, string>;
  for (const packageName of Object.keys(PI_CORE_DEPENDENCIES) as Array<keyof typeof PI_CORE_DEPENDENCIES>) {
    const version = graph[packageName];
    if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
      throw new Error(`PI_GRAPH_EXPECTED must provide an exact version for ${packageName}`);
    }
    expected[packageName] = version;
  }
  return expected;
}

function packedPaths(): string[] {
  const result = spawnSync(process.execPath, ["pm", "pack", "--dry-run", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output);
  return [...output.matchAll(/^packed\s+\S+\s+(.+)$/gm)].map((match) => match[1]!);
}

describe("release packaging and live acceptance workflow", () => {
  test("uses the selected Pi graph for manifest and installed peer packages while keeping the lock baseline", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    const lockfile = fs.readFileSync(path.join(ROOT, "bun.lock"), "utf8");
    const selectedPiDependencies = selectedPiCoreDependencies();
    const tsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, "tsconfig.json"), "utf8")) as {
      compilerOptions: { paths?: unknown };
    };

    assert.equal(tsconfig.compilerOptions.paths, undefined, "typechecking must not require a sibling Pi checkout");
    assert.equal(manifest.dependencies["@pi/presence"], PRESENCE_DEPENDENCY, "@pi/presence must use the reviewed immutable release tag");
    assert.match(lockfile, new RegExp(`"@pi/presence": "${PRESENCE_DEPENDENCY}"`), "bun.lock must retain the reviewed immutable release tag");
    assert.notEqual(PRESENCE_TAG_OBJECT, PRESENCE_RELEASE_COMMIT, "the annotated tag object and its peeled release commit must remain distinct");
    assert.match(
      lockfile,
      new RegExp(`"@pi/presence": \\["@pi/presence@github:spi-ca/pi-presence#${PRESENCE_LOCK_RESOLUTION}"`),
      "bun.lock must resolve @pi/presence to the reviewed annotated tag object",
    );
    assert.doesNotMatch(
      lockfile,
      new RegExp(`"@pi/presence": \\["@pi/presence@github:spi-ca/pi-presence#${PRESENCE_RELEASE_COMMIT.slice(0, 7)}"`),
      "Bun must record the annotated tag object rather than the peeled release commit",
    );
    for (const [packageName, version] of Object.entries(selectedPiDependencies)) {
      assert.equal(manifest.peerDependencies[packageName], "*", `${packageName} must accept all Pi core versions`);
      assert.equal(manifest.devDependencies[packageName], version, `${packageName} must use the selected exact Pi graph version`);

      const packageJsonPath = path.join(ROOT, "node_modules", ...packageName.split("/"), "package.json");
      const installedManifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version: string };
      assert.equal(installedManifest.version, version, `${packageName} must install the selected exact Pi graph version`);
      assert.ok(fs.existsSync(fileURLToPath(import.meta.resolve(packageName))), `${packageName} must resolve after install`);
    }
    for (const [packageName, version] of Object.entries(PI_CORE_DEPENDENCIES)) {
      assert.ok(
        lockfile.includes(`\"${packageName}\": [\"${packageName}@${version}\"`),
        `bun.lock must retain clean-checkout baseline ${packageName}@${version}`,
      );
    }
    for (const [packageName, version] of Object.entries(CLEAN_CHECKOUT_DEV_DEPENDENCIES)) {
      assert.equal(manifest.devDependencies[packageName], version, `${packageName} must be exactly pinned for clean checkouts`);
      assert.ok(
        lockfile.includes(`\"${packageName}\": [\"${packageName}@${version}\"`),
        `bun.lock must resolve ${packageName}@${version}`,
      );
      assert.match(import.meta.resolve(packageName), /node_modules\//, `${packageName} must resolve after bun install --frozen-lockfile`);
    }
  });

  test("rejects malformed selected Pi graph input instead of falling back to the baseline", () => {
    assert.throws(() => selectedPiCoreDependencies("not-json"), /PI_GRAPH_EXPECTED must be a JSON package\/version map/);
    assert.throws(() => selectedPiCoreDependencies("{}"), /must provide an exact version for @earendil-works\/pi-agent-core/);
    assert.throws(
      () => selectedPiCoreDependencies('{"@earendil-works/pi-agent-core":"1.0.2","@earendil-works/pi-ai":"1.0.2","@earendil-works/pi-coding-agent":"1.0.2","@earendil-works/pi-tui":"latest"}'),
      /invalid Pi graph entry/,
    );
  });

  test("CI selects the eight-package 1.0.2 runtime graph including chord, never obsolete client/protocol", () => {
    const names = [...["agent-core", "ai", "codemode", "coding-agent", "mcp", "telemetry", "tui"].map((name) => `@earendil-works/pi-${name}`), "@earendil-works/chord"].sort();
    const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const graphs = [...workflow.matchAll(/pi-graph: '([^']+)'/g)].map((match) => JSON.parse(match[1]!));
    assert.equal(graphs.length, 8);
    for (const graph of graphs) {
      assert.deepEqual(Object.keys(graph).sort(), names);
      assert.ok(Object.values(graph).every((version) => version === "1.0.2"));
    }
    const lockfile = fs.readFileSync(path.join(ROOT, "bun.lock"), "utf8");
    for (const name of names) assert.ok(lockfile.includes(`"${name}@1.0.2"`), `${name} must be resolved in the published graph`);
    for (const suffix of ["client", "protocol"]) {
      assert.equal(workflow.includes(`@earendil-works/pi-${suffix}`), false);
      assert.equal(lockfile.includes(`@earendil-works/pi-${suffix}`), false);
    }
  });

  test("CI compatibility install validates chord and replaces obsolete development graph entries", () => {
    const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const graph = workflow.match(/pi-graph: '([^']+)'/)?.[1];
    const script = workflow.match(/          bun -e '\n([\s\S]*?)\n          '/)?.[1];
    assert.ok(graph && script, "CI compatibility graph and install script must be present");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-install-"));
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { "@earendil-works/pi-client": "old", "@earendil-works/pi-protocol": "old", "@earendil-works/chord": "old", typebox: "1.1.38" } }));
      const result = spawnSync(process.execPath, ["-e", script], { cwd: root, env: { ...process.env, PI_GRAPH_EXPECTED: graph }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      assert.deepEqual(manifest.devDependencies, { typebox: "1.1.38", ...JSON.parse(graph) });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test("selected graph accepts chord but rejects a mismatched installed chord version", () => {
    const expected = { ...PI_CORE_DEPENDENCIES, "@earendil-works/chord": "1.0.2" };
    assert.deepEqual(selectedPiCoreDependencies(JSON.stringify(expected)), PI_CORE_DEPENDENCIES);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-release-chord-"));
    try {
      for (const [name, version] of Object.entries(expected)) {
        const directory = path.join(root, ...name.split("/"));
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version }));
      }
      verifyPiGraph(root, expected, Object.keys(expected));
      fs.writeFileSync(path.join(root, "@earendil-works/chord/package.json"), JSON.stringify({ name: "@earendil-works/chord", version: "1.0.1" }));
      assert.throws(() => verifyPiGraph(root, expected, Object.keys(expected)), /chord: expected only 1\.0\.2, installed 1\.0\.1/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test("packages required docs and schemas without Finder or dot metadata", () => {
    const npmignore = fs.readFileSync(path.join(ROOT, ".npmignore"), "utf8");
    assert.match(npmignore, /^\*\*\/\.DS_Store$/m);
    assert.match(npmignore, /^\*\*\/\._\*$/m);
    const paths = packedPaths();
    assert.ok(paths.length > 0, "bun pack dry-run did not report packaged files");
    for (const entry of paths) assert.doesNotMatch(entry, /(^|\/)\./, `dot metadata was packaged: ${entry}`);
    for (const required of [
      "pi-subagent.schema.json",
      "pi-subagent.detached-ownership.schema.json",
      "README.md",
      "docs/configuration.md",
      "docs/diagram/performance-phase-map.svg",
    ]) assert.ok(paths.includes(required), `required package file is missing: ${required}`);
  });

  test("pins live-acceptance actions to reviewed immutable commits", () => {
    const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/live-acceptance.yml"), "utf8");
    const actionUses = [...workflow.matchAll(/^\s*- uses: (?<action>[^@\s]+)@(?<ref>[^\s#]+)(?:\s+# (?<version>[^\r\n]+))?$/gm)];
    const expectedActions = [
      { action: "actions/checkout", ref: "11bd71901bbe5b1630ceea73d27597364c9af683", version: "v4.2.2" },
      { action: "oven-sh/setup-bun", ref: "735343b667d3e6f658f44d0eca948eb6282f2b76", version: "v2.0.2" },
    ];

    assert.equal(actionUses.length, 4, "every workflow action use must be an explicitly reviewed pin");
    for (const actionUse of actionUses) {
      assert.match(actionUse.groups?.ref ?? "", /^[0-9a-f]{40}$/, "workflow action refs must not be tags");
    }
    for (const expected of expectedActions) {
      const uses = actionUses.filter((actionUse) => actionUse.groups?.action === expected.action);
      assert.equal(uses.length, 2, `${expected.action} must be used by both live jobs`);
      for (const use of uses) {
        assert.equal(use.groups?.ref, expected.ref);
        assert.equal(use.groups?.version, expected.version);
      }
    }

    assert.equal(
      [...workflow.matchAll(/- uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\.2\.2\n\s+with:\n\s+fetch-depth: 0\n\s+persist-credentials: false/g)].length,
      2,
      "checkout must fetch full history without persisting GitHub credentials",
    );
  });

  test("builds and asserts the pinned stable tmux release before live acceptance", () => {
    const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/live-acceptance.yml"), "utf8");
    assert.match(workflow, /TMUX_VERSION: 3\.7b/);
    assert.match(workflow, /TMUX_SHA256: 87f2e99e3b685973f2ca002ffd6ed7e51a5744f7009daae5a15670b6d532db96/);
    assert.match(workflow, /https:\/\/github\.com\/tmux\/tmux\/releases\/download\/\$\{TMUX_VERSION\}\/\$\{archive\}/);
    assert.match(workflow, /sha256sum --check --strict/);
    assert.doesNotMatch(workflow, /apt-get install[^\n]*\btmux\b/);
    assert.match(workflow, /test "\$\(tmux -V\)" = "tmux 3\.7b"/);
    assert.ok(workflow.indexOf("Assert pinned tmux stable minimum") < workflow.indexOf("Live tmux title smoke"));
  });
});
