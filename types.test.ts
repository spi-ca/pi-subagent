import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { getDefaultTerminalModeFromEnv, isInsideZellij } from "./types";

const ORIGINAL_ZELLIJ = process.env.ZELLIJ;
const ORIGINAL_ZELLIJ_PANE_ID = process.env.ZELLIJ_PANE_ID;

function restoreEnv() {
	if (ORIGINAL_ZELLIJ === undefined) delete process.env.ZELLIJ;
	else process.env.ZELLIJ = ORIGINAL_ZELLIJ;

	if (ORIGINAL_ZELLIJ_PANE_ID === undefined) delete process.env.ZELLIJ_PANE_ID;
	else process.env.ZELLIJ_PANE_ID = ORIGINAL_ZELLIJ_PANE_ID;
}

function setZellijEnv(zellij?: string, paneId?: string) {
	if (zellij === undefined) delete process.env.ZELLIJ;
	else process.env.ZELLIJ = zellij;

	if (paneId === undefined) delete process.env.ZELLIJ_PANE_ID;
	else process.env.ZELLIJ_PANE_ID = paneId;
}

afterEach(() => {
	restoreEnv();
});

describe("zellij environment detection", () => {
	test('treats ZELLIJ="0" as inside Zellij', () => {
		setZellijEnv("0");

		assert.equal(isInsideZellij(), true);
		assert.equal(getDefaultTerminalModeFromEnv(), "zellij-pane");
	});

	test('treats ZELLIJ_PANE_ID="0" as inside Zellij', () => {
		setZellijEnv(undefined, "0");

		assert.equal(isInsideZellij(), true);
		assert.equal(getDefaultTerminalModeFromEnv(), "zellij-pane");
	});

	test("falls back to inline outside Zellij", () => {
		setZellijEnv(undefined, undefined);

		assert.equal(isInsideZellij(), false);
		assert.equal(getDefaultTerminalModeFromEnv(), "inline");
	});

	test("ignores empty Zellij env values", () => {
		setZellijEnv("   ", "");

		assert.equal(isInsideZellij(), false);
		assert.equal(getDefaultTerminalModeFromEnv(), "inline");
	});
});
