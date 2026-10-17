-- v0.7.1：Q-N1 免登录用户标识（Para 钱包地址）
-- 前置：db/migration-v0.7.sql 已执行（sessions 表存在）
-- 幂等：可重复执行

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(42);

CREATE INDEX IF NOT EXISTS idx_sessions_wallet ON sessions(wallet_address);

-- 说明：
-- - wallet_address 统一小写存储（api/_lib/wallet.ts normalizeWalletAddress）
-- - 匿名练习保持 NULL；连接 Para 钱包后的会话按地址归档
-- - 历史列表：GET /api/session?wallet_address=0x…
