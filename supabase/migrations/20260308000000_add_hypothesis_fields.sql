ALTER TABLE case_graph_edges ADD COLUMN IF NOT EXISTS is_hypothesis BOOLEAN DEFAULT false;
ALTER TABLE case_graph_edges ADD COLUMN IF NOT EXISTS evidence_text TEXT;
ALTER TABLE case_graph_edges ADD COLUMN IF NOT EXISTS source_filename TEXT;
ALTER TABLE case_graph_edges ADD COLUMN IF NOT EXISTS source_page INT;
ALTER TABLE case_graph_edges ADD COLUMN IF NOT EXISTS confidence TEXT;
