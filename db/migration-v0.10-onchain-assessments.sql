-- User-consented Monad credential transaction index. Raw transcripts/reports are never stored here.
CREATE TABLE IF NOT EXISTS onchain_assessments (
  id BIGSERIAL PRIMARY KEY,
  session_id BIGINT REFERENCES sessions(id) ON DELETE SET NULL,
  wallet_address VARCHAR(42) NOT NULL,
  session_hash VARCHAR(66) NOT NULL,
  score_hash VARCHAR(66) NOT NULL,
  overall_score SMALLINT NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  skill_hashes JSONB NOT NULL DEFAULT '[]'::jsonb,
  chain_id INTEGER NOT NULL,
  contract_address VARCHAR(42) NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  token_id NUMERIC(78, 0),
  status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, contract_address, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_onchain_assessments_session ON onchain_assessments(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_onchain_assessments_wallet ON onchain_assessments(wallet_address, created_at DESC);
