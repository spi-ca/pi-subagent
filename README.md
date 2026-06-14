# Pi Subagent

**Delegate tasks to specialized subagents with configurable context modes (`spawn` / `fork`) and environment-selected execution surfaces.**

There are many subagent extensions for pi, this one is mine.

## Why Pi Subagent

**Specialization** — Use tailored agents for specific tasks like refactoring, documentation, or research.

**Context Control** — Choose `spawn` (fresh context) or `fork` (inherit current session context), depending on the task.

**Execution Surface Auto-Selection** — Use `zellij-pane` inside Zellij and `inline` elsewhere automatically, while keeping structured progress in the parent TUI.

**Parallel Execution** — Run multiple independent agents at once.

**Chain Execution** — Run dependent stages sequentially, automatically passing previous stage summaries to later stages. Chain stages can be sequential agent steps or parallel groups.

**Local Editable Fork** — This local package keeps the simple delegation model while adding chain and parallel workflows for day-to-day Pi orchestration.

## Install

This checkout is intended to be used as a **local editable Pi package**. Add the package directory to the user-level Pi settings file (`~/.pi/agent/settings.json` by default):

```json
{
  "packages": [
    {
      "source": "~/.pi/agent/local-packages/pi-subagent",
      "extensions": ["+index.ts"]
    }
  ]
}
```

Use the actual checkout path for `source`; this repository is private/local and is not meant to be published to npm.

For local development:

```bash
cd ~/.pi/agent/local-packages/pi-subagent
bun install
bun run ci
```

Pi loads local package directories directly; no npm publish step is required.

### Development Assumptions

This package is developed inside an existing Pi installation. Type checking relies on the sibling Pi package tree referenced from `tsconfig.json` (for example `../../npm/node_modules/@earendil-works/...`). If you move this checkout outside that layout, install or map the Pi packages before running `bun run check`.

## Configuration

### Delegation Guards (Depth + Cycle Prevention)

By default, this extension enforces two runtime guards:

1. **Depth guard** (`--subagent-max-depth`, default `3`)
   - Main agent starts at depth `0`
   - Delegation is allowed while `currentDepth < maxDepth`
   - With default depth `3`: depth `0`, `1`, and `2` can delegate; depth `3` cannot
2. **Cycle guard** (`--subagent-prevent-cycles`, default `true`)
   - Blocks delegating to any agent name already present in the current delegation stack
   - Prevents self-recursion (`writer -> writer`) and loops (`planner -> reviewer -> planner`)

You can configure depth with either:

- CLI flag: `--subagent-max-depth <n>`
- Environment variable: `PI_SUBAGENT_MAX_DEPTH=<n>`

`n` must be a non-negative integer.

You can configure cycle prevention with either:

- CLI flag: `--subagent-prevent-cycles` / `--no-subagent-prevent-cycles`
- Environment variable: `PI_SUBAGENT_PREVENT_CYCLES=true|false`

Internal env vars managed by the extension and propagated to child processes:

- `PI_SUBAGENT_DEPTH`
- `PI_SUBAGENT_MAX_DEPTH`
- `PI_SUBAGENT_STACK` (JSON array of ancestor agent names, e.g. `["scout","planner"]`)
- `PI_SUBAGENT_PREVENT_CYCLES`
- `PI_SUBAGENT_TRUSTED_PROJECTS` (JSON array of temporarily approved canonical project roots propagated to child processes)
- `PI_SUBAGENT_DENIED_PROJECTS` (JSON array of temporarily denied canonical project roots propagated to child processes; if a root is later approved in the same session it is removed before child propagation)

Recommended extension-integration note:

If another extension needs to detect whether it is running inside a delegated subagent process, check `PI_SUBAGENT_DEPTH`. Treat `PI_SUBAGENT_DEPTH > 0` as "this pi process is a subagent". This is the recommended way to suppress parent-only behavior such as bells, desktop notifications, or other attention-grabbing signals.

Examples:

```bash
# Default behavior: depth 3 + cycle prevention enabled
pi

# Restrict to one nested level (main -> child -> grandchild)
pi --subagent-max-depth 2

# Disable subagent delegation entirely
pi --subagent-max-depth 0

# Allow depth 3 but disable cycle prevention (not recommended)
pi --subagent-max-depth 3 --no-subagent-prevent-cycles
```

### Context Mode (`spawn` vs `fork`)

`subagent` supports a top-level `mode` switch:

- `spawn` (default) — Child receives only the task string (`Task: ...`). Best for isolated, reproducible work; typically lower token/cost and less context leakage.
- `fork` — Child receives a forked snapshot of the current session context **plus** the task string. Best for follow-up work that depends on prior context; typically higher token/cost and may include sensitive context.

Quick rule of thumb:

- Start with `spawn` for one-off tasks.
- Use `fork` when the delegated task depends on the current session's prior discussion, reads, or decisions.

If omitted, mode defaults to `spawn`.

### Execution Surface (`inline` vs `zellij-pane`)

`subagent` auto-selects the execution surface:

- inside Zellij — use `zellij-pane`
- outside Zellij — use `inline`
- when the effective mode is `zellij-pane`, pane titles use `label(agent)` for explicitly labeled chain stages, `step-N(agent)` for unlabeled chain stages, and `subagent-agent` for non-chain runs; concurrent parallel runs may append a ` #N` suffix for disambiguation

Example:

```json
{ "agent": "writer", "task": "Document the API", "mode": "spawn" }
```

### Invocation Shapes: Single, Parallel, Chain

Use exactly one invocation shape per `subagent` call. Do not mix `agent`/`task`, `tasks`, and `chain` in the same call.

#### Single

Use single mode for one focused delegation.

```json
{ "agent": "writer", "task": "Rewrite README.md", "mode": "spawn" }
```

#### Parallel

Use parallel mode when tasks are independent and can run at the same time. All entries share the top-level `mode`. The execution surface is auto-selected from the environment. The extension runs up to 4 child processes concurrently and rejects more than 8 tasks in one call.

```json
{
  "tasks": [
    { "agent": "scout", "task": "Inspect API routes" },
    { "agent": "security-reviewer", "task": "Review auth and secret handling" },
    { "agent": "reviewer", "task": "Check maintainability risks" }
  ],
  "mode": "spawn"
}
```

The main agent receives a combined summary after all tasks finish. Use this for independent research/review lanes, not for dependent work.

#### Chain

Use chain mode when later stages depend on earlier outputs. Stages run sequentially. Starting with stage 2, the extension prepends summaries of previous stage outputs to the current task. By default, the chain stops at the first failed stage.

A chain stage can be:

- sequential: omit `type` or set `type: "chain"`, with `agent` and `task`
- parallel: set `type: "parallel"`, with `tasks: [{ agent, task, cwd? }, ...]`

Optional stage fields:

- `label` — readable stage name; labels must be unique when provided. In TUI result rows, labeled stages render as `label(agent)`.
- `condition` — `"always"`, `"on_success"` (default), `"on_error"`, or `"on_completed_with_errors"`
- `continueOnError` — when `true`, keep later stages running after this stage fails; failures are included in later context

```json
{
  "chain": [
    {
      "label": "discovery",
      "type": "parallel",
      "tasks": [
        { "agent": "scout", "task": "Inspect local code" },
        { "agent": "researcher", "task": "Check external docs" }
      ]
    },
    { "label": "plan", "agent": "planner", "task": "Create a plan from discovery outputs" },
    { "label": "implement", "agent": "worker", "task": "Implement the plan" },
    {
      "label": "review",
      "type": "parallel",
      "continueOnError": true,
      "tasks": [
        { "agent": "reviewer", "task": "Review correctness" },
        { "agent": "security-reviewer", "task": "Review security" }
      ]
    }
  ],
  "mode": "spawn"
}
```

Recommended patterns:

- `scout -> planner` for codebase reconnaissance followed by a plan.
- parallel discovery (`scout` + `researcher`) -> `planner` when local and external facts are independent.
- `worker -> parallel review` after implementation.
- Use top-level parallel mode instead of chain when all tasks are independent.

### Subagent Definitions

Subagents are defined as Markdown files with YAML frontmatter.

**User Agents:** `~/.pi/agent/agents/*.md` by default, or `$PI_CODING_AGENT_DIR/agents/*.md` when `PI_CODING_AGENT_DIR` is set
**Project Agents:** `.pi/agents/*.md`

`PI_CODING_AGENT_DIR` follows Pi's config-dir override semantics: when it is set, the extension uses `$PI_CODING_AGENT_DIR/agents` as the user/global agent directory instead of `~/.pi/agent/agents`. Project agents are still loaded in addition to the active user/global directory, and project agents win on name conflicts after trust is granted. Trust is matched against the exact canonical project root that owns the nearest `.pi/agents` directory. The extension does not treat Pi's generic boolean project-trust state as evidence because Pi does not expose which root that trust applies to. Instead, project agents are trusted only via persisted exact-root `trust.json` entries, explicit session approvals/denials tracked by this extension, or explicit `--approve` / `--no-approve` for the current nearest project-agent root. When project agents are requested in the UI, Pi prompts for confirmation before running them unless that exact root is already approved for the current session or in persisted trust. In non-UI mode, unapproved project agents are blocked unless the session already carries that exact-root approval (for example via a prior approval or explicit `--approve` for the current root). Explicit denials and approvals are propagated to child subagents through `PI_SUBAGENT_DENIED_PROJECTS` / `PI_SUBAGENT_TRUSTED_PROJECTS`. In untrusted projects, project-agent metadata is held back from the main prompt until trust is granted, hidden project-agent name collisions are blocked until the project is trusted or the colliding agents are renamed, and project-agent discovery rejects `.pi/agents` directories or agent files whose realpaths escape the canonical project root boundary. Newly trusted project agents become available for execution immediately, and the parent prompt’s advertised subagent list is refreshed on the next top-level turn in the current session.

#### Starter Agent

If no user or project subagents can be found, `pi-subagent` creates a starter user agent named `explorer` in the active user agents directory. In untrusted projects, hidden project-agent metadata still counts here, so starter creation is skipped when project agents already exist but are not yet advertised:

- `~/.pi/agent/agents/explorer.md` by default
- `$PI_CODING_AGENT_DIR/agents/explorer.md` when `PI_CODING_AGENT_DIR` is set

The starter is read-only (`read`, `grep`, `find`, `ls`) and is meant for focused codebase exploration. Existing files are never overwritten. If you delete every subagent, the starter will be recreated the next time Pi starts with this extension.

Example agent (`~/.pi/agent/agents/writer.md`):

```markdown
---
name: writer
description: Expert technical writer and editor
model: anthropic/claude-3-5-sonnet
tools: read, write
---

You are an expert technical writer. Your task is to improve the clarity and conciseness of the provided text.
```

### Frontmatter Fields

| Field         | Required | Default                          | Description                                                                                                                                                                |
| ------------- | -------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Yes      | —                                | Agent identifier used in tool calls (must match exactly)                                                                                                                   |
| `description` | Yes      | —                                | What the agent does (shown to the main agent)                                                                                                                              |
| `model`       | No       | Uses the default pi model        | Overrides the model for this agent. You can include a provider prefix (e.g. `anthropic/claude-3-5-sonnet` or `openrouter/claude-3.5-sonnet`) to force a specific provider. |
| `thinking`    | No       | Uses Pi's default thinking level | Sets the thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). Equivalent to `--thinking`.                                                                  |
| `tools`       | No       | `read,bash,edit,write`           | Comma-separated list of **built-in** tools to enable for this agent. If omitted, defaults apply.                                                                           |

Notes:

- `model` accepts `provider/model` syntax — this is a Pi feature. Use it when multiple providers offer the same model ID.
- `thinking` uses the same values as Pi's `--thinking` flag; it's recommended to set it explicitly since thinking support varies by model.
- `tools` only controls built-in tools. Extension tools remain available unless extensions are disabled.
- The Markdown body below the frontmatter becomes the agent's system prompt and is **appended** to Pi's default system prompt (it does **not** replace it).

### Writing a Good Agent File

- **Description matters** — the main agent uses the `description` to decide which subagent to call, so be specific about what the agent is good at.
- **Tool scope is optional but helpful** — reducing tools can keep the agent focused, but you can leave defaults if unsure.
- **Model + thinking is the power combo** — selecting the right model and thinking level is often the biggest quality boost.

### Available Built-in Tools

Available Tools (default: `read`, `bash`, `edit`, `write`):

- `read` — Read file contents
- `bash` — Execute bash commands
- `edit` — Edit files with find/replace
- `write` — Write files (creates/overwrites)
- `grep` — Search file contents (read-only, off by default)
- `find` — Find files by glob pattern (read-only, off by default)
- `ls` — List directory contents (read-only, off by default)

Tip: for a read-only tool selection, use `read,find,ls,grep`. As soon as you include `edit`, `write`, or `bash`, the agent can practically go wild.

## How Communication Works

### The Isolation Model

Each subagent always runs in a **separate `pi` process**:

- ❌ No shared memory/state with the parent process
- ❌ No visibility into sibling subagents
- ✅ Its own model/tool/runtime loop
- ✅ Started with `PI_OFFLINE=1` to skip startup network operations and reduce spawn latency
- ✅ Inherits allowlisted non-secret parent CLI configuration such as extensions plus provider/theme/skill/tool-related flags, resolves only explicit path-like inherited asset values (and explicit file-like values) against the parent cwd while keeping bare `--skill` / `--prompt-template` / `--theme` names verbatim, and reuses parent `--model` / `--thinking` / `--tools` values when the agent file does not override them (`--system-prompt`, unknown flags, and `--api-key` are never forwarded on child command lines. When a CLI key can be mapped safely, the child receives a temporary `$PI_CODING_AGENT_DIR` overlay whose `auth.json` contains an env-var reference for the resolved provider while the rest of the parent agent dir is symlinked through; the actual key is supplied only to the child process environment. This keeps the secret out of argv and Zellij wrapper scripts while preserving Pi's `auth.json`-before-environment auth precedence for the child. A fully-qualified agent `model` that determines the child provider removes any inherited `--provider` from child args. It may provide the API-key mapping hint for user agents and trusted project agents only when it does not conflict with an explicit parent `--provider` or fully-qualified parent `--model`; conflicting hints cause the child to skip inheriting the CLI key. Parent `--models` is not used as an API-key mapping hint. If the CLI key cannot be mapped safely, the child simply does not inherit that CLI key and instead falls back to any existing provider-specific env vars or other configured auth. The temporary overlay is best-effort cleaned after inline runs and scheduled for delayed cleanup when preserved for an abortable live Zellij pane.)

What it can see depends on `mode`:

- `spawn` (default)
  - ✅ Receives: subagent system prompt + `Task: ...`
  - ❌ Does **not** receive parent session history
- `fork`
  - ✅ Receives: forked snapshot of current parent session context + `Task: ...`

### What Gets Sent to Subagents

#### `spawn` mode (default)

`subagent({ agent: "writer", task: "Document the API" })` sends:

```
[System Prompt from ~/.pi/agent/agents/writer.md]

User: Task: Document the API
```

No parent conversation history is included. In `spawn`, include all required context in `task`.

#### `fork` mode

`subagent({ agent: "writer", task: "Document the API", mode: "fork" })` sends:

```
[Forked snapshot of current session context]
[System Prompt from ~/.pi/agent/agents/writer.md]

User: Task: Document the API
```

Note: `fork` copies session context, not transient runtime-only prompt mutations from the parent process.

### What Comes Back to the Main Agent

| Data                        | Main Agent Sees          | TUI Shows              |
| --------------------------- | ------------------------ | ---------------------- |
| Final text output           | ✅ Yes — full, unbounded | ✅ Yes                 |
| Tool calls made by subagent | ❌ No                    | ✅ Yes (expanded view) |
| Token usage / cost          | ❌ No                    | ✅ Yes                 |
| Reasoning/thinking steps    | ❌ No                    | ❌ No                  |
| Error messages              | ✅ Yes (on failure)      | ✅ Yes                 |

**Key point:** The main agent receives **only the final assistant text** from each subagent. Not the tool calls, not the reasoning, not the intermediate steps. This prevents context pollution while still giving you the results.

### Parallel Mode Behavior

When running multiple agents in parallel:

- Subagents run concurrently, up to 4 at a time
- At most 8 tasks are accepted in one call
- The top-level `mode` applies to all tasks in that call
- Main agent receives a combined result after all finish
- In collapsed TUI rows, each result also shows a one-line `Task:` preview for quick recognition

Example tool result text returned to the main agent:

```
Parallel: 3/3 succeeded

[writer] completed: Full output text here...
[tester] completed: Full output text here...
[reviewer] completed: Full output text here...
```

Example TUI card lines:

```
Subagent parallel: 3 tasks 3/3 tasks [spawn, zellij-pane]
─── writer ✓
Task: Draft the API usage guide
```

### Chain Mode Behavior

When running agents in a chain:

- Stages run one after another, in the order provided
- At most 8 stages are accepted in one call
- A stage can be one sequential agent step or one parallel group
- Parallel stages run up to 4 child processes concurrently and accept at most 8 tasks
- The top-level `mode` applies to every stage and task
- Each stage after the first receives previous stage summaries before its current task
- The chain stops on the first failed stage unless that stage has `continueOnError: true`
- `condition` controls whether a stage runs: `always`, `on_success` (default), `on_error`, `on_completed_with_errors`
- Labeled stage results are shown in the TUI as `label(agent)` so the stage and worker are both visible at a glance
- Unlabeled chain stages use generated `step-N(agent)` labels in pane titles and TUI rows

Example tool result text returned to the main agent:

```
Chain: 4/4 stages completed

[1. discovery] completed:
  [scout] completed: Findings...
  [researcher] completed: Docs...

[2. plan] completed:
  [planner] completed: Plan...
```

Example TUI card lines:

```
Subagent chain: 2 stages 2/2 stages completed [spawn, zellij-pane]
─── discovery(scout) ✓
Task: Inspect local code and summarize the architecture
```

## Features

- **Auto-Discovery** — Agents are found at startup and their descriptions are injected into the main agent's system prompt.
- **Context Mode Switch** — `spawn` (fresh context) and `fork` (session snapshot + task) per call.
- **Execution Surface Auto-Selection** — `zellij-pane` inside Zellij and `inline` otherwise.
- **Depth + Cycle Guards** — Depth limiting and ancestry-cycle checks prevent runaway recursive delegation by default.
- **Streaming Updates** — Parent TUI updates continue to follow the structured subagent event stream, while Zellij-pane runs expose a separate pane with human-readable progress.
- **Rich TUI Rendering** — Collapsed/expanded views for single, parallel, and chain runs with usage stats, task previews, tool call previews, stage-aware labels, and markdown output.
- **Security Confirmation** — Project-local agents require explicit user approval before execution.

## Project Structure

```
index.ts                 — Extension entry point: lifecycle hooks, tool registration, trust gating, mode orchestration
subagent-config.ts       — Tool schema and canonical project-root environment parsing
agents.ts                — Agent discovery: reads/parses .md files from the active Pi config dir and project directories
metadata-frontmatter.ts  — Frontmatter-only reads for faster/safer agent metadata loading
project-agent-paths.ts   — Project-agent path boundary checks for nearest `.pi/agents` lookup and symlink escape rejection
project-trust.ts         — Exact-root project trust and session approval/denial helpers
trust-path.ts            — Canonical path and within-root trust-boundary helpers
provider-auth.ts         — Provider/API-key mapping and ambiguity handling for inherited CLI credentials
chain-helpers.ts         — Chain stage validation, condition handling, and previous-summary task construction
runner-cli.js            — Parent CLI inheritance: allowlisted flag parsing, asset handling, git source sanitization
runner.ts                — Process runner: inline/Zellij launch, auth overlays, FIFO/status plumbing, lifecycle cleanup
runner-core.ts           — Pure runner helpers for chunked JSONL processing and Zellij pane watch-state decisions
runner-events.js         — Shared JSON event parsing and result summarization used by the parent transport path
pane-renderer.js         — FIFO bridge helper that mirrors raw JSONL to the parent and renders human-readable pane output
pane-renderer-core.ts    — Pure pane-rendering helpers reused by the CLI wrapper and automated tests
render.ts                — TUI rendering: renderCall and renderResult for the subagent tool
types.ts                 — Shared types and pure helper functions
*.test.ts                — Bun/node:test coverage for discovery, runner helpers, trust, metadata, pane rendering, and chain behavior
```

## Attribution

Inspired by implementations from [vaayne/agent-kit](https://github.com/vaayne/agent-kit) and [mariozechner/pi-mono](https://github.com/badlogic/pi-mono).

## License

MIT
