import type { CmuxCapabilities, CmuxConnectionIdentity, CmuxControlSocketClient } from "./cmux-control-socket.mjs";
export const CMUX_MINIMUM_APP_VERSION: "0.64.20";
export function matchingSupportedCmuxVersions(reportedVersion: unknown, bundleVersion: unknown, minimum?: string): string | null;
export function readCmuxAppBundleVersion(identify: Record<string, unknown>, minimum?: string): Promise<string | null>;
export function validateCmuxAppBundleVersion(identify: Record<string, unknown>, minimum?: string): Promise<boolean>;
export interface CmuxExpectedControl { transport: "cmux-control-v2"; socketPath: string; socketDev: string; socketIno: string; accessMode: string; apiVersion: 2; appVersion: string; identifyDigest: string; bootIdentity?: string; }
export interface CmuxControlManagerOptions { env?: NodeJS.ProcessEnv; capability?: string; password?: string; broker?: boolean; maxCallQueue?: number; expectedControl?: CmuxExpectedControl; appVersionValidator?: (identify: Record<string, unknown>, capabilities: Omit<CmuxCapabilities, "identify">) => boolean | Promise<boolean>; }
export type CmuxControlHandshake = CmuxCapabilities & { detectedAppVersion: string };
export class CmuxControlRequestManager { constructor(options?: CmuxControlManagerOptions); ensureReady(): Promise<CmuxControlHandshake>; call<T>(method: (client: CmuxControlSocketClient, handshake: CmuxControlHandshake) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>; identity(): CmuxConnectionIdentity | undefined; appVersion(): string | undefined; assertCurrentIdentity(): Promise<CmuxConnectionIdentity | undefined>; close(): void; }
export function getCmuxControlRequestManager(options?: CmuxControlManagerOptions): CmuxControlRequestManager;
export function resetCmuxControlRequestManagersForTest(): void;
export type CmuxCommandDiagnostic = { kind: "control"; code: string; state?: string; method?: string; remote?: true } | { kind: "adapter"; code: string };
export function diagnoseCmuxControlError(error: unknown): Extract<CmuxCommandDiagnostic, { kind: "control" }>;
export interface CmuxControlCommandResult { code: number; exitCode: number; stdout: string; stderr: string; aborted: boolean; dispatched?: boolean; diagnostic?: CmuxCommandDiagnostic; }
export function createCmuxControlCommandRunner(options?: CmuxControlManagerOptions & { manager?: CmuxControlRequestManager }): (args: string[], options?: { signal?: AbortSignal }) => Promise<CmuxControlCommandResult>;
