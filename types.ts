
// ============================================================
// LGD 群面模拟器 v0.7-tow 类型定义
// 对应 PRD 附录 A（角色卡）/ D（数据模型）/ E.5（报告结构）
// ============================================================

export type CharacterType = 'AGGRESSIVE' | 'STRUCTURED' | 'DETAIL';

/** 角色卡 persona（附录 A.1） */
export interface RolePersona {
  traits: string[];
  speaking_style: string;
  conflict_strategy: string;
  /** 协作倾向 0-1 */
  cooperation_level: number;
  /** 领导倾向 0-1 */
  leadership_tendency: number;
  /** 冲突等级：用于每场 1 高冲突 + 1 高协作 + 1 中立 的分配约束 */
  conflict_level: 'high' | 'medium' | 'low';
  /** 迁移自原 3 角色的性格文案（PRD F.0：prompt 资产不丢弃） */
  legacy_personality?: string;
  /** 迁移自原角色的 id（char1 张强 / char2 李雅 / char3 王敏） */
  legacy_id?: string;
  legacy_name?: string;
}

/** 角色卡 voice（附录 A.1，本期启用） */
export interface RoleVoice {
  provider: 'stepfun';
  voice_id: string;
  /** 语速倍率 */
  rate: number;
  emotion_default: string;
}

export interface RoleAvatar {
  preset_id: string;
  emotion_set: string[];
}

export interface RoleBehavior {
  speak_probability: number;
  interrupt_probability: number;
  /** 平均发言时长（秒） */
  avg_speak_duration: number;
  response_to_challenge: string;
  summary_tendency: number;
}

/** AI 角色卡（附录 A.1 字段结构，12 张首发） */
export interface RoleCard {
  id: string;
  name: string;
  industry: string;
  persona: RolePersona;
  voice: RoleVoice;
  avatar: RoleAvatar;
  behavior: RoleBehavior;
}

/** 预设形象（附录 D.3 avatars 表） */
export interface AvatarPreset {
  id: string;
  name: string;
  industry: string;
  type: 'preset' | 'uploaded';
  asset_url: string;
  viseme_asset_url?: string | null;
  emotion_asset_url?: string | null;
  default_voice_id: string;
  tags: string[];
}

/** 群面阶段（PRD 4.1.3 真实计时四阶段） */
export type PhaseId =
  | 'READING' | 'OPENING' | 'FREE_DISCUSSION' | 'SUMMARY'
  | 'SELF_INTRODUCTION' | 'INDIVIDUAL_THINKING' | 'GROUP_DISCUSSION'
  | 'PRESENTATION' | 'INTERVIEWER_QA' | 'REVERSE_QUESTION' | 'REVIEW';

export interface PhaseDef {
  id: PhaseId;
  /** 展示用阶段名 */
  label: string;
  /** 传递给 LLM 的阶段名（复用现有 prompt 资产） */
  promptPhase: string;
  /** 阶段时长（毫秒） */
  durationMs: number;
  /** 是否允许发言 */
  allowSpeech: boolean;
}

/** 发言权调度事件（events 表，PRD 4.1.4 / D.3） */
export type GameEventType =
  | 'stage_change' | 'interrupt' | 'yield' | 'speak_grant'
  | 'stage_start' | 'stage_end' | 'speaker_start' | 'speaker_end'
  | 'interviewer_prompt' | 'user_called' | 'report_start' | 'report_ready';

export interface GameEvent {
  event_type: GameEventType;
  actor: string;
  target: string;
  timestamp_ms: number;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: string;
  senderId: string; // 'user' 或角色卡 id
  senderName: string;
  content: string;
  timestamp: number;
  type: 'system' | 'message';
  /** v1.5：语音化后带时间戳（PRD D.2 transcripts） */
  startMs?: number;
  endMs?: number;
  confidence?: number;
  stepfunSegmentId?: string | null;
  /** 情绪（LLM emotion 字段，驱动 TTS instruction 与形象表情） */
  emotion?: string;
  phaseId?: PhaseId;
  participantType?: 'user' | 'candidate' | 'interviewer';
  turnIndex?: number;
  isInterruption?: boolean;
  isQuestion?: boolean;
  isAnswer?: boolean;
  isSummary?: boolean;
  replyToMessageId?: string;
  audioStatus?: 'pending' | 'transcribed' | 'played' | 'failed' | 'text_only';
}

export interface FeedbackData {
  timing: string;
  voiceShare: number; // 0-100
  structuralContribution: string;
  interruptionHandling: string;
  overallScore: number;
  suggestions: string[];
}

/** 证据池条目（PRD 7.3） */
export interface Evidence {
  id: string;
  modality: 'text' | 'voice' | 'visual' | 'event';
  timestamp_ms: number;
  content: string;
  dimension_hint: 'content' | 'voice' | 'visual' | 'stress' | 'teamwork';
  /** 关联消息序号（报告内定位） */
  message_index?: number;
}

/** 报告维度（PRD 附录 C，M3 过渡权重：内容 40 / 语音 25 / 抗压 20 / 协作 15） */
export interface DimensionScore {
  score: number;
  max: number;
  evidence: Evidence[];
  /** 规则引擎实算指标摘要 */
  metrics?: Record<string, number | string>;
  note?: string;
}

/** 面后报告 v1.5（PRD E.5） */
export interface ReportV15 {
  session_id: number | null;
  overall_score: number;
  performance_rank?: string;
  simulated_rank?: string;
  performance_level?: '领先' | '良好' | '待提升';
  dimensions: {
    content: DimensionScore;
    voice: DimensionScore;
    visual: DimensionScore & { status: 'not_enabled' | 'enabled' };
    stress: DimensionScore;
    teamwork: DimensionScore;
  };
  suggestions: string[];
  /** 旧 4 字段保留冗余展示（PRD D.2） */
  legacy?: FeedbackData;
  created_at?: string;
}

export interface SimulationState {
  topic: string;
  jobTitle: string;
  company: string;
  messages: Message[];
  status: 'IDLE' | 'BRIEFING' | 'PREPARING' | 'DISCUSSING' | 'INTERRUPTED' | 'FINISHED';
  activeCharacterId: string | null;
  round: number;
}
