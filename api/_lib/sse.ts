/**
 * SSE 透传工具（PRD E.2：/api/llm SSE 流式）
 */

export interface SseWriter {
  send(event: string, data: unknown): void;
  close(): void;
  closed: boolean;
}

/** 在 VercelResponse 上创建 SSE 写入器 */
export function createSseWriter(res: {
  writeHead: (status: number, headers: Record<string, string>) => unknown;
  write: (chunk: string) => unknown;
  end: () => unknown;
  on?: (event: string, cb: () => void) => void;
  writableEnded?: boolean;
}): SseWriter {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const writer: SseWriter = {
    closed: false,
    send(event: string, data: unknown) {
      if (writer.closed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        writer.closed = true;
      }
    },
    close() {
      if (writer.closed) return;
      writer.closed = true;
      try {
        res.end();
      } catch {
        // 忽略
      }
    },
  };
  res.on?.('close', () => {
    writer.closed = true;
  });
  return writer;
}
