// Bun implements module mocks but this project's Node-only test types omit it.
// @ts-expect-error Bun runtime export is intentionally absent from @types/node.
import { describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// The local Pi package's .d.ts files retain source .ts specifiers, which Bun's
// test resolver cannot execute. Discovery only needs this parser contract here.
mock.module("@earendil-works/pi-coding-agent", () => ({
  getMarkdownTheme: () => ({}),
  parseFrontmatter: <T>(content: string): { frontmatter: T; body: string } => {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match || /\[[^\]\n]*$/m.test(match[1]!)) throw new Error("invalid frontmatter");
    const frontmatter = Object.fromEntries(
      match[1]!.split("\n").filter(Boolean).map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      }),
    ) as T;
    return { frontmatter, body: match[2] ?? "" };
  },
}));
const { AgentDiscoveryCache } = await import("../../src/core/agent-discovery-cache");

const AGENT_HEADER = "---\nname: project-worker\ndescription: project worker\n---\n";

async function fixture() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-discovery-cache-"));
  const configDir = path.join(tempDir, "config");
  const projectRoot = path.join(tempDir, "project");
  const agentsDir = path.join(projectRoot, ".pi", "agents");
  const cwd = path.join(projectRoot, "packages", "app");
  await fs.mkdir(path.join(configDir, "agents"), { recursive: true });
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(configDir, "agents", "user.md"), "---\nname: user\ndescription: user\n---\nUser body\n");
  await fs.writeFile(path.join(agentsDir, "worker.md"), `${AGENT_HEADER}Trusted body\n`);
  return { tempDir, configDir, projectRoot, agentsDir, cwd };
}

async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
  const value = await fixture();
  process.env.PI_CODING_AGENT_DIR = value.configDir;
  try {
    await run(value);
  } finally {
    if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
    await fs.rm(value.tempDir, { recursive: true, force: true });
  }
}

interface TestAgent {
  name: string;
  description: string;
  systemPrompt: string;
  filePath: string;
}

interface CacheInstance {
  startSession(): void;
  discover(cwd: string, scope: string, options?: Record<string, unknown>): { agents: TestAgent[]; projectAgentsDir: string | null };
  snapshot(): { generation: number; entries: number; hits: number; misses: number; fetches: number };
}

function trusted(cache: CacheInstance, cwd: string, root: string) {
  return cache.discover(cwd, "both", {
    trustedProjectRoot: root,
    sessionTrustedProjectRoots: [root],
  });
}

describe("AgentDiscoveryCache", () => {
  test("returns an isolated repeated trusted-discovery cache hit", async () => {
    await withFixture(async ({ cwd, projectRoot }) => {
      const cache = new AgentDiscoveryCache();
      cache.startSession();
      const first = trusted(cache, cwd, projectRoot);
      first.agents[0]!.description = "mutated by caller";
      const second = trusted(cache, cwd, projectRoot);

      assert.equal(second.agents.find((agent) => agent.name === "project-worker")?.systemPrompt, "Trusted body\n");
      assert.equal(second.agents.some((agent) => agent.description === "mutated by caller"), false);
      assert.deepEqual(cache.snapshot(), { generation: 1, entries: 1, hits: 1, misses: 1, fetches: 1 });
    });
  });

  test("invalidates a hit when a candidate is replaced or modified", async () => {
    await withFixture(async ({ cwd, projectRoot, agentsDir }) => {
      const cache = new AgentDiscoveryCache();
      cache.startSession();
      trusted(cache, cwd, projectRoot);
      trusted(cache, cwd, projectRoot);
      await fs.writeFile(path.join(agentsDir, "worker.md"), `${AGENT_HEADER}Replacement body with a different size\n`);

      const changed = trusted(cache, cwd, projectRoot);
      assert.equal(changed.agents.find((agent) => agent.name === "project-worker")?.systemPrompt, "Replacement body with a different size\n");
      assert.deepEqual(cache.snapshot(), { generation: 1, entries: 1, hits: 1, misses: 2, fetches: 2 });
    });
  });

  test("does not surface or cache an untrusted project body", async () => {
    await withFixture(async ({ cwd, agentsDir }) => {
      const canary = "UNTRUSTED_PROJECT_BODY_CANARY";
      await fs.writeFile(path.join(agentsDir, "worker.md"), `${AGENT_HEADER}${canary}\n`);
      const cache = new AgentDiscoveryCache();
      cache.startSession();
      const first = cache.discover(cwd, "project", { metadataOnly: true });
      const second = cache.discover(cwd, "project", { metadataOnly: true });

      assert.equal(first.agents[0]?.name, "project-worker");
      assert.equal(first.agents[0]?.systemPrompt, "");
      assert.equal(second.agents[0]?.systemPrompt, "");
      assert.equal(JSON.stringify(second).includes(canary), false);
      assert.equal(cache.snapshot().fetches, 1);
      assert.equal(cache.snapshot().hits, 1);
    });
  });

  test("fails closed when a project-agent symlink is retargeted outside the trusted root", async () => {
    await withFixture(async ({ cwd, projectRoot, agentsDir, tempDir }) => {
      const cache = new AgentDiscoveryCache();
      const inside = path.join(projectRoot, "inside.md");
      const outside = path.join(tempDir, "outside.md");
      const linked = path.join(agentsDir, "worker.md");
      await fs.unlink(linked);
      await fs.writeFile(inside, `${AGENT_HEADER}Inside\n`);
      await fs.writeFile(outside, `${AGENT_HEADER}Outside\n`);
      await fs.symlink(inside, linked, "file");
      cache.startSession();
      assert.equal(trusted(cache, cwd, projectRoot).agents.some((agent) => agent.filePath === linked), true);
      await fs.unlink(linked);
      await fs.symlink(outside, linked, "file");

      const afterRetarget = trusted(cache, cwd, projectRoot);
      assert.equal(afterRetarget.agents.some((agent) => agent.name === "project-worker"), false);
      assert.equal(cache.snapshot().hits, 0);
    });
  });

  test("discards a project body when an intermediate agents-directory symlink swaps after manifest capture", async () => {
    await withFixture(async ({ cwd, projectRoot, agentsDir, tempDir }) => {
      const cache = new AgentDiscoveryCache();
      const original = path.join(projectRoot, "agents-original");
      const replacement = path.join(projectRoot, "agents-replacement");
      const link = path.join(projectRoot, ".pi", "agents-link");
      await fs.rename(agentsDir, original);
      await fs.mkdir(replacement, { recursive: true });
      await fs.writeFile(path.join(replacement, "worker.md"), `${AGENT_HEADER}Replacement\n`);
      await fs.symlink(original, link, "dir");
      await fs.rename(link, agentsDir);
      let swapped = false;
      const result = cache.discover(cwd, "project", {
        trustedProjectRoot: projectRoot,
        sessionTrustedProjectRoots: [projectRoot],
        beforeTrustedProjectRead: () => {
          if (swapped) return;
          swapped = true;
          // Rename swaps the intermediate .pi/agents link atomically after the
          // manifest, but before the trusted reader opens its resolved target.
          const next = path.join(tempDir, "next-agents-link");
          fsSync.symlinkSync(replacement, next, "dir");
          fsSync.renameSync(next, agentsDir);
        },
      });
      assert.equal(swapped, true);
      assert.equal(result.agents.some((agent) => agent.name === "project-worker"), false);
      assert.equal(cache.snapshot().entries, 0);
    });
  });

  test("does not reuse a full project body when only the exact-root proof changes", async () => {
    await withFixture(async ({ cwd, projectRoot, tempDir }) => {
      const cache = new AgentDiscoveryCache();
      cache.startSession();
      assert.equal(trusted(cache, cwd, projectRoot).agents.some((agent) => agent.name === "project-worker"), true);

      const differentProof = cache.discover(cwd, "both", {
        trustedProjectRoot: path.join(tempDir, "different-root-proof"),
        sessionTrustedProjectRoots: [projectRoot],
      });
      assert.equal(differentProof.agents.some((agent) => agent.name === "project-worker"), false);
      assert.deepEqual(cache.snapshot(), { generation: 1, entries: 2, hits: 0, misses: 2, fetches: 2 });
    });
  });

  test("changes trust context and lifecycle generation invalidate cache reuse", async () => {
    await withFixture(async ({ cwd, projectRoot }) => {
      const cache = new AgentDiscoveryCache();
      cache.startSession();
      assert.equal(trusted(cache, cwd, projectRoot).agents.some((agent) => agent.name === "project-worker"), true);
      const denied = cache.discover(cwd, "both", {
        trustedProjectRoot: projectRoot,
        sessionTrustedProjectRoots: [projectRoot],
        sessionDeniedProjectRoots: [projectRoot],
      });
      assert.equal(denied.agents.some((agent) => agent.name === "project-worker"), false);
      cache.startSession();
      trusted(cache, cwd, projectRoot);

      assert.equal(cache.snapshot().generation, 2);
      assert.equal(cache.snapshot().misses, 3);
      assert.equal(cache.snapshot().entries, 1);
    });
  });
});
