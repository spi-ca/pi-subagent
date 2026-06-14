/**
 * Helpers for inheriting selected parent CLI flags in child subagent processes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function looksLikeExplicitRelativePath(value) {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\")
  );
}

const KNOWN_ASSET_FILE_EXTENSIONS = new Set([".json", ".md", ".markdown", ".yaml", ".yml", ".js", ".ts", ".mjs", ".cjs"]);

function looksLikeWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]+[\\/][^\\/]+/.test(value);
}

function sanitizeGitExtensionSource(value) {
  if (!value.startsWith("git:")) return value;

  const source = value.slice(4);
  try {
    const parsed = new URL(source);
    const safeSshGitUser = parsed.protocol === "ssh:" && parsed.username === "git" && parsed.password === "";
    parsed.username = safeSshGitUser ? "git" : "";
    parsed.password = "";
    for (const key of Array.from(parsed.searchParams.keys())) {
      const normalized = key.toLowerCase();
      if (normalized !== "ref") parsed.searchParams.delete(key);
    }
    parsed.hash = "";
    return `git:${parsed.toString()}`;
  } catch {
    // SCP-like git sources are only passed through for the conventional
    // non-secret `git@host:path` user. Other `user@host:path` values may
    // place credentials in argv, so drop them.
    if (/^git@[^@\s?#]+:[^@\s?#]+$/.test(source)) return value;
    if (/^[^@\s]+@[^@\s]+:[^\s]+$/.test(source)) return null;
    const atIndex = source.indexOf("@");
    const slashIndex = source.indexOf("/");
    if (atIndex !== -1 && (slashIndex === -1 || atIndex < slashIndex)) return null;
    const sanitizedSource = source.split(/[?#]/, 1)[0];
    return sanitizedSource ? `git:${sanitizedSource}` : null;
  }
}

function isExistingFile(value) {
  try {
    return fs.statSync(value).isFile();
  } catch {
    return false;
  }
}

function resolvePathArg(value, options = {}) {
  const {
    allowPackageSource = false,
    alwaysResolveRelative = false,
    resolveFileExtension = false,
  } = options;
  if (!value) return value;
  if (allowPackageSource && value.startsWith("npm:")) return value;
  if (allowPackageSource && /^git@[^@\s?#]+:[^@\s?#]+$/.test(value)) return value;
  if (allowPackageSource && /^[^@\s]+@[^@\s]+:[^\s]+$/.test(value)) return null;
  if (allowPackageSource && value.startsWith("git:")) {
    return sanitizeGitExtensionSource(value);
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value) || looksLikeWindowsAbsolutePath(value)) return value;

  const resolved = path.resolve(process.cwd(), value);
  if (
    alwaysResolveRelative ||
    looksLikeExplicitRelativePath(value) ||
    (resolveFileExtension && KNOWN_ASSET_FILE_EXTENSIONS.has(path.extname(value).toLowerCase()) && isExistingFile(resolved))
  ) {
    return resolved;
  }
  return value;
}

/**
 * Parse process.argv into groups used for child pi invocations.
 *
 * - extensionArgs: forwarded with path resolution
 * - alwaysProxy: explicitly allowlisted non-secret flags forwarded verbatim to every child
 * - fallbackModel/thinking/tools: used only when the agent file does not set them
 */
export function parseInheritedCliArgs(argv) {
  const extensionArgs = [];
  const alwaysProxy = [];
  let apiKey;
  let provider;
  let models;
  let fallbackModel;
  let fallbackThinking;
  let fallbackTools;
  let fallbackNoTools = false;

  let i = 2; // skip executable + script name
  while (i < argv.length) {
    const raw = argv[i];
    if (!raw.startsWith("-")) {
      i++;
      continue;
    }

    const eqIdx = raw.indexOf("=");
    const flagName = eqIdx !== -1 ? raw.slice(0, eqIdx) : raw;
    const inlineValue = eqIdx !== -1 ? raw.slice(eqIdx + 1) : undefined;

    const nextToken = argv[i + 1];
    const nextIsValue = nextToken !== undefined && !nextToken.startsWith("-");

    const getValue = () => {
      if (inlineValue !== undefined) return [inlineValue, 1];
      if (nextIsValue) return [nextToken, 2];
      return [undefined, 1];
    };

    if (
      [
        "--mode",
        "--session",
        "--append-system-prompt",
        "--export",
        "--subagent-max-depth",
      ].includes(flagName)
    ) {
      const [, skip] = getValue();
      i += skip;
      continue;
    }

    if (["--subagent-prevent-cycles", "--list-models"].includes(flagName)) {
      const [, skip] = getValue();
      i += skip;
      continue;
    }

    if (
      [
        "--print",
        "-p",
        "--no-session",
        "--continue",
        "-c",
        "--resume",
        "-r",
        "--offline",
        "--help",
        "-h",
        "--version",
        "-v",
        "--no-subagent-prevent-cycles",
      ].includes(flagName)
    ) {
      i++;
      continue;
    }

    if (flagName === "--no-extensions" || flagName === "-ne") {
      extensionArgs.push(flagName);
      i++;
      continue;
    }

    if (flagName === "--extension" || flagName === "-e") {
      const [value, skip] = getValue();
      if (value !== undefined) {
        const resolved = resolvePathArg(value, { allowPackageSource: true, resolveFileExtension: true });
        if (resolved !== null) extensionArgs.push(flagName, resolved);
      }
      i += skip;
      continue;
    }

    if (["--skill", "--prompt-template", "--theme"].includes(flagName)) {
      const [value, skip] = getValue();
      if (value !== undefined) {
        alwaysProxy.push(flagName, resolvePathArg(value, { resolveFileExtension: true }));
      }
      i += skip;
      continue;
    }

    if (flagName === "--session-dir") {
      const [value, skip] = getValue();
      if (value !== undefined) {
        alwaysProxy.push(flagName, resolvePathArg(value, { alwaysResolveRelative: true }));
      }
      i += skip;
      continue;
    }

    if (flagName === "--api-key") {
      const [value, skip] = getValue();
      if (value !== undefined) apiKey = value;
      i += skip;
      continue;
    }

    if (
      [
        "--provider",
        "--models",
      ].includes(flagName)
    ) {
      const [value, skip] = getValue();
      if (value !== undefined) {
        alwaysProxy.push(flagName, value);
        if (flagName === "--provider") provider = value;
        if (flagName === "--models") models = value;
      }
      i += skip;
      continue;
    }

    if (["--approve", "-a", "--no-approve", "-na"].includes(flagName)) {
      const [, skip] = getValue();
      i += skip;
      continue;
    }

    if (
      [
        "--no-skills",
        "-ns",
        "--no-prompt-templates",
        "-np",
        "--no-themes",
        "--no-context-files",
        "-nc",
        "--no-builtin-tools",
        "-nbt",
        "--verbose",
      ].includes(flagName)
    ) {
      alwaysProxy.push(flagName);
      i++;
      continue;
    }

    if (flagName === "--exclude-tools" || flagName === "-xt") {
      const [value, skip] = getValue();
      if (value !== undefined) alwaysProxy.push(flagName, value);
      i += skip;
      continue;
    }

    if (flagName === "--model") {
      const [value, skip] = getValue();
      if (value !== undefined) fallbackModel = value;
      i += skip;
      continue;
    }

    if (flagName === "--thinking") {
      const [value, skip] = getValue();
      if (value !== undefined) fallbackThinking = value;
      i += skip;
      continue;
    }

    if (flagName === "--tools" || flagName === "-t") {
      const [value, skip] = getValue();
      if (value !== undefined) fallbackTools = value;
      i += skip;
      continue;
    }

    if (flagName === "--no-tools" || flagName === "-nt") {
      fallbackNoTools = true;
      i++;
      continue;
    }

    i++;
  }

  return {
    extensionArgs,
    alwaysProxy,
    apiKey,
    provider,
    models,
    fallbackModel,
    fallbackThinking,
    fallbackTools,
    fallbackNoTools,
  };
}
