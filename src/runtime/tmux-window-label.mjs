const AGENT_TOKEN_MAX_LENGTH = 24;
const RUN_PREFIX_LENGTH = 8;
const LABEL_RE = /^subagent:([A-Za-z0-9][A-Za-z0-9._-]{0,23}):([A-Za-z0-9][A-Za-z0-9._-]{0,7})$/;

function canonicalToken(value, fallback, maxLength) {
  const input = String(value ?? "");
  if (/[^\x20-\x7e]/.test(input)) return fallback;
  const token = input
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, maxLength);
  return token || fallback;
}

/** Returns the bounded ASCII token used in stable tmux window labels. */
export function canonicalizeTmuxWindowAgentToken(agentName) {
  return canonicalToken(agentName, "agent", AGENT_TOKEN_MAX_LENGTH);
}

/** Returns the bounded ASCII run prefix used in stable tmux window labels. */
export function canonicalizeTmuxWindowRunPrefix(runId) {
  return canonicalToken(runId, "run", RUN_PREFIX_LENGTH);
}

/** Builds the only tmux window label accepted for a current allocation. */
export function buildTmuxWindowLabel(agentName, runId) {
  return `subagent:${canonicalizeTmuxWindowAgentToken(agentName)}:${canonicalizeTmuxWindowRunPrefix(runId)}`;
}

/**
 * Rejects non-canonical or injected labels. When a run ID is supplied, the
 * label's prefix must be the exact canonical prefix derived from that run.
 */
export function isValidTmuxWindowLabel(label, runId) {
  if (typeof label !== "string" || !LABEL_RE.test(label)) return false;
  if (runId === undefined) return true;
  const parts = label.split(":");
  return parts[2] === canonicalizeTmuxWindowRunPrefix(runId);
}
