-- Timeline events for case investigation canvases
CREATE TABLE case_timeline_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID REFERENCES cases(id) ON DELETE CASCADE NOT NULL,
    title TEXT NOT NULL,
    event_date TEXT,
    description TEXT DEFAULT '',
    category TEXT DEFAULT 'general',
    position_x REAL DEFAULT 0,
    position_y REAL DEFAULT 0,
    source_graph_node_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_case_timeline_events_case ON case_timeline_events (case_id);

-- Edges between timeline events
CREATE TABLE case_timeline_edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID REFERENCES cases(id) ON DELETE CASCADE NOT NULL,
    source_event_id UUID REFERENCES case_timeline_events(id) ON DELETE CASCADE NOT NULL,
    target_event_id UUID REFERENCES case_timeline_events(id) ON DELETE CASCADE NOT NULL,
    label TEXT DEFAULT '',
    label_position REAL DEFAULT 0.5,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(case_id, source_event_id, target_event_id)
);

CREATE INDEX idx_case_timeline_edges_case ON case_timeline_edges (case_id);
