# AGENTS.md

Entry point for coding agents working in this repository. This file guides
agents editing this repo's own code; it is distinct from
[`docs/agents.md`](docs/agents.md), which documents how this package's
**users** author subagent definition files (frontmatter fields, tool
allowlists) for delegation targets.

## Project

`pi-subagent` is a Pi extension package that lets a Pi coding agent delegate
tasks to specialized subagents: single calls, parallel batches, and
sequential chains, with explicit control over context handoff (`spawn` vs
`fork`) and execution environment (inline, cmux, tmux, Herdr).

## Runtime

Use `bun` (see `packageManager` in `package.json`), not `npm`/`npx`.

```bash
bun install --frozen-lockfile
```

## Validation

```bash
bun run ci
```

`bun run ci` runs `bun run check` (type check via `tsc --noEmit`) followed by
`bun run test` (`bun test --isolate --pass-with-no-tests`), and is the required
check before treating a change as verified. File isolation is required because
tests intentionally use file-global Bun mocks and process globals. `bun run
test` and `bun run check` also exist individually as defined in `package.json`.
Live/acceptance/benchmark scripts
(`acceptance:*`, `benchmark:*`) are opt-in and gated by explicit environment
variables; see [`docs/development.md`](docs/development.md) before running
them.

## Cross-Cutting Rules

- Do not move or rename the root `index.ts`. The `package.json` `pi.extensions`
  manifest references it directly as the extension entry point.
- Internal modules live under `src/`; `test/` mirrors that layout plus
  dedicated `fixtures/`, `helpers/`, and `release/` directories. See the
  project structure table in [`docs/development.md`](docs/development.md)
  for the current, authoritative list before adding a new test file.
- Language follows the reader. Docs written for people — `README.md` and
  `docs/*.md` — are Korean. Docs written for agents — this file and
  `docs/guidelines/*.md` — are English. Match the surrounding document
  instead of introducing a second language into it.
- Follow [`docs/guidelines/a-complete-guide-to-agents-md.md`](docs/guidelines/a-complete-guide-to-agents-md.md)
  when editing this file: keep it small and stable, and push detail into
  focused docs instead.

## Focused Docs

| Doc | Use For |
|-----|---------|
| [`docs/development.md`](docs/development.md) | Setup, verification commands, project structure, and cmux/tmux/Herdr design-doc index |
| [`docs/configuration.md`](docs/configuration.md) | User-facing settings and environment variables |
| [`docs/usage.md`](docs/usage.md) | How to invoke subagent delegation from Pi |
| [`docs/agents.md`](docs/agents.md) | How package users author subagent definition files |
