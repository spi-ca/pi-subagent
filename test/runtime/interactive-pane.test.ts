import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	cmuxInteractivePaneBackend,
	getInteractivePaneBackend,
	herdrInteractivePaneBackend,
	tmuxInteractivePaneBackend,
} from "../../src/runtime/interactive-pane";

describe("interactive pane backend selection", () => {
	test("selects only interactive terminal modes", () => {
		assert.equal(getInteractivePaneBackend("cmux-pane"), cmuxInteractivePaneBackend);
		assert.equal(getInteractivePaneBackend("tmux-pane"), tmuxInteractivePaneBackend);
		assert.equal(getInteractivePaneBackend("inline"), null);
	});

	test("validates backend-specific inherited identities", () => {
		assert.equal(cmuxInteractivePaneBackend.availabilityError({
			CMUX_WORKSPACE_ID: "123e4567-e89b-12d3-a456-426614174000",
			CMUX_SURFACE_ID: "123e4567-e89b-12d3-a456-426614174001",
		}), null);
		assert.match(cmuxInteractivePaneBackend.availabilityError({}) ?? "", /CMUX_WORKSPACE_ID/);
		assert.equal(tmuxInteractivePaneBackend.availabilityError({
			TMUX: "/tmp/tmux/default,1,0",
			TMUX_PANE: "%1",
		}), null);
		assert.match(tmuxInteractivePaneBackend.availabilityError({}) ?? "", /TMUX_PANE/);
		assert.equal(herdrInteractivePaneBackend.availabilityError({
			HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_WORKSPACE_ID: "workspace", HERDR_TAB_ID: "tab", HERDR_PANE_ID: "pane",
		}), null);
		for (const env of [
			{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp//herdr.sock", HERDR_WORKSPACE_ID: "workspace", HERDR_TAB_ID: "tab", HERDR_PANE_ID: "pane" },
			{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_WORKSPACE_ID: "😀".repeat(65), HERDR_TAB_ID: "tab", HERDR_PANE_ID: "pane" },
		]) assert.match(herdrInteractivePaneBackend.availabilityError(env) ?? "", /HERDR_ENV/);
	});
});
