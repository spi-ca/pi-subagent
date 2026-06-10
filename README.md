# Pi Subagent

**Delegate tasks to specialized subagents with configurable context modes (`spawn` / `fork`) and execution surfaces (`inline` / `zellij-pane`).**

There are many subagent extensions for pi, this one is mine.

## Why Pi Subagent

**Specialization** — Use tailored agents for specific tasks like refactoring, documentation, or research.

**Context Control** — Choose `spawn` (fresh context) or `fork` (inherit current session context), depending on the task.

**Execution Surface Control** — Choose `inline` (direct child process) or `zellij-pane` (new Zellij pane + FIFO bridge + human-readable pane renderer), depending on whether you want classic in-process streaming or a separate Zellij pane while keeping structured progress in the parent TUI.

**Parallel Execution** — Run multiple independent agents at once.

**Chain Execution** — Run dependent stages sequentially, automatically passing previous stage summaries to later stages. Chain stages can be sequential agent steps or parallel groups.

**Local Editable Fork** — This local package keeps the simple delegation model while adding chain and parallel workflows for day-to-day Pi orchestration.

## Install

This checkout is used as a local editable Pi package:

```json
"/home/spi-ca/.pi/agent/local-packages/pi-subagent"
```

The user-level Pi settings file is:

```text
/home/spi-ca/.pi/agent/settings.json
```

For local development:

```bash
cd /home/spi-ca/.pi/agent/local-packages/pi-subagent
bun install
bun run ci
```

Pi loads local package directories directly; no npm publish step is required.

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

`subagent` also supports an optional top-level `terminal` override:

- omitted (default) — Auto-select `zellij-pane` when running inside Zellij, otherwise `inline`.
- `inline` — Launch the child `pi` process directly and stream stdout back to the parent.
- `zellij-pane` — When running inside Zellij, launch the child in a new pane, bridge JSON stdout back through a FIFO (named pipe), and render human-readable progress in the pane. Explicitly selecting this outside Zellij is an error. Structured progress still renders in the parent TUI. Pane titles use `label(agent)` for explicitly labeled chain stages, `step-N(agent)` for unlabeled chain stages, and `subagent-agent` for non-chain runs without a custom name; concurrent parallel runs may append a ` #N` suffix for disambiguation.

Quick rule of thumb:

- Omit `terminal` unless you specifically want to override the environment-based default.
- Use `zellij-pane` when you want a separate pane with readable progress for long-running delegated work.
- Use `inline` when you want everything to stay in the parent Pi view.
- Use `inline` when you want classic in-process streaming even inside Zellij.

Examples:

```json
{ "agent": "writer", "task": "Document the API", "mode": "spawn" }
```

```json
{ "agent": "review", "task": "Double-check this migration", "mode": "fork", "terminal": "inline" }
```

### Zellij Pane Options

When the effective terminal mode is `zellij-pane` (either explicitly selected or auto-selected inside Zellij), you can optionally pass:

```json
{
  "agent": "worker",
  "task": "Run tests",
  "terminal": "zellij-pane",
  "zellij": {
    "pane": {
      "direction": "right",
      "floating": false,
      "closeOnExit": false,
      "name": "tests"
    }
  }
}
```

Supported `zellij.pane` fields:

- `direction` — pane split direction: `right` or `down`
- `floating` — open as a floating pane
- `closeOnExit` — close the pane immediately when the child command exits
- `name` — override the default pane title (`label(agent)` for labeled chain stages, `step-N(agent)` for unlabeled chain stages, otherwise `subagent-agent`; concurrent parallel runs may append a ` #N` suffix for disambiguation)

### Invocation Shapes: Single, Parallel, Chain

Use exactly one invocation shape per `subagent` call. Do not mix `agent`/`task`, `tasks`, and `chain` in the same call.

#### Single

Use single mode for one focused delegation.

```json
{ "agent": "writer", "task": "Rewrite README.md", "mode": "spawn", "terminal": "inline" }
```

#### Parallel

Use parallel mode when tasks are independent and can run at the same time. All entries share the top-level `mode` and `terminal`. The extension runs up to 4 child processes concurrently and rejects more than 8 tasks in one call.

```json
{
  "tasks": [
    { "agent": "scout", "task": "Inspect API routes" },
    { "agent": "security-reviewer", "task": "Review auth and secret handling" },
    { "agent": "reviewer", "task": "Check maintainability risks" }
  ],
  "mode": "spawn",
  "terminal": "inline"
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
  "mode": "spawn",
  "terminal": "inline"
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

`PI_CODING_AGENT_DIR` follows Pi's config-dir override semantics: when it is set, the extension uses `$PI_CODING_AGENT_DIR/agents` as the user/global agent directory instead of `~/.pi/agent/agents`. Project agents are still loaded in addition to the active user/global directory, and project agents win on name conflicts. When project agents are requested, Pi will prompt for confirmation before running them.

#### Starter Agent

If no user or project subagents can be found, `pi-subagent` creates a starter user agent named `explorer` in the active user agents directory:

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
- ✅ Inherits relevant parent CLI configuration such as extensions, provider/theme/skill flags, resolves inherited relative resource paths against the parent cwd, and reuses parent `--model` / `--thinking` / `--tools` values when the agent file does not override them

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
Subagent parallel: 3 tasks 3/3 tasks [spawn, inline]
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
Subagent chain: 2 stages 2/2 steps [spawn, inline]
─── discovery(scout) ✓
Task: Inspect local code and summarize the architecture
```

## Features

- **Auto-Discovery** — Agents are found at startup and their descriptions are injected into the main agent's system prompt.
- **Context Mode Switch** — `spawn` (fresh context) and `fork` (session snapshot + task) per call.
- **Execution Surface Switch** — `inline` (direct child process) and `zellij-pane` (new Zellij pane + FIFO bridge + human-readable pane renderer) per call.
- **Depth + Cycle Guards** — Depth limiting and ancestry-cycle checks prevent runaway recursive delegation by default.
- **Streaming Updates** — Parent TUI updates continue to follow the structured subagent event stream, while Zellij-pane runs expose a separate pane with human-readable progress.
- **Rich TUI Rendering** — Collapsed/expanded views for single, parallel, and chain runs with usage stats, task previews, tool call previews, stage-aware labels, and markdown output.
- **Security Confirmation** — Project-local agents require explicit user approval before execution.

## Project Structure

```
index.ts       — Extension entry point: lifecycle hooks, tool registration, mode orchestration
agents.ts      — Agent discovery: reads and parses .md files from the active Pi config dir and project directories
runner-cli.js  — Parent CLI inheritance: parses and normalizes flags forwarded to child processes
runner.ts      — Process runner: launches inline or Zellij-pane subagents, manages FIFO/status plumbing, and coordinates lifecycle handling
runner-events.js — Shared JSON event parsing and result summarization used by the parent transport path
pane-renderer.js — FIFO bridge helper that mirrors raw JSONL to the parent and renders human-readable pane output
render.ts      — TUI rendering: renderCall and renderResult for the subagent tool
types.ts       — Shared types and pure helper functions
```

## Attribution

Inspired by implementations from [vaayne/agent-kit](https://github.com/vaayne/agent-kit) and [mariozechner/pi-mono](https://github.com/badlogic/pi-mono).

## License

MIT
