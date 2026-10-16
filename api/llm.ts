import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { RoleCard } from '../types';
import { findRoleCard } from '../data/roleCards.ts';
import { buildReplyPrompt, buildTopicPrompt, buildAnalysisPrompt, type HistoryItem, type ReplyPayload } from './_lib/prompts.ts';
import { callDeepSeek, callDeepSeekStream, isLlmConfigured } from './_lib/llm.ts';
import { createSseWriter } from './_lib/sse.ts';
import { checkRateLimit } from './_lib/ratelimit.ts';
import { extractJsonStringField, safeJsonParse } from './_lib/jsonStream.ts';
import { buildRuleReport, type LlmSemanticScores, type ReportInput } from '../engine/reportEngine.ts';
import type { Evidence, GameEvent, Message } from '../types';

/**
 * /api/llm —— DeepSeek 代理（PRD 4.1.1 / E.2）
 * action: topic（题目生成）| reply（角色发言）| feedback（旧 4 字段报告）| analyze（报告 v1.5）
 * SSE 流式透传；key 仅存服务端 env；服务端限流（Q-N2）。
 */

interface LlmRequestBody {
  action: 'topic' | 'reply' | 'feedback' | 'analyze';
  payload: Record<string, unknown>;
  stream?: boolean;
  session_id?: number | null;
}

function getClientIp(req: VercelRequest): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  if (Array.isArray(fwd)) return fwd[0];
  return req.socket?.remoteAddress;
}

function cleanTopicText(text: string): string {
  return text.replace(/[*#`>]/g, '').trim();
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const body = request.body as LlmRequestBody;
  if (!body || typeof body.action !== 'string') {
    return response.status(400).json({ error: '缺少 action 字段' });
  }

  // 限流（Q-N2）
  const limit = checkRateLimit(getClientIp(request), body.session_id ?? null);
  if (!limit.allowed) {
    return response.status(429).json({
      error: 'rate_limited',
      reason: limit.reason,
      retry_after_ms: limit.retryAfterMs,
    });
  }

  if (!isLlmConfigured()) {
    return response.status(500).json({ error: 'LLM_NOT_CONFIGURED', message: '服务端未配置 DEEPSEEK_API_KEY' });
  }

  const { action, payload, stream } = body;

  try {
    if (action === 'topic') {
      const company = String(payload.company ?? '');
      const jobTitle = String(payload.jobTitle ?? '');
      if (!company || !jobTitle) {
        return response.status(400).json({ error: 'company 与 jobTitle 必填' });
      }
      const prompt = buildTopicPrompt(company, jobTitle);

      if (stream) {
        const sse = createSseWriter(response);
        const controller = new AbortController();
        response.on?.('close', () => controller.abort());
        let full = '';
        try {
          full = await callDeepSeekStream(
            prompt,
            0.7,
            (chunk) => sse.send('delta', { delta: chunk }),
            controller.signal
          );
          const cleaned = cleanTopicText(full);
          sse.send('done', { content: cleaned || '题目生成失败，请手动输入。' });
        } catch (err) {
          sse.send('error', { message: err instanceof Error ? err.message : String(err) });
        } finally {
          sse.close();
        }
        return;
      }

      const full = await callDeepSeek(prompt, 0.7);
      return response.status(200).json({ content: cleanTopicText(full) || '题目生成失败，请手动输入。' });
    }

    if (action === 'reply') {
      const card = findRoleCard(String((payload.card as RoleCard | undefined)?.id ?? ''));
      if (!card) {
        return response.status(400).json({ error: '未知角色卡 id' });
      }
      const replyPayload: ReplyPayload = {
        card,
        topic: String(payload.topic ?? ''),
        jobTitle: String(payload.jobTitle ?? ''),
        history: (payload.history as HistoryItem[]) ?? [],
        phase: String(payload.phase ?? '开局框架阶段'),
        summaryGuided: Boolean(payload.summaryGuided),
        summaryVolunteered: Boolean(payload.summaryVolunteered),
        currentKeyPoint: (payload.currentKeyPoint as string | null) ?? null,
        keyPointDiscussionCount: typeof payload.keyPointDiscussionCount === 'number' ? payload.keyPointDiscussionCount : 0,
        allKeyPointsDiscussed: Boolean(payload.allKeyPointsDiscussed),
        allKeyPoints: (payload.allKeyPoints as string[]) ?? [],
        currentKeyPointIndex: typeof payload.currentKeyPointIndex === 'number' ? payload.currentKeyPointIndex : 0,
        voiceMode: Boolean(payload.voiceMode),
        phaseRemainingMs: typeof payload.phaseRemainingMs === 'number' ? payload.phaseRemainingMs : undefined,
      };
      const prompt = buildReplyPrompt(replyPayload);

      if (stream) {
        const sse = createSseWriter(response);
        const controller = new AbortController();
        response.on?.('close', () => controller.abort());
        let full = '';
        let sentLen = 0;
        try {
          full = await callDeepSeekStream(
            prompt,
            0.8,
            () => {
              // 边收边提取 content 字段增量（JSON 输出时的渐进显示）
              const value = extractJsonStringField(full, 'content');
              if (value !== null && value.length > sentLen) {
                sse.send('delta', { delta: value.slice(sentLen) });
                sentLen = value.length;
              } else if (extractJsonStringField(full, 'content') === null && full.trim() && !full.trim().startsWith('{')) {
                // 非 JSON 输出（文字版兜底）：直接透传增量
                sse.send('delta', { delta: full.slice(sentLen) });
                sentLen = full.length;
              }
            },
            controller.signal
          );
          const parsed = safeJsonParse<{ content?: string; emotion?: string; target?: string; stepfun_tts_instruction?: string }>(full);
          const content = (parsed?.content ?? full).trim() || '时间紧迫，我们必须尽快达成共识。';
          // 补齐未发送完的增量
          if (parsed?.content && parsed.content.length > sentLen) {
            sse.send('delta', { delta: parsed.content.slice(sentLen) });
          }
          sse.send('done', {
            content,
            emotion: parsed?.emotion ?? card.voice.emotion_default,
            target: parsed?.target ?? null,
            stepfun_tts_instruction: parsed?.stepfun_tts_instruction ?? null,
          });
        } catch (err) {
          sse.send('error', { message: err instanceof Error ? err.message : String(err) });
        } finally {
          sse.close();
        }
        return;
      }

      const full = await callDeepSeek(prompt, 0.8);
      const parsed = safeJsonParse<{ content?: string; emotion?: string; target?: string; stepfun_tts_instruction?: string }>(full);
      return response.status(200).json({
        content: (parsed?.content ?? full).trim() || '时间紧迫，我们必须尽快达成共识。',
        emotion: parsed?.emotion ?? card.voice.emotion_default,
        target: parsed?.target ?? null,
        stepfun_tts_instruction: parsed?.stepfun_tts_instruction ?? null,
      });
    }

    if (action === 'feedback') {
      // 旧 4 字段报告（PRD D.2：旧字段保留冗余展示）
      const topic = String(payload.topic ?? '');
      const jobTitle = String(payload.jobTitle ?? '');
      const history = (payload.history as HistoryItem[]) ?? [];
      const userCount = history.filter((m) => m.senderId === 'user').length;
      const voiceShare = history.length > 0 ? Math.round((userCount / history.length) * 100) : 0;

      const prompt = `作为专业面试官，请深度分析以下讨论中【用户】的表现。
岗位：${jobTitle}
题目：${topic}
全场对话记录：
${history.map((m) => `${m.senderName}: ${m.content}`).join('\n')}

评估维度：
1. **发言质量**：分析用户观点是否切中题目核心要害，是否提供了独特的洞察。
2. **结构贡献**：用户是否在确立框架、归纳共识、化解冲突上起到关键作用。
3. **时机掌握**：是否在合适的时机切入，发言是否过于碎片化。
4. **总结表现**：如果用户在最后阶段做了总结陈词，请给予高权重加分。
5. **抗压能力**：在被抢话或质疑时的反应。

请严格按以下 JSON 格式返回，不要包含任何其他文字或 Markdown 格式：
{
  "timing": "发言时机精准度分析（字符串）",
  "voiceShare": 0,
  "structuralContribution": "对讨论框架和进展的贡献评估（字符串）",
  "interruptionHandling": "在冲突和高压下的表现（字符串）",
  "overallScore": 0,
  "suggestions": ["改进建议1", "改进建议2", "改进建议3"]
}

注意：
- timing、structuralContribution、interruptionHandling 必须是字符串类型
- overallScore 必须是 0-100 之间的数字
- suggestions 必须是字符串数组，包含 3-5 条具体改进建议
- voiceShare 字段会被系统自动计算，你可以忽略它`;

      const full = await callDeepSeek(prompt, 0.3);
      const parsed = safeJsonParse<{
        timing?: string;
        structuralContribution?: string;
        interruptionHandling?: string;
        overallScore?: number;
        suggestions?: string[];
      }>(full);
      if (
        !parsed ||
        typeof parsed.timing !== 'string' ||
        typeof parsed.structuralContribution !== 'string' ||
        typeof parsed.interruptionHandling !== 'string' ||
        typeof parsed.overallScore !== 'number' ||
        !Array.isArray(parsed.suggestions)
      ) {
        return response.status(502).json({ error: 'LLM_RESPONSE_INVALID', message: 'AI 返回的 JSON 格式不完整' });
      }
      return response.status(200).json({
        timing: parsed.timing,
        voiceShare,
        structuralContribution: parsed.structuralContribution,
        interruptionHandling: parsed.interruptionHandling,
        overallScore: parsed.overallScore,
        suggestions: parsed.suggestions,
      });
    }

    if (action === 'analyze') {
      // 报告 v1.5：规则引擎 + LLM 语义分（PRD 4.1.7 / 7.4）
      const topic = String(payload.topic ?? '');
      const jobTitle = String(payload.jobTitle ?? '');
      const messages = (payload.messages as Message[]) ?? [];
      const events = (payload.events as GameEvent[]) ?? [];
      const sessionStartAt = typeof payload.sessionStartAt === 'number' ? payload.sessionStartAt : Date.now();
      const durationMs = typeof payload.durationMs === 'number' ? payload.durationMs : 25 * 60 * 1000;

      const input: ReportInput = { transcripts: messages, events, sessionStartAt, durationMs };
      const userTranscripts = messages
        .filter((m) => m.senderId === 'user' && m.type === 'message')
        .map((m) => ({ content: m.content, timestampMs: Math.max(0, m.timestamp - sessionStartAt) }));

      let llm: LlmSemanticScores | undefined;
      if (userTranscripts.length > 0) {
        try {
          const full = await callDeepSeek(buildAnalysisPrompt(topic, userTranscripts), 0.3);
          const parsed = safeJsonParse<LlmSemanticScores & { evidence?: { content: string; timestamp_ms: number }[] }>(full);
          if (parsed) {
            llm = {
              structureScore: parsed.structureScore,
              responseQuality: parsed.responseQuality,
              stressResponseQuality: parsed.stressResponseQuality,
              conflictHandling: parsed.conflictHandling,
              supportOthers: parsed.supportOthers,
              coordinateOthers: parsed.coordinateOthers,
              extraEvidence: (parsed.evidence ?? []).map((e, i) => ({
                id: `ev_llm_${i + 1}`,
                modality: 'text' as const,
                timestamp_ms: e.timestamp_ms,
                content: e.content,
                dimension_hint: 'content' as const,
              })),
            };
          }
        } catch (err) {
          console.error('analyze LLM 调用失败，退回规则引擎:', err);
        }
      }
      const report = buildRuleReport(input, llm);
      report.session_id = typeof payload.session_id === 'number' ? payload.session_id : null;
      return response.status(200).json(report);
    }

    return response.status(400).json({ error: `未知 action: ${action}` });
  } catch (err) {
    console.error('/api/llm error:', err);
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('DEEPSEEK_API_KEY') ? 500 : 502;
    return response.status(status).json({ error: 'LLM_CALL_FAILED', message });
  }
}
