-- v0.8：会话阵型列（lgd = 1 面试官 + 4 候选人含我；panel = 3 面试官 + 1 候选人）
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'lgd';
