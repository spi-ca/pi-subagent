import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERSION } from "@earendil-works/pi-coding-agent";

const hostPackage = "@earendil-works/pi-coding-agent";
const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const graph = process.env.PI_GRAPH_EXPECTED === undefined
  ? manifest.devDependencies
  : JSON.parse(process.env.PI_GRAPH_EXPECTED);

// Match the exact selected CI lane, never silently skip a mismatched host.
export const SELECTED_PI_VERSION: string = graph[hostPackage];
assert.match(SELECTED_PI_VERSION, /^\d+\.\d+\.\d+$/);
export function assertSelectedPiHost(): void {
  assert.equal(VERSION, SELECTED_PI_VERSION, "offline host must match the selected exact Pi graph");
}
