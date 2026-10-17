-- MockSharp 群面记录扩展：阶段、参与者类型和轮次
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS phase_id VARCHAR(50);
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS participant_type VARCHAR(30);
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS turn_index INT;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS is_interruption BOOLEAN DEFAULT FALSE;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS is_question BOOLEAN DEFAULT FALSE;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS is_answer BOOLEAN DEFAULT FALSE;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS is_summary BOOLEAN DEFAULT FALSE;
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS reply_to_message_id VARCHAR(100);
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS audio_status VARCHAR(30);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS performance_rank VARCHAR(50);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS simulated_rank VARCHAR(50);
ALTER TABLE reports ADD COLUMN IF NOT EXISTS performance_level VARCHAR(30);
CREATE INDEX IF NOT EXISTS idx_transcripts_phase ON transcripts(session_id, phase_id, turn_index);
