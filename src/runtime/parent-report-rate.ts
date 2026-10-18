/** Bounded per-child sliding window. Attempts charge only at actual transport
 * dispatch/admission, including remote rejection; UNSENT work is free. */
export const PARENT_REPORT_RATE_LIMIT = 16;
export const PARENT_REPORT_RATE_WINDOW_MS = 30_000;
export class ParentReportRate {
  private readonly sent: number[] = [];
  constructor(private readonly now: () => number = () => performance.now()) {}
  available(): boolean {
    const cutoff = this.now() - PARENT_REPORT_RATE_WINDOW_MS;
    while (this.sent.length && this.sent[0]! <= cutoff) this.sent.shift();
    return this.sent.length < PARENT_REPORT_RATE_LIMIT;
  }
  take(): boolean {
    if (!this.available()) return false;
    this.sent.push(this.now());
    return true;
  }
}
