-- For Entities (Nodes)
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  label TEXT,
  type TEXT,
  description TEXT,
  aliases TEXT[],
  position JSONB,
  metadata JSONB
);

-- For Relationships (Edges)
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  source TEXT REFERENCES nodes(id),
  target TEXT REFERENCES nodes(id),
  label TEXT,
  predicate TEXT,
  evidence_text TEXT,
  source_filename TEXT,
  source_page INT,
  confidence TEXT,
  date_mentioned TEXT
);

-- Optional: Add indexes for faster lookups
CREATE INDEX idx_nodes_type ON nodes (type);
CREATE INDEX idx_edges_source ON edges (source);
CREATE INDEX idx_edges_target ON edges (target);
CREATE INDEX idx_edges_predicate ON edges (predicate);
