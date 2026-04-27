-- Add tags to timeline events for better filtering and organization
ALTER TABLE case_timeline_events ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

-- Index for efficient filtering by tags
CREATE INDEX IF NOT EXISTS idx_case_timeline_events_tags ON case_timeline_events USING GIN (tags);
