/** Compatibility-safe expansion hints, preferring the rendering host's bindings. */
import * as piCodingAgent from "@earendil-works/pi-coding-agent";

const EXPAND_BINDING = "app.tools.expand";
const DEFAULT_EXPAND_KEY = "Ctrl+O";

/** Structural shape also accepted by older hosts without injected helpers. */
export interface ExpandKeybindings {
	keyText?: (binding: typeof EXPAND_BINDING) => unknown;
	keyHint?: (binding: typeof EXPAND_BINDING, description: string) => unknown;
}

function stripTerminalControls(text: string): string {
	return text.slice(0, 1024)
		.replace(/\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
		.replace(/\p{Surrogate}/gu, "�");
}

function formatKey(text: string): string {
	return text.trim().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

/** Empty means explicitly unbound. Only absent helpers permit legacy fallback. */
export function configuredExpandKey(injected?: ExpandKeybindings): string {
	const hasHelper = (bindings: ExpandKeybindings | undefined) =>
		typeof bindings?.keyText === "function" || typeof bindings?.keyHint === "function";
	const bindings = hasHelper(injected) ? injected! : piCodingAgent as ExpandKeybindings;
	if (!hasHelper(bindings)) return DEFAULT_EXPAND_KEY;
	try {
		if (typeof bindings.keyText === "function") {
			const raw = bindings.keyText(EXPAND_BINDING);
			return typeof raw === "string" ? formatKey(stripTerminalControls(raw)) : "";
		}
		const description = "to expand";
		const hinted = bindings.keyHint!(EXPAND_BINDING, description);
		if (typeof hinted !== "string") return "";
		const plain = stripTerminalControls(hinted).trim();
		const descriptionIndex = plain.indexOf(description);
		if (descriptionIndex === -1) return "";
		const beforeDescription = plain.slice(0, descriptionIndex).trim();
		if (beforeDescription) return formatKey(beforeDescription.replace(/[([\s]+$/g, ""));
		const parenthesized = /\(([^()]+)\)\s*$/.exec(plain.slice(descriptionIndex + description.length));
		return parenthesized?.[1] ? formatKey(parenthesized[1]) : "";
	} catch {
		// A present but unavailable helper must not advertise an invented binding.
		return "";
	}
}

/** A plain full hint so callers can apply one muted tool-display style. */
export function configuredExpandHint(bindings?: ExpandKeybindings, description = "to expand"): string {
	const key = configuredExpandKey(bindings);
	return key ? `${key} ${description}` : "";
}

/** Include punctuation only when the host actually has an expansion binding. */
export function expandHintSuffix(bindings?: ExpandKeybindings, prefix = " · ", suffix = ""): string {
	const hint = configuredExpandHint(bindings);
	return hint ? `${prefix}${hint}${suffix}` : "";
}
