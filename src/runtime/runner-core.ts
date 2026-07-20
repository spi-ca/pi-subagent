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
