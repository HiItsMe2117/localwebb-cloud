CREATE TABLE case_graph_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID REFERENCES cases(id) ON DELETE CASCADE NOT NULL,
    node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE NOT NULL,
    position_x REAL,
    position_y REAL,
    added_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(case_id, node_id)
);

CREATE INDEX idx_case_graph_case ON case_graph_entities (case_id);
CREATE INDEX idx_case_graph_node ON case_graph_entities (node_id);
