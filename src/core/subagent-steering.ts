/** Small enough that worst-case JSON escaping still fits a lifecycle frame. */
export const MAX_STEERING_MESSAGE_BYTES = 512;
/** "submitted" is bounded child inbox admission, not native input queue or model application. */
export type SteeringOutcome = "submitted" | "rejected" | "unavailable" | "busy" | "unknown";
export type SteeringHandle = (message: string) => Promise<SteeringOutcome>;
export function isSteeringMessage(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= MAX_STEERING_MESSAGE_BYTES
    && Buffer.byteLength(value, "utf8") <= MAX_STEERING_MESSAGE_BYTES;
}
