-- Sticky note nodes on case network graphs
CREATE TABLE case_graph_sticky_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID REFERENCES cases(id) ON DELETE CASCADE NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#FBBF24',
    position_x REAL DEFAULT 0,
    position_y REAL DEFAULT 0,
    width REAL DEFAULT 280,
    height REAL DEFAULT 200,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_case_graph_sticky_notes_case ON case_graph_sticky_notes (case_id);

-- Media attachments for sticky notes (photos, videos)
CREATE TABLE case_graph_sticky_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sticky_note_id UUID REFERENCES case_graph_sticky_notes(id) ON DELETE CASCADE NOT NULL,
    case_id UUID NOT NULL,
    filename TEXT NOT NULL,
    gcs_path TEXT NOT NULL,
    media_type TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_case_graph_sticky_media_note ON case_graph_sticky_media (sticky_note_id);
