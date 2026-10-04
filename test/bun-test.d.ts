declare module "bun:test" {
	export { afterEach, describe, test } from "node:test";
	export namespace jest {
		function useFakeTimers(options?: { now?: number | Date }): typeof jest;
		function useRealTimers(): typeof jest;
		function advanceTimersByTime(milliseconds: number): typeof jest;
	}
}
