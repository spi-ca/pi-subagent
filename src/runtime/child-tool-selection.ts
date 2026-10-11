import { isStableSemverAtLeast } from "./version-policy.mjs";

const split = (value?: string): string[] | undefined => value?.split(",").map((name) => name.trim()).filter(Boolean);
const additive = (tools: readonly string[]): boolean => tools.length > 0 && tools.every((name) => /^[+-]/.test(name));
const mcpSelectors = (tools?: readonly string[]): string[] => tools?.filter((name) => name.startsWith("mcp__")) ?? [];

/** Native Pi 1.1 modifiers take exact names (wildcards are rejected). Only the
 * last matching modifier decides whether a gateway was explicitly removed. */
function removesCodemode(tools?: readonly string[]): boolean {
  if (!tools || !additive(tools)) return false;
  let removed = false;
  for (const entry of tools) {
    if (entry === "-codemode") removed = true;
    else if (entry === "+codemode") removed = false;
  }
  return removed;
}

/** Pi patterns have only one special character: *, matching any characters. */
function matches(pattern: string, name: string): boolean {
  const source = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`).test(name);
}

/** Exact names, identical patterns, and single trailing-* prefixes are closed
 * under intersection. Never approximate two different complex glob languages. */
function intersectPair(parent: string, child: string): string | undefined {
  if (parent === child) return parent;
  if (!child.includes("*")) return matches(parent, child) ? child : undefined;
  if (!parent.includes("*")) return matches(child, parent) ? parent : undefined;
  if (/^[^*]*\*$/.test(parent) && /^[^*]*\*$/.test(child)) {
    const parentPrefix = parent.slice(0, -1);
    const childPrefix = child.slice(0, -1);
    if (parentPrefix.startsWith(childPrefix)) return parent;
    if (childPrefix.startsWith(parentPrefix)) return child;
    return undefined;
  }
  throw new Error("Cannot safely intersect parent/child MCP selectors: use exact names or single trailing-* prefixes (identical patterns are also supported).");
}

/** Capture only the public gateway capability, not a loadout/config snapshot.
 * Missing APIs or owner metadata must never authorize supplementation. */
export function captureParentNativeCodemodeActive(registry: {
  getActiveTools?: () => readonly string[];
  getAllTools?: () => readonly { name: string; sourceInfo?: { source?: string; path?: string } }[];
}): boolean {
  try {
    if (!registry.getActiveTools || !registry.getAllTools) return false;
    const activeTools = registry.getActiveTools();
    const allTools = registry.getAllTools();
    const owner = allTools.find((tool) => tool.name === "codemode")?.sourceInfo;
    return activeTools.includes("codemode") && owner?.source === "builtin" && owner.path === "builtin:codemode";
  } catch {
    return false;
  }
}

export interface ChildToolSelection {
  tools?: string[];
  noTools: boolean;
  disableMcp: boolean;
}

/** Local tools override the parent fallback; MCP selectors refine it separately.
 * No registry/config reads, runtime snapshot, or exposure conversion occurs here. */
export function resolveInheritedChildToolSelection(options: {
  agentTools?: string[];
  fallbackTools?: string;
  fallbackNoTools?: boolean;
  alwaysProxy?: string[];
  hostVersion: string;
  /** Invocation-scoped evidence; absence is not approval to add a gateway. */
  parentNativeCodemodeActive?: boolean;
}): ChildToolSelection {
  const parent = split(options.fallbackTools);
  let tools = options.agentTools ?? parent;
  // Keep historical fallback precedence: explicit agent selection (and parent
  // --tools) overrides fallback --no-tools, not a new unconditional parent ban.
  const noTools = tools !== undefined ? tools.length === 0 : !!options.fallbackNoTools;
  if (noTools) return { tools: [], noTools: true, disableMcp: true };

  const proxy = options.alwaysProxy ?? [];
  const parentMcp = mcpSelectors(parent);
  const childMcp = mcpSelectors(options.agentTools);
  let disableMcp = proxy.includes("--no-mcp");
  if (!disableMcp && parentMcp.length > 0 && options.agentTools !== undefined) {
    const resources = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
    if ([...(parent ?? []), ...options.agentTools].some((name) => resources.has(name))) {
      throw new Error("Cannot refine parent MCP allowlist with MCP resource tools; use server tool selectors instead.");
    }
    if (additive(options.agentTools) || tools?.some((name) => !name.startsWith("mcp__") && name.includes("*"))) {
      throw new Error("Cannot preserve parent MCP allowlist with additive or non-MCP wildcard child tools; use an explicit local tool list and MCP selectors.");
    }
    let selected = parentMcp;
    if (childMcp.length > 0) {
      const intersections = new Set<string>();
      for (const parentSelector of parentMcp) {
        for (const childSelector of childMcp) {
          const intersection = intersectPair(parentSelector, childSelector);
          if (intersection !== undefined) intersections.add(intersection);
        }
      }
      selected = [...intersections];
    }
    disableMcp = selected.length === 0;
    tools = [...options.agentTools.filter((name) => !name.startsWith("mcp__")), ...selected];
  }

  // Only supplement a parent's actually active native gateway. Do not force
  // load builtin:codemode: the child loader still owns disables/replacements.
  // Without an explicit selection, native MCP retains its activation policy.
  let excluded: string[] = [];
  for (let index = 0; index < proxy.length; index++) {
    // Native CLI consumes the value and replaces, rather than unions, repeated
    // denylist flags. Both spellings write the same final excludeTools option.
    if ((proxy[index] === "--exclude-tools" || proxy[index] === "-xt") && index + 1 < proxy.length) {
      excluded = split(proxy[++index]) ?? [];
    }
  }
  const removedCodemode = removesCodemode(parent) || removesCodemode(tools);
  const extensionsDisabled = proxy.includes("--no-extensions") || proxy.includes("-ne");
  const gatewayBlocked = disableMcp || extensionsDisabled || removedCodemode || excluded.some((pattern) => matches(pattern, "codemode"));
  const canSupplementGateway = options.parentNativeCodemodeActive === true && isStableSemverAtLeast(options.hostVersion, "1.1.0") && !gatewayBlocked;
  if (canSupplementGateway && tools !== undefined && !tools.includes("codemode") && !tools.includes("+codemode")) {
    const gatewaySelector = additive(tools) ? "+codemode" : "codemode";
    tools = [...tools, gatewaySelector];
  }
  return { tools, noTools: false, disableMcp };
}
