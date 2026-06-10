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
  },
): PaneWatchUpdateResult {
  const next: PaneWatchState = { ...state };
  let shouldClosePane = false;

  if (options.signalAborted) {
    next.wasAborted = true;
    shouldClosePane = true;
    if (next.abortDeadline === null) {
      next.abortDeadline = options.now + options.abortWaitMs;
    }
  }

  if (options.paneInfo === undefined) {
    return {
      state: next,
      shouldBreak: next.abortDeadline !== null && options.now >= next.abortDeadline,
      shouldClosePane,
      queryFailed: true,
    };
  }

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
  closePane: () => Promise<void>;
  delay: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<MonitorZellijPaneLifecycleResult> {
  let state: PaneWatchState = {
    abortDeadline: null,
    paneExitedAt: null,
    paneMissingAt: null,
    wasAborted: false,
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
    });
    state = watch.state;

    if (watch.shouldClosePane) {
      await options.closePane();
    }
    if (watch.manualExitError) {
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
