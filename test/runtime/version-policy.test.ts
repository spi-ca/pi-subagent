import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { MINIMUM_TMUX_VERSION, isStableSemverAtLeast, isStableTmuxVersionAtLeast, parseCmuxVersionOutput, parsePiVersionOutput, parseStableSemver, parseStableTmuxVersion, parseTmuxVersionOutput } from "../../src/runtime/version-policy.mjs";

describe("minimum tool version policy", () => {
  test("accepts current and higher stable Pi/cmux semver only", () => {
    for (const version of ["0.80.10", "0.80.11", "0.81.0", "1.0.0"]) assert.equal(isStableSemverAtLeast(version, "0.80.10"), true);
    for (const version of ["0.80.9", "0.79.99", "0.80.10-rc.1", "0.80.10+build", "v0.80.10", "00.80.10", "0.80", "garbage"]) assert.equal(isStableSemverAtLeast(version, "0.80.10"), false);
    assert.equal(parseStableSemver("0.64.20")?.version, "0.64.20");
    assert.equal(parsePiVersionOutput("0.80.10\n"), "0.80.10");
    assert.equal(parseCmuxVersionOutput("cmux 0.64.20\n"), "0.64.20");
    assert.equal(parseCmuxVersionOutput("cmux 0.65.0 (123) [abcdef]\n"), "0.65.0");
    for (const output of [" 0.80.10\n", "0.80.10 \n", "0.80.10\r\n", "\n0.80.10\n"]) assert.equal(parsePiVersionOutput(output), null);
    for (const output of ["cmux 0.65.0-beta.1\n", "cmux 0.64.20\r\n", "cmux 0.64.20\nextra\n", " cmux 0.64.20\n", "cmux 0.64.20 \n"]) assert.equal(parseCmuxVersionOutput(output), null);
  });

  test("accepts stable tmux 3.7a and higher while rejecting lower releases and prereleases", () => {
    assert.equal(MINIMUM_TMUX_VERSION, "3.7a");
    for (const version of ["3.7a", "3.7b", "3.7c", "3.8", "3.10", "4.0"]) assert.equal(isStableTmuxVersionAtLeast(version), true);
    for (const version of ["3.7", "3.6z", "3.8-rc1", "next-3.8", "v3.8", "03.8", "garbage"]) assert.equal(isStableTmuxVersionAtLeast(version), false);
    assert.equal(parseStableTmuxVersion("3.10")?.minor, 10);
    assert.equal(parseTmuxVersionOutput("tmux 3.8\n"), "3.8");
    for (const output of ["tmux 3.8-rc1\n", "tmux 3.8\r\n", "tmux 3.8\nextra\n", "tmux 3.8", "tmux 3.8\0\n"]) assert.equal(parseTmuxVersionOutput(output), null);
  });
});
