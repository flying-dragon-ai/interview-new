/**
 * DeepSeek 客户端（仅服务端，PRD D1 修复 + 4.1.1）
 * API Key 只从 process.env.DEEPSEEK_API_KEY 读取，前端永不持有。
 */

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-chat';

function getApiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key || !key.trim()) {
    throw new Error('DEEPSEEK_API_KEY 未配置（服务端环境变量）');
  }
  return key.trim();
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim());
}

/** 非流式调用 */
export async function callDeepSeek(prompt: string, temperature = 0.7): Promise<string> {
  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      stream: false,
    }),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '未知错误');
    throw new Error(`DeepSeek API 请求失败: ${response.status} ${response.statusText} - ${errorText}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('DeepSeek API 响应格式异常，未找到生成内容');
  }
  return content.trim();
}

/**
 * 流式调用，逐段回调。
 * @param onDelta 每收到一段文本
 * @param signal 中断信号（barge-in / 客户端断开）
 */
export async function callDeepSeekStream(
  prompt: string,
  temperature: number,
  onDelta: (chunk: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      stream: true,
    }),
    signal,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => '未知错误');
    throw new Error(`DeepSeek API 请求失败: ${response.status} ${response.statusText} - ${errorText}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('DeepSeek API 响应体不可读');

  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') return full;
          try {
            const data = JSON.parse(payload);
            const content = data.choices?.[0]?.delta?.content;
            if (typeof content === 'string') {
              full += content;
              onDelta(content);
            }
          } catch {
            // 忽略单条解析失败
          }
        }
      }
    }
    return full;
  } finally {
    reader.releaseLock();
  }
}
