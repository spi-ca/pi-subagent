/** Small enough that worst-case JSON escaping still fits a lifecycle frame. */
export const MAX_STEERING_MESSAGE_BYTES = 512;
/** "submitted" is remote inbox admission, not local waiting or model application.
 * "queue-full" is local only; remote boolean rejection stays generic. */
export type SteeringOutcome = "submitted" | "rejected" | "unavailable" | "busy" | "queue-full" | "unknown";
export type SteeringHandle = (message: string, eligible?: () => boolean) => Promise<SteeringOutcome>;
export function isSteeringMessage(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= MAX_STEERING_MESSAGE_BYTES
    && Buffer.byteLength(value, "utf8") <= MAX_STEERING_MESSAGE_BYTES;
}
