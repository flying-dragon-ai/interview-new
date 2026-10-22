import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { RoleCard } from '../types';
import { findRoleCard } from '../data/roleCards.ts';
import { HOST_CARD, isHostCard } from '../data/interviewerCards.ts';
import { buildReplyPrompt, buildHostPrompt, buildPanelInterviewerPrompt, buildTopicPrompt, buildAnalysisPrompt, buildFeedbackPrompt, type HistoryItem, type ReplyPayload } from './_lib/prompts.ts';
import { callDeepSeek, callDeepSeekStream, isLlmConfigured } from './_lib/llm.ts';
import { createSseWriter } from './_lib/sse.ts';
import { checkRateLimit } from './_lib/ratelimit.ts';
import { safeJsonParse, createStringFieldReader } from './_lib/jsonStream.ts';
import { runAnalysis } from './_lib/analyze.ts';
import { getClientIp } from './_lib/http.ts';
import type { GameEvent, Message } from '../types';

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
            controller.signal,
            'topic'
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

      const full = await callDeepSeek(prompt, 0.7, 'topic');
      return response.status(200).json({ content: cleanTopicText(full) || '题目生成失败，请手动输入。' });
    }

    if (action === 'reply') {
      const requestedId = String((payload.card as RoleCard | undefined)?.id ?? '');
      // 主持面试官不在 12 张候选人卡池内，单独解析
      const card = isHostCard(requestedId) ? HOST_CARD : findRoleCard(requestedId);
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
        speakerKind:
          payload.speakerKind === 'host' || payload.speakerKind === 'interviewer' ? payload.speakerKind : 'candidate',
        phaseRemainingMs: typeof payload.phaseRemainingMs === 'number' ? payload.phaseRemainingMs : undefined,
      };
      const prompt =
        replyPayload.speakerKind === 'host'
          ? buildHostPrompt(replyPayload)
          : replyPayload.speakerKind === 'interviewer'
            ? buildPanelInterviewerPrompt(replyPayload)
            : buildReplyPrompt(replyPayload);

      if (stream) {
        const sse = createSseWriter(response);
        const controller = new AbortController();
        response.on?.('close', () => controller.abort());
        let full = '';
        // 边收边提取 content 字段增量（JSON 输出）；非 JSON 输出直接透传（文字版兜底）
        const reader = createStringFieldReader('content');
        let mode: 'detect' | 'json' | 'raw' = 'detect';
        let rawAcc = '';
        try {
          full = await callDeepSeekStream(
            prompt,
            0.8,
            (chunk) => {
              if (mode === 'detect') {
                rawAcc += chunk;
                const t = rawAcc.trimStart();
                if (!t) return;
                if (t.startsWith('{')) {
                  mode = 'json';
                  const first = reader.push(rawAcc);
                  if (first) sse.send('delta', { delta: first });
                } else {
                  mode = 'raw';
                  sse.send('delta', { delta: rawAcc });
                }
                return;
              }
              if (mode === 'raw') {
                sse.send('delta', { delta: chunk });
                return;
              }
              const delta = reader.push(chunk);
              if (delta) sse.send('delta', { delta });
            },
            controller.signal,
            'reply'
          );
          const parsed = safeJsonParse<{ content?: string; emotion?: string; target?: string; stepfun_tts_instruction?: string }>(full);
          const content = (parsed?.content ?? full).trim() || '时间紧迫，我们必须尽快达成共识。';
          // 补齐未发送完的增量（done 事件携带全量，前端以 done 为准）
          const tail = reader.flushTail();
          if (tail) sse.send('delta', { delta: tail });
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

      const full = await callDeepSeek(prompt, 0.8, 'reply');
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

      const prompt = buildFeedbackPrompt(topic, jobTitle, history);

      const full = await callDeepSeek(prompt, 0.3, 'feedback');
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
      // 报告 v1.5：规则引擎 + LLM 语义分（PRD 4.1.7 / 7.4）——与 /api/sessions/{id}/analyze 共用 runAnalysis
      const report = await runAnalysis({
        topic: String(payload.topic ?? ''),
        transcripts: (payload.messages as Message[]) ?? [],
        events: (payload.events as GameEvent[]) ?? [],
        sessionStartAt: typeof payload.sessionStartAt === 'number' ? payload.sessionStartAt : Date.now(),
        durationMs: typeof payload.durationMs === 'number' ? payload.durationMs : 25 * 60 * 1000,
        visualRows: Array.isArray(payload.visual_rows) ? (payload.visual_rows as import('../types').VisualFeatureRow[]) : [],
      });
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
