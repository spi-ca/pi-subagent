export type CmuxRequestState = "queued" | "connecting" | "writing" | "flushed" | "response-received";
export class CmuxControlSocketError extends Error { constructor(code: string, message: string, options?: { cause?: unknown; state?: CmuxRequestState; data?: unknown; remote?: boolean }); code: string; state?: CmuxRequestState; data?: unknown; remote?: boolean; }
export class CmuxUnknownOutcomeError extends CmuxControlSocketError { method: string; }
export interface CmuxConnectionIdentity { socketPath: string; socketDev: string; socketIno: string; }
export interface CmuxCapabilities { version: 2; protocol: "cmux-socket"; access_mode: string; methods: string[]; socket_path?: string; identify: Record<string, unknown>; connection?: CmuxConnectionIdentity; }
export interface CmuxControlSocketOptions { env?: NodeJS.ProcessEnv; password?: string; capability?: string; maxQueue?: number; timeoutMs?: number; }
export interface CmuxHandshakeOptions { requiredMethods?: readonly string[]; identify?: (identify: Record<string, unknown>, capabilities: Omit<CmuxCapabilities, "identify">) => boolean | Promise<boolean>; appVersionValidator?: (identify: Record<string, unknown>, capabilities: Omit<CmuxCapabilities, "identify">) => boolean | Promise<boolean>; }
export function configuredCmuxSocketPath(env?: NodeJS.ProcessEnv): string;
export function parseCmuxNdjsonLine(line: string): Record<string, unknown>;
export function parseCmuxUuidResult(result: unknown, fields: readonly string[], optionalFields?: Record<string, (value: unknown) => boolean>): Record<string, string>;
export const CMUX_UUID_RE: RegExp;
export const CMUX_REQUIRED_METHODS: readonly string[];
export class CmuxControlSocketClient {
 onNotification?: (line: Record<string, unknown>) => void;
 onTransportError?: (error: unknown) => void;
 constructor(options?: CmuxControlSocketOptions); connect(): Promise<this>; connectionIdentity(): CmuxConnectionIdentity | undefined; isConnected(): boolean; assertCurrentIdentity(): Promise<void>; handshake(options?: CmuxHandshakeOptions): Promise<CmuxCapabilities>; request(name: string, params?: Record<string, unknown>, options?: { mutation?: boolean; timeoutMs?: number }): Promise<unknown>; startEventStream(params: Record<string, unknown>): Promise<void>; close(): void;
 tree(): Promise<unknown>; split(params: { workspace_id: string; surface_id: string }): Promise<Record<string, string>>; create(params: { workspace_id: string; pane_id: string; working_directory: string }): Promise<Record<string, string>>; respawn(params: { workspace_id: string; surface_id: string; command: string; tmux_start_command: string }): Promise<Record<string, string>>; sendKey(params: { workspace_id: string; surface_id: string }): Promise<Record<string, string>>; closeSurface(params: { workspace_id: string; surface_id: string }): Promise<Record<string, string>>; focusSurface(params: { surface_id: string }): Promise<Record<string, string>>; tabAction(params: { action: "rename"; title: string }): Promise<{ action: "rename"; title: string }>;
}
export function connectCmuxControlSocket(options?: CmuxControlSocketOptions): Promise<CmuxControlSocketClient>;
export const cmuxControlMethods: Readonly<Record<string, string>>;
