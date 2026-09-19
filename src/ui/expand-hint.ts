/**
 * Compatibility-safe expansion-key formatting for renderers loaded against
 * Pi 0.84 declarations and newer host runtimes.
 */

import * as piCodingAgent from "@earendil-works/pi-coding-agent";

const EXPAND_BINDING = "app.tools.expand";
const DEFAULT_EXPAND_KEY = "Ctrl+O";

function stripTerminalControls(text: string): string {
	return text
		.replace(/\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function formatKey(text: string): string {
	return text.trim().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/**
 * Returns the host-configured expand binding without assuming a particular Pi
 * export set. Newer hosts expose keyText; older/minimal hosts can still yield
 * a binding through keyHint, and the historical default remains the last
 * resort for test-only or non-TUI rendering.
 */
export function configuredExpandKey(): string {
	try {
		const bindings = piCodingAgent as unknown as {
			keyText?: (binding: string) => unknown;
			keyHint?: (binding: string, description: string) => unknown;
		};
		const raw = bindings.keyText?.(EXPAND_BINDING);
		if (typeof raw === "string" && raw.trim()) return formatKey(stripTerminalControls(raw));

		const description = "to expand";
		const hinted = bindings.keyHint?.(EXPAND_BINDING, description);
		if (typeof hinted !== "string") return DEFAULT_EXPAND_KEY;
		const plain = stripTerminalControls(hinted).trim();
		const descriptionIndex = plain.indexOf(description);
		if (descriptionIndex === -1) return DEFAULT_EXPAND_KEY;
		const beforeDescription = plain.slice(0, descriptionIndex).trim();
		if (beforeDescription) return formatKey(beforeDescription.replace(/[([\s]+$/g, ""));
		const parenthesized = /\(([^()]+)\)\s*$/.exec(plain.slice(descriptionIndex + description.length));
		if (parenthesized?.[1]?.trim()) return formatKey(parenthesized[1]);
	} catch {
		// Rendering must remain available when keybinding/theme state is absent.
	}
	return DEFAULT_EXPAND_KEY;
}

/** A plain full hint so callers can apply one muted tool-display style. */
export function configuredExpandHint(description = "to expand"): string {
	return `${configuredExpandKey()} ${description}`;
}
