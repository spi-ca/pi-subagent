export interface JsonLineChunkProcessor {
  pushChunk(chunk: string): void;
  flushRemainder(): void;
}

export function createJsonLineChunkProcessor(onLine: (line: string) => void): JsonLineChunkProcessor {
  let buffer = "";
  const flushText = (text: string) => {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) onLine(line);
    }
  };

  return {
    pushChunk(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    },
    flushRemainder() {
      if (buffer.trim()) {
        flushText(buffer);
        buffer = "";
      }
    },
  };
}

export interface PaneWatchState {
  abortDeadline: number | null;
  paneExitedAt: number | null;
  paneMissingAt: number | null;
  wasAborted: boolean;
  closeRequested: boolean;
  queryFailureCount: number;
}

export interface PaneWatchUpdateResult {
  state: PaneWatchState;
  shouldBreak: boolean;
  shouldClosePane: boolean;
  manualExitError?: string;
  exitCode?: number;
  queryFailed: boolean;
}

export interface MonitorZellijPaneLifecycleResult {
  statusSeen: boolean;
  wasAborted: boolean;
  manualExitError: string | null;
  exitCode?: number;
}

export function updatePaneWatchState(
  state: PaneWatchState,
  options: {
    now: number;
    abortWaitMs: number;
    signalAborted: boolean;
    paneInfo: undefined | null | { exited?: boolean; exitStatus?: number | null };
    paneId: string;
    maxQueryFailures?: number;
  },
): PaneWatchUpdateResult {
  const next: PaneWatchState = { ...state };
  let shouldClosePane = false;

  if (options.signalAborted) {
    next.wasAborted = true;
    shouldClosePane = !next.closeRequested;
    if (shouldClosePane) next.closeRequested = true;
    if (next.abortDeadline === null) {
      next.abortDeadline = options.now + options.abortWaitMs;
    }
  }

  if (options.paneInfo === undefined) {
    next.queryFailureCount += 1;
    const maxQueryFailures = options.maxQueryFailures ?? Infinity;
    return {
      state: next,
      shouldBreak:
        (next.abortDeadline !== null && options.now >= next.abortDeadline) ||
        next.queryFailureCount >= maxQueryFailures,
      shouldClosePane,
      manualExitError: next.queryFailureCount >= maxQueryFailures
        ? `Zellij pane ${options.paneId} could not be queried after ${next.queryFailureCount} attempts.`
        : undefined,
      queryFailed: true,
    };
  }

  next.queryFailureCount = 0;

  if (options.paneInfo === null) {
    next.paneExitedAt = null;
    next.paneMissingAt ??= options.now;
    if (options.now - next.paneMissingAt >= options.abortWaitMs) {
      return {
        state: next,
        shouldBreak: true,
        shouldClosePane,
        manualExitError: `Zellij pane ${options.paneId} closed before writing subagent status.`,
        queryFailed: false,
      };
    }
  } else {
    next.paneMissingAt = null;
    if (options.paneInfo.exited) {
      next.paneExitedAt ??= options.now;
      if (options.now - next.paneExitedAt >= options.abortWaitMs) {
        return {
          state: next,
          shouldBreak: true,
          shouldClosePane,
          manualExitError: `Zellij pane ${options.paneId} exited without writing subagent status.`,
          exitCode: typeof options.paneInfo.exitStatus === "number" ? options.paneInfo.exitStatus : undefined,
          queryFailed: false,
        };
      }
    } else {
      next.paneExitedAt = null;
    }
  }

  return {
    state: next,
    shouldBreak: next.abortDeadline !== null && options.now >= next.abortDeadline,
    shouldClosePane,
    queryFailed: false,
  };
}

export async function monitorZellijPaneLifecycle(options: {
  paneId: string;
  signal: AbortSignal | undefined;
  abortWaitMs: number;
  pollIntervalMs: number;
  fileExists: () => Promise<boolean>;
  getPaneInfo: () => Promise<undefined | null | { exited?: boolean; exitStatus?: number | null }>;
  closePane: () => Promise<boolean>;
  delay: (ms: number) => Promise<void>;
  now?: () => number;
  maxQueryFailures?: number;
}): Promise<MonitorZellijPaneLifecycleResult> {
  let state: PaneWatchState = {
    abortDeadline: null,
    paneExitedAt: null,
    paneMissingAt: null,
    wasAborted: false,
    closeRequested: false,
    queryFailureCount: 0,
  };

  while (true) {
    if (await options.fileExists()) {
      return {
        statusSeen: true,
        wasAborted: state.wasAborted,
        manualExitError: null,
      };
    }

    const paneInfo = await options.getPaneInfo();
    const watch = updatePaneWatchState(state, {
      now: options.now ? options.now() : Date.now(),
      abortWaitMs: options.abortWaitMs,
      signalAborted: Boolean(options.signal?.aborted),
      paneInfo,
      paneId: options.paneId,
      maxQueryFailures: options.maxQueryFailures,
    });
    state = watch.state;

    if (watch.shouldClosePane) {
      const closeSucceeded = await options.closePane();
      if (!closeSucceeded) state.closeRequested = false;
    }
    if (watch.manualExitError) {
      if (watch.queryFailed && await options.fileExists()) {
        return {
          statusSeen: true,
          wasAborted: state.wasAborted,
          manualExitError: null,
        };
      }
      return {
        statusSeen: false,
        wasAborted: state.wasAborted,
        manualExitError: watch.manualExitError,
        exitCode: watch.exitCode,
      };
    }
    if (watch.shouldBreak) {
      return {
        statusSeen: false,
        wasAborted: state.wasAborted,
        manualExitError: null,
      };
    }

    await options.delay(options.pollIntervalMs);
  }
}
