-- MockSharp 风格题库与匿名练习扩展
CREATE TABLE IF NOT EXISTS questions (
  id VARCHAR(100) PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  industry VARCHAR(50) NOT NULL,
  target_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  question_type VARCHAR(50) NOT NULL,
  audience VARCHAR(100),
  product_form VARCHAR(100),
  difficulty VARCHAR(30) NOT NULL DEFAULT 'standard',
  source_type VARCHAR(30) NOT NULL DEFAULT 'curated_bank',
  estimated_duration INT NOT NULL DEFAULT 35,
  status VARCHAR(20) NOT NULL DEFAULT 'published',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS question_attempts (
  id BIGSERIAL PRIMARY KEY,
  question_id VARCHAR(100) REFERENCES questions(id),
  session_id BIGINT REFERENCES sessions(id),
  anonymous_id VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS question_favorites (
  id BIGSERIAL PRIMARY KEY,
  question_id VARCHAR(100) REFERENCES questions(id),
  anonymous_id VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(question_id, anonymous_id)
);

CREATE INDEX IF NOT EXISTS idx_questions_filter ON questions(industry, question_type, difficulty, status);
CREATE INDEX IF NOT EXISTS idx_attempts_anonymous ON question_attempts(anonymous_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_favorites_anonymous ON question_favorites(anonymous_id, created_at DESC);
