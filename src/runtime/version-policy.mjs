export const MINIMUM_PI_VERSION = "0.80.10";
export const MINIMUM_CMUX_VERSION = "0.64.20";
export const MINIMUM_TMUX_VERSION = "3.7a";

const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TMUX = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)([a-z]?)$/;
const safe = (parts) => parts.every((part) => Number.isSafeInteger(part) && part >= 0);

export function parseStableSemver(value) {
  if (typeof value !== "string") return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  return safe(parts) ? { version: value, major: parts[0], minor: parts[1], patch: parts[2] } : null;
}

export function compareStableSemver(left, right) {
  const a = typeof left === "string" ? parseStableSemver(left) : left;
  const b = typeof right === "string" ? parseStableSemver(right) : right;
  if (!a || !b) return null;
  return Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch);
}

export function isStableSemverAtLeast(value, minimum) {
  const comparison = compareStableSemver(value, minimum);
  return comparison !== null && comparison >= 0;
}

export function parseStableTmuxVersion(value) {
  if (typeof value !== "string") return null;
  const match = TMUX.exec(value);
  if (!match) return null;
  const major = Number(match[1]), minor = Number(match[2]);
  if (!safe([major, minor])) return null;
  return { version: value, major, minor, suffix: match[3], suffixRank: match[3] ? match[3].charCodeAt(0) - 96 : 0 };
}

export function compareStableTmuxVersion(left, right) {
  const a = typeof left === "string" ? parseStableTmuxVersion(left) : left;
  const b = typeof right === "string" ? parseStableTmuxVersion(right) : right;
  if (!a || !b) return null;
  return Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.suffixRank - b.suffixRank);
}

export function isStableTmuxVersionAtLeast(value, minimum = MINIMUM_TMUX_VERSION) {
  const comparison = compareStableTmuxVersion(value, minimum);
  return comparison !== null && comparison >= 0;
}

export function parsePiVersionOutput(stdout) {
  if (typeof stdout !== "string" || stdout.includes("\r") || stdout.includes("\0")) return null;
  const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!line || line.includes("\n")) return null;
  return parseStableSemver(line)?.version ?? null;
}

export function parseCmuxVersionOutput(stdout) {
  if (typeof stdout !== "string" || stdout.includes("\r") || stdout.includes("\0")) return null;
  const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  if (!line || line.includes("\n")) return null;
  const match = /^cmux ((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?: \([0-9]+\) \[[0-9a-f]+\])?$/i.exec(line);
  return match && parseStableSemver(match[1]) ? match[1] : null;
}

export function parseTmuxVersionOutput(stdout) {
  if (typeof stdout !== "string" || !stdout.endsWith("\n") || stdout.includes("\r") || stdout.includes("\0") || stdout.slice(0, -1).includes("\n")) return null;
  const match = /^tmux (.+)$/.exec(stdout.slice(0, -1));
  return match && parseStableTmuxVersion(match[1]) ? match[1] : null;
}
