-- Attach source documents to entities on case network graphs
CREATE TABLE case_entity_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID REFERENCES cases(id) ON DELETE CASCADE NOT NULL,
    node_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    page INT,
    note TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_case_entity_documents_case_node ON case_entity_documents (case_id, node_id);
