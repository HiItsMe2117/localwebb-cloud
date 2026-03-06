-- Case graph groups: visual circles around grouped entities for organizing network maps
CREATE TABLE case_graph_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID REFERENCES cases(id) ON DELETE CASCADE NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#007AFF',
    node_ids TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_case_graph_groups_case ON case_graph_groups (case_id);
