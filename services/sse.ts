/**
 * SSE 客户端解析（前端共用：geminiService / voiceService）
 * 解析 event:/data: 块流，逐事件回调；单条解析失败忽略，不断流。
 */

/** 从 SSE 块文本中解析单个事件块 */
function parseBlock(block: string): { event: string; data: Record<string, unknown> } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as Record<string, unknown> };
  } catch {
    return null; // 单条解析失败忽略
  }
}

/** 读取 SSE 响应体，逐事件回调 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: Record<string, unknown>) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        if (!block.trim()) continue;
        const parsed = parseBlock(block);
        if (parsed) onEvent(parsed.event, parsed.data);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 便捷封装：直接消费 fetch Response */
export async function readSseResponse(
  res: Response,
  onEvent: (event: string, data: Record<string, unknown>) => void
): Promise<void> {
  if (!res.body) throw new Error('SSE 响应体不可读');
  await readSseStream(res.body, onEvent);
}
