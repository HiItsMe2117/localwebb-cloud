-- Add sources JSONB column to timeline events for document receipts
ALTER TABLE case_timeline_events ADD COLUMN IF NOT EXISTS sources JSONB;
