-- Case-local edges: user-drawn connections that exist only in a case's network map
CREATE TABLE case_graph_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID REFERENCES cases(id) ON DELETE CASCADE NOT NULL,
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(case_id, source_node_id, target_node_id)
);

CREATE INDEX idx_case_graph_edges_case ON case_graph_edges (case_id);

-- Case-local custom nodes: user-created entities that exist only in a case's network map
CREATE TABLE case_graph_custom_nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID REFERENCES cases(id) ON DELETE CASCADE NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'PERSON',
    position_x REAL DEFAULT 0,
    position_y REAL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_case_graph_custom_nodes_case ON case_graph_custom_nodes (case_id);
