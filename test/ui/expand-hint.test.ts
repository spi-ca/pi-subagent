import { test } from "bun:test";
import assert from "node:assert/strict";
const { mock } = await import("bun:test") as unknown as {
  mock: { module(name: string, factory: () => Record<string, unknown>): void };
};

// Minimal old host: no imported keybinding helpers. Injected helpers must work
// without modern exports, and the historical default is only for their absence.
mock.module("@earendil-works/pi-coding-agent", () => ({}));
const { configuredExpandKey, configuredExpandHint, expandHintSuffix } = await import("../../src/ui/expand-hint");

test("absent helpers retain old-host fallback", () => {
  assert.equal(configuredExpandKey(), "Ctrl+O");
  assert.equal(configuredExpandHint({}), "Ctrl+O to expand");
});

test("injected helpers are authoritative, including empty/unavailable bindings", () => {
  const ids: string[] = [];
  assert.equal(configuredExpandKey({ keyText: id => { ids.push(id); return "alt+shift+x"; } }), "Alt+Shift+X");
  assert.deepEqual(ids, ["app.tools.expand"]);
  for (const keyText of [() => "", () => "   ", () => undefined, () => { throw new Error("unavailable"); }]) {
    const bindings = { keyText, keyHint: () => "ctrl+wrong to expand" };
    assert.equal(configuredExpandHint(bindings), "");
    assert.equal(expandHintSuffix(bindings, " (", ")"), "");
  }
});

test("hint-only hosts support both historical formats without inventing a key", () => {
  for (const hint of ["alt+e to expand", "to expand (Alt+E)"]) {
    assert.equal(configuredExpandHint({ keyHint: () => hint }), "Alt+E to expand");
  }
  for (const hint of ["", "to expand", "invalid"]) {
    assert.equal(configuredExpandKey({ keyHint: () => hint }), "");
  }
});

test("host key text and hints are sanitized before display", () => {
  const hostile = "\x1b[31mctrl+e\x1b[0m\x1b]8;;https://invalid.test\x07\x1b]8;;\x07\n\u202e";
  assert.equal(configuredExpandKey({ keyText: () => hostile }), "Ctrl+E");
  assert.equal(configuredExpandKey({ keyHint: () => `${hostile} to expand` }), "Ctrl+E");
  assert.equal(configuredExpandHint({ keyText: () => "\x1b[31m\x1b[0m" }), "");
});
