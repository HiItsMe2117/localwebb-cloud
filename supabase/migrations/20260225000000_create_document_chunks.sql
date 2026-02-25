-- Full-text search table for document chunks (mirrors Pinecone vectors)
CREATE TABLE document_chunks (
    id TEXT PRIMARY KEY,              -- matches Pinecone vector ID
    filename TEXT NOT NULL,
    page INTEGER NOT NULL DEFAULT 1,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    text TEXT NOT NULL,
    gcs_path TEXT,
    doc_type TEXT DEFAULT 'other',
    people TEXT[] DEFAULT '{}',
    organizations TEXT[] DEFAULT '{}',
    dates TEXT[] DEFAULT '{}',
    text_search tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Full-text search index
CREATE INDEX idx_chunks_text_search ON document_chunks USING GIN (text_search);

-- Trigram index for exact/substring ILIKE search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_chunks_text_trgm ON document_chunks USING GIN (text gin_trgm_ops);

-- Lookup indexes
CREATE INDEX idx_chunks_filename ON document_chunks (filename);
CREATE INDEX idx_chunks_people ON document_chunks USING GIN (people);
CREATE INDEX idx_chunks_organizations ON document_chunks USING GIN (organizations);

-- Full-text search with relevance ranking
CREATE OR REPLACE FUNCTION search_chunks(
    search_query TEXT,
    result_limit INTEGER DEFAULT 50,
    result_offset INTEGER DEFAULT 0
) RETURNS TABLE (
    id TEXT, filename TEXT, page INTEGER, chunk_index INTEGER,
    text TEXT, gcs_path TEXT, doc_type TEXT,
    rank REAL, total_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT dc.id, dc.filename, dc.page, dc.chunk_index,
           dc.text, dc.gcs_path, dc.doc_type,
           ts_rank(dc.text_search, websearch_to_tsquery('english', search_query)),
           COUNT(*) OVER()
    FROM document_chunks dc
    WHERE dc.text_search @@ websearch_to_tsquery('english', search_query)
    ORDER BY ts_rank(dc.text_search, websearch_to_tsquery('english', search_query)) DESC
    LIMIT result_limit OFFSET result_offset;
END;
$$ LANGUAGE plpgsql;

-- Exact substring search (ILIKE with pg_trgm)
CREATE OR REPLACE FUNCTION search_chunks_exact(
    search_query TEXT,
    result_limit INTEGER DEFAULT 50,
    result_offset INTEGER DEFAULT 0
) RETURNS TABLE (
    id TEXT, filename TEXT, page INTEGER, chunk_index INTEGER,
    text TEXT, gcs_path TEXT, doc_type TEXT, total_count BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT dc.id, dc.filename, dc.page, dc.chunk_index,
           dc.text, dc.gcs_path, dc.doc_type,
           COUNT(*) OVER()
    FROM document_chunks dc
    WHERE dc.text ILIKE '%' || search_query || '%'
    ORDER BY dc.filename, dc.page
    LIMIT result_limit OFFSET result_offset;
END;
$$ LANGUAGE plpgsql;
