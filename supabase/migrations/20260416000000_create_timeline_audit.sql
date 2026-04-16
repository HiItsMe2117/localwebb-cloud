-- Audit suggestions table for AI-powered timeline quality review
CREATE TABLE case_timeline_audit_suggestions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    event_id UUID REFERENCES case_timeline_events(id) ON DELETE CASCADE,
    suggestion_type TEXT NOT NULL,  -- 'missing_date', 'missing_category', 'duplicate', 'missing_source'
    current_value JSONB,
    suggested_value JSONB,
    confidence REAL DEFAULT 0,
    ai_rationale TEXT,
    status TEXT DEFAULT 'pending',  -- 'pending', 'accepted', 'rejected', 'auto_applied'
    merge_target_id UUID,           -- for duplicates: the surviving event
    related_event_ids UUID[],       -- for duplicates: all events in the group
    web_sources JSONB DEFAULT '[]', -- citations backing the suggestion
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_suggestions_case ON case_timeline_audit_suggestions (case_id);
CREATE INDEX idx_audit_suggestions_status ON case_timeline_audit_suggestions (case_id, status);
