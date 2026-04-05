-- Timeline tracks: per-entity overlay tracks on a case timeline
-- Each track represents a person/entity (e.g. Karen Lutnick, Edith Lutnick)
-- whose events can be toggled on/off as colored dots on the main case timeline.
CREATE TABLE case_timeline_tracks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID REFERENCES cases(id) ON DELETE CASCADE NOT NULL,
    entity_node_id TEXT,          -- optional: nodes.id or case_graph_custom_nodes.id
    label TEXT NOT NULL,          -- entity name, denormalized for display
    color TEXT NOT NULL DEFAULT '#5AC8FA',
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(case_id, entity_node_id)
);

CREATE INDEX idx_case_timeline_tracks_case ON case_timeline_tracks (case_id);

-- Junction: one event can belong to multiple tracks (e.g. wife + sister ran same charity)
CREATE TABLE case_timeline_event_tracks (
    event_id UUID REFERENCES case_timeline_events(id) ON DELETE CASCADE NOT NULL,
    track_id UUID REFERENCES case_timeline_tracks(id) ON DELETE CASCADE NOT NULL,
    PRIMARY KEY (event_id, track_id)
);

CREATE INDEX idx_case_timeline_event_tracks_event ON case_timeline_event_tracks (event_id);
CREATE INDEX idx_case_timeline_event_tracks_track ON case_timeline_event_tracks (track_id);
