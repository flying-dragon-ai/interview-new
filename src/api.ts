const API_BASE = '/api';

/**
 * 持久化客户端（PRD 4.1.4 / 4.1.9 / E.1-E.2）
 * 数据库未配置时各接口返回 503，调用方按「本地模式」降级，不阻断模拟。
 */

export interface Session {
  id: number;
  company: string;
  job_title: string;
  topic: string;
  topic_type?: string;
  roles?: unknown;
  voice_enabled?: boolean;
  camera_enabled?: boolean;
  status: string;
  created_at: string;
  started_at?: string;
  ended_at?: string;
  finished_at?: string;
  wallet_address?: string | null;
}

export interface MessageRecord {
  id: number;
  session_id: number;
  speaker?: string;
  speaker_type: string;
  speaker_id: string;
  speaker_name: string;
  message: string;
  round: number;
  start_ms?: number | null;
  end_ms?: number | null;
  confidence?: number | null;
  created_at: string;
}

async function parseJson<T>(res: Response): Promise<T | null> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function generateInterviewTopic(params: { industry: string; company: string; jobTitle: string; topicType: string }): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/llm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'topic', payload: params }) });
    const data = await parseJson<{ content?: string }>(res);
    return res.ok ? data?.content?.trim() || null : null;
  } catch { return null; }
}

// 创建会话（roles 为角色卡 id 列表）
export async function createSession(params: {
  company: string;
  jobTitle: string;
  topic: string;
  topicType?: string;
  roles?: string[];
  voiceEnabled?: boolean;
  cameraEnabled?: boolean;
  userId?: number | null;
  /** Q-N1：Para 钱包地址（0x…42 字符），免登录用户标识；匿名时传 null */
  walletAddress?: string | null;
}): Promise<Session | null> {
  try {
    const res = await fetch(`${API_BASE}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: params.company,
        job_title: params.jobTitle,
        topic: params.topic,
        topic_type: params.topicType ?? 'business_case',
        roles: params.roles ?? [],
        voice_enabled: params.voiceEnabled ?? false,
        camera_enabled: params.cameraEnabled ?? false,
        user_id: params.userId ?? null,
        wallet_address: params.walletAddress ?? null,
      }),
    });
    if (!res.ok) return null;
    return await parseJson<Session>(res);
  } catch {
    return null; // 本地模式：无数据库也能模拟
  }
}

export async function updateSessionStatus(sessionId: number, status: string): Promise<Session | null> {
  try {
    const res = await fetch(`${API_BASE}/session`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, status }),
    });
    if (!res.ok) return null;
    return await parseJson<Session>(res);
  } catch {
    return null;
  }
}

export async function syncQuestionFavorite(questionId: string, favorited: boolean): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/questions/${encodeURIComponent(questionId)}/favorite`, { method: favorited ? 'POST' : 'DELETE' });
    return res.ok;
  } catch {
    return false;
  }
}

// 删除会话及全部记录（隐私：TC-11 不可恢复）
export async function deleteSession(sessionId: number): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/session`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function saveMessage(params: {
  sessionId: number;
  speaker: string;
  speakerType: 'user' | 'ai';
  speakerId: string;
  speakerName: string;
  message: string;
  round: number;
  startMs?: number;
  endMs?: number;
  confidence?: number;
  stepfunSegmentId?: string | null;
  phaseId?: string;
  participantType?: 'user' | 'candidate' | 'interviewer';
  turnIndex?: number;
  isInterruption?: boolean;
  isQuestion?: boolean;
  isAnswer?: boolean;
  isSummary?: boolean;
  replyToMessageId?: string | null;
  audioStatus?: string | null;
}): Promise<MessageRecord | null> {
  try {
    const res = await fetch(`${API_BASE}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: params.sessionId,
        speaker: params.speaker,
        speaker_type: params.speakerType,
        speaker_id: params.speakerId,
        speaker_name: params.speakerName,
        message: params.message,
        round: params.round,
        start_ms: params.startMs,
        end_ms: params.endMs,
        confidence: params.confidence,
        stepfun_segment_id: params.stepfunSegmentId ?? null,
        phase_id: params.phaseId ?? null,
        participant_type: params.participantType ?? (params.speakerType === 'user' ? 'user' : 'candidate'),
        turn_index: params.turnIndex ?? params.round,
        is_interruption: params.isInterruption ?? false,
        is_question: params.isQuestion ?? false,
        is_answer: params.isAnswer ?? false,
        is_summary: params.isSummary ?? false,
        reply_to_message_id: params.replyToMessageId ?? null,
        audio_status: params.audioStatus ?? null,
      }),
    });
    if (!res.ok) return null;
    return await parseJson<MessageRecord>(res);
  } catch {
    return null;
  }
}

export async function getMessages(sessionId: number): Promise<MessageRecord[]> {
  try {
    const res = await fetch(`${API_BASE}/message?session_id=${sessionId}`);
    if (!res.ok) return [];
    return (await parseJson<MessageRecord[]>(res)) ?? [];
  } catch {
    return [];
  }
}

export async function getPracticeHistory(): Promise<Session[]> {
  try {
    const res = await fetch(`${API_BASE}/practice-history`);
    if (!res.ok) return [];
    return (await parseJson<Session[]>(res)) ?? [];
  } catch { return []; }
}

export async function getPracticeReview(practiceId: number): Promise<{ session: Session | null; messages: MessageRecord[]; events: import('../types').GameEvent[]; report: unknown }> {
  try {
    const res = await fetch(`${API_BASE}/practice/${practiceId}/review`);
    if (!res.ok) return { session: null, messages: [], events: [], report: null };
    return (await parseJson<{ session: Session | null; messages: MessageRecord[]; events: import('../types').GameEvent[]; report: unknown }>(res)) ?? { session: null, messages: [], events: [], report: null };
  } catch { return { session: null, messages: [], events: [], report: null }; }
}

// 事件日志批量入库（PRD 4.1.4）
export async function saveEvents(
  sessionId: number,
  events: import('../types').GameEvent[]
): Promise<boolean> {
  if (!sessionId || events.length === 0) return false;
  try {
    const res = await fetch(`${API_BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, events }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// 保存报告 v1.5（reports JSONB 列）
export async function saveReport(params: {
  sessionId: number;
  report: import('../types').ReportV15;
  legacy?: import('../types').FeedbackData;
}): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: params.sessionId,
        overall_score: params.report.overall_score,
        performance_rank: params.report.performance_rank,
        simulated_rank: params.report.simulated_rank,
        performance_level: params.report.performance_level,
        dimension_scores: params.report.dimensions,
        evidence_pool: [
          ...params.report.dimensions.content.evidence,
          ...params.report.dimensions.stress.evidence,
          ...params.report.dimensions.teamwork.evidence,
        ],
        suggestions: params.report.suggestions,
        timing: params.legacy?.timing ?? null,
        voice_share: params.legacy?.voiceShare ?? null,
        structural_contribution: params.legacy?.structuralContribution ?? null,
        interruption_handling: params.legacy?.interruptionHandling ?? null,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 保存已确认的链上交易索引；任何原始对话或完整报告字段都不会发送。 */
export async function recordOnchainAssessment(params: {
  sessionId: number | null;
  walletAddress: string;
  sessionHash: `0x${string}`;
  scoreHash: `0x${string}`;
  overallScore: number;
  skillHashes: `0x${string}`[];
  chainId: number;
  contractAddress: `0x${string}`;
  txHash: `0x${string}`;
  tokenId: string | null;
}): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'record_onchain_assessment',
        session_id: params.sessionId,
        wallet_address: params.walletAddress,
        session_hash: params.sessionHash,
        score_hash: params.scoreHash,
        overall_score: params.overallScore,
        skill_hashes: params.skillHashes,
        chain_id: params.chainId,
        contract_address: params.contractAddress,
        tx_hash: params.txHash,
        token_id: params.tokenId,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function getFeedback(sessionId: number) {
  try {
    const res = await fetch(`${API_BASE}/feedback?session_id=${sessionId}`);
    if (!res.ok) return null;
    return await parseJson<unknown>(res);
  } catch {
    return null;
  }
}

// 触发服务端面后分析（/api/sessions/{id}/analyze）
export async function triggerAnalyze(sessionId: number): Promise<import('../types').ReportV15 | null> {
  try {
    const res = await fetch(`${API_BASE}/sessions/${sessionId}/analyze`, { method: 'POST' });
    if (!res.ok) return null;
    return await parseJson<import('../types').ReportV15>(res);
  } catch {
    return null;
  }
}

// 预设形象列表
export async function getAvatarPresets(): Promise<import('../types').AvatarPreset[]> {
  try {
    const res = await fetch(`${API_BASE}/avatars/presets`);
    if (!res.ok) return [];
    const data = await parseJson<{ presets: import('../types').AvatarPreset[] }>(res);
    return data?.presets ?? [];
  } catch {
    return [];
  }
}
