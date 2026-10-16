-- ============================================================
-- LGD 群面模拟器 v0.7-tow 数据库迁移（PRD 附录 D）
-- 在现状库（阿里云 RDS PG interview_db）上增量迁移；数值主键沿用，不迁 UUID。
-- 执行前务必确认已完成 D1/D2 凭据轮换（旧凭据视为已泄露）。
-- 用法：psql "$DATABASE_URL" -f db/migration-v0.7.sql
-- ============================================================

-- ---- D.2 迁移映射 ----

-- simulation_sessions → sessions（加列）
ALTER TABLE simulation_sessions RENAME TO sessions;
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS topic_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS roles JSONB,
  ADD COLUMN IF NOT EXISTS voice_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS camera_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP;

-- conversation_records → transcripts（加列；speaker 由 speaker_type/speaker_id 合并）
ALTER TABLE conversation_records RENAME TO transcripts;
ALTER TABLE transcripts
  ADD COLUMN IF NOT EXISTS start_ms INT,
  ADD COLUMN IF NOT EXISTS end_ms INT,
  ADD COLUMN IF NOT EXISTS confidence FLOAT,
  ADD COLUMN IF NOT EXISTS stepfun_segment_id VARCHAR(100);
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS speaker VARCHAR(50);
UPDATE transcripts SET speaker = CASE WHEN speaker_type = 'user' THEN 'user' ELSE speaker_id END WHERE speaker IS NULL;

-- feedback_reports → reports（加 JSONB 列；旧 4 字段保留冗余展示）
ALTER TABLE feedback_reports RENAME TO reports;
ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS dimension_scores JSONB,
  ADD COLUMN IF NOT EXISTS evidence_pool JSONB;
-- suggestions 统一转 JSONB
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'reports' AND column_name = 'suggestions' AND data_type <> 'jsonb'
  ) THEN
    ALTER TABLE reports ALTER COLUMN suggestions TYPE JSONB USING to_jsonb(suggestions);
  END IF;
END $$;

-- ---- 新增表 ----

-- 事件日志（打断/阶段切换/发言权归属，PRD 4.1.4）
CREATE TABLE IF NOT EXISTS events (
    id SERIAL PRIMARY KEY,
    session_id INT REFERENCES sessions(id),
    event_type VARCHAR(50),   -- stage_change | interrupt | yield | speak_grant
    actor VARCHAR(50),
    target VARCHAR(50),
    timestamp_ms INT,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 视觉聚合特征（P1 M6 启用，每秒一条；原始视频 0 字节上传）
CREATE TABLE IF NOT EXISTS visual_features (
    id SERIAL PRIMARY KEY,
    session_id INT REFERENCES sessions(id),
    timestamp_ms INT,
    eye_contact FLOAT,
    emotion VARCHAR(20),
    head_pose JSONB,
    engagement FLOAT
);

-- 预设形象库（PRD 4.1.8）
CREATE TABLE IF NOT EXISTS avatars (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100),
    industry VARCHAR(50),
    type VARCHAR(20),           -- preset | uploaded
    asset_url TEXT,
    viseme_asset_url TEXT,
    emotion_asset_url TEXT,
    default_voice_id VARCHAR(100),
    tags JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ---- 索引 ----
CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_visual_session ON visual_features(session_id, timestamp_ms);
CREATE INDEX IF NOT EXISTS idx_avatars_industry ON avatars(industry);

-- ---- D3：users 表冻结（免登录期不删除数据、不新增写入）----
COMMENT ON TABLE users IS 'FROZEN: 登录已移除（D3），免登录期冻结，不新增写入';
