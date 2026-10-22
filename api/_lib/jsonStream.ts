/**
 * JSON 流式字段提取（/api/llm reply action 流式透传用）
 * LLM 以 JSON 输出（F.1），服务端边收边提取 content 字段增量转发，
 * 结束后解析完整 JSON 取 emotion / target / stepfun_tts_instruction。
 */

/** 解析 JSON 字符串字面量（处理转义），到 pos 处结束；不完整返回 null */
function parseJsonStringAt(text: string, start: number): { value: string; end: number; partial?: boolean } | null {
  // text[start] 必须是 '"'
  if (text[start] !== '"') return null;
  let out = '';
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) return null; // 转义序列不完整
      switch (next) {
        case 'n':
          out += '\n';
          break;
        case 't':
          out += '\t';
          break;
        case 'r':
          out += '\r';
          break;
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'u': {
          const hex = text.slice(i + 2, i + 6);
          if (hex.length < 4) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default:
          out += next;
      }
      i += 2;
      continue;
    }
    if (ch === '"') {
      return { value: out, end: i + 1 };
    }
    out += ch;
    i += 1;
  }
  // 到达缓冲区末尾仍未闭合：返回已解析的部分值（流式渐进显示用）
  return { value: out, end: text.length, partial: true };
}

/**
 * 从可能不完整的 JSON 缓冲区中提取指定字符串字段的当前值。
 * 返回 null 表示字段尚未出现；字符串未闭合时返回已解析的部分值。
 */
export function extractJsonStringField(buffer: string, field: string): string | null {
  const keyPattern = new RegExp(`"${field}"\\s*:\\s*`);
  const match = keyPattern.exec(buffer);
  if (!match) return null;
  const valueStart = match.index + match[0].length;
  const parsed = parseJsonStringAt(buffer, valueStart);
  if (!parsed) return null;
  return parsed.value;
}

/** 已提取长度（用于计算增量） */
export function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    // 尝试截取第一个 { 到最后一个 }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * 增量式 JSON 字符串字段读取器（/api/llm reply 流式透传用）。
 * 相比逐 chunk 重跑 extractJsonStringField(fullBuffer)：
 * - key 定位一次后缓存游标（不再每 chunk 全量正则）；
 * - 记录已发送长度，只返回新增增量；
 * - flushTail() 在流结束后补齐未发送的剩余值。
 */
export interface IncrementalStringFieldReader {
  /** 追加流片段；返回新暴露的增量（无新增为空串；key 未出现为 null） */
  push(chunk: string): string | null;
  /** 流结束：补发剩余未发送的值（无则空串） */
  flushTail(): string;
}

export function createStringFieldReader(field: string): IncrementalStringFieldReader {
  const keyPattern = new RegExp(`"${field}"\\s*:\\s*`);
  let acc = '';
  let searchFrom = 0;
  let keyEnd = -1;
  let sentLen = 0;
  let valueDone = false;

  const parseCurrent = (): { value: string; partial: boolean } | null => {
    const parsed = parseJsonStringAt(acc, keyEnd);
    if (!parsed) return null;
    return { value: parsed.value, partial: Boolean(parsed.partial) };
  };

  return {
    push(chunk) {
      if (valueDone) return '';
      acc += chunk;
      if (keyEnd < 0) {
        const m = keyPattern.exec(acc.slice(searchFrom));
        if (!m) {
          // 只回退一个 key 可能被截断的窗口，避免全量重扫
          searchFrom = Math.max(0, acc.length - field.length - 16);
          return null;
        }
        keyEnd = searchFrom + m.index + m[0].length;
      }
      const cur = parseCurrent();
      if (!cur) return null;
      const delta = cur.value.length > sentLen ? cur.value.slice(sentLen) : '';
      sentLen = cur.value.length;
      if (!cur.partial) valueDone = true;
      return delta;
    },
    flushTail() {
      if (keyEnd < 0 || valueDone) return '';
      const cur = parseCurrent();
      if (!cur) return '';
      const tail = cur.value.slice(sentLen);
      sentLen = cur.value.length;
      return tail;
    },
  };
}
