export const MINIMUM_PI_VERSION: "0.80.10";
export const MINIMUM_CMUX_VERSION: "0.64.20";
export const MINIMUM_TMUX_VERSION: "3.7a";
export interface StableSemver { version: string; major: number; minor: number; patch: number }
export interface StableTmuxVersion { version: string; major: number; minor: number; suffix: string; suffixRank: number }
export function parseStableSemver(value: unknown): StableSemver | null;
export function compareStableSemver(left: string | StableSemver, right: string | StableSemver): number | null;
export function isStableSemverAtLeast(value: unknown, minimum: string | StableSemver): boolean;
export function parseStableTmuxVersion(value: unknown): StableTmuxVersion | null;
export function compareStableTmuxVersion(left: string | StableTmuxVersion, right: string | StableTmuxVersion): number | null;
export function isStableTmuxVersionAtLeast(value: unknown, minimum?: string | StableTmuxVersion): boolean;
export function parsePiVersionOutput(stdout: unknown): string | null;
export function parseCmuxVersionOutput(stdout: unknown): string | null;
export function parseTmuxVersionOutput(stdout: unknown): string | null;
