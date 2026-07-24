/** Await settlements without letting a referenced timeout keep the process alive. */
export async function settleWithUnrefTimeout(
  settlements: Promise<unknown>[],
  settleMs: number,
  timers: { set: (callback: () => void, ms: number) => NodeJS.Timeout; clear: (timer: NodeJS.Timeout) => void } = { set: setTimeout, clear: clearTimeout },
): Promise<void> {
  if (settlements.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = timers.set(resolve, settleMs);
    timer.unref();
  });
  try {
    await Promise.race([Promise.allSettled(settlements).then(() => undefined), timeout]);
  } finally {
    if (timer) timers.clear(timer);
  }
}
