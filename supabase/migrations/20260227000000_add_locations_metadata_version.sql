-- Add locations array and metadata_version tracking to document_chunks
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS locations TEXT[] DEFAULT '{}';
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS metadata_version INTEGER DEFAULT 1;

-- GIN index on locations for filtered queries
CREATE INDEX IF NOT EXISTS idx_chunks_locations ON document_chunks USING GIN (locations);

-- Index on metadata_version for upgrade queries
CREATE INDEX IF NOT EXISTS idx_chunks_metadata_version ON document_chunks (metadata_version);
