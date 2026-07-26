import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLEAN_CHECKOUT_DEV_DEPENDENCIES = {
  "@earendil-works/pi-agent-core": "0.82.0",
  "@earendil-works/pi-ai": "0.82.0",
  "@earendil-works/pi-coding-agent": "0.82.0",
  "@earendil-works/pi-tui": "0.82.0",
  typebox: "1.1.38",
} as const;

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
  test("pins clean-checkout typecheck dependencies and resolves them from the lockfile", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
    };
    const lockfile = fs.readFileSync(path.join(ROOT, "bun.lock"), "utf8");
    const tsconfig = JSON.parse(fs.readFileSync(path.join(ROOT, "tsconfig.json"), "utf8")) as {
      compilerOptions: { paths?: unknown };
    };

    assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.80.10");
    assert.equal(tsconfig.compilerOptions.paths, undefined, "typechecking must not require a sibling Pi checkout");
    for (const [packageName, version] of Object.entries(CLEAN_CHECKOUT_DEV_DEPENDENCIES)) {
      assert.equal(manifest.devDependencies[packageName], version, `${packageName} must be exactly pinned for clean checkouts`);
      assert.ok(
        lockfile.includes(`\"${packageName}\": [\"${packageName}@${version}\"`),
        `bun.lock must resolve ${packageName}@${version}`,
      );
      assert.match(import.meta.resolve(packageName), /node_modules\//, `${packageName} must resolve after bun install --frozen-lockfile`);
    }
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
