export type Phase0LiveTelemetryBackend = "cmux" | "tmux";
export type Phase0LiveTelemetryMetric = "backendRequests" | "backendSpawns" | "requestBacklogHighWater" | "lineBacklogHighWater" | "byteBacklogHighWater" | "controlDisconnects" | "reconnects" | "unknownOutcomes" | "exactSnapshots" | "exactCleanupMutations" | "residualRecovery" | "persistentClientCreates" | "persistentClientRestarts" | "healthyPeriodicStatusQueries" | "notificationToReconcileLatencyMs" | "lifecycleCompletionLatencyMs";
export const PHASE0_LIVE_TELEMETRY_DIR_ENV: "PI_SUBAGENT_PHASE0_LIVE_TELEMETRY_DIR";
export const PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV: "PI_SUBAGENT_PHASE0_LIVE_TELEMETRY_CAPABILITY";
export const PHASE0_LIVE_TELEMETRY_GATE_ENV: "PI_SUBAGENT_PHASE0_LIVE";
export function recordPhase0LiveTelemetry(backend: Phase0LiveTelemetryBackend, metric: Phase0LiveTelemetryMetric, value?: number, reason?: string): boolean;
export function phase0LiveTelemetryEnabled(env?: NodeJS.ProcessEnv): boolean;
export function closePhase0LiveTelemetryForTest(): void;
