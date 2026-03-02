-- Case-level entity descriptions: user-written notes/descriptions that override or supplement
-- the global node description, scoped to a specific case's network map.
CREATE TABLE case_entity_descriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID REFERENCES cases(id) ON DELETE CASCADE NOT NULL,
    node_id TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(case_id, node_id)
);

CREATE INDEX idx_case_entity_descriptions_case ON case_entity_descriptions (case_id);
