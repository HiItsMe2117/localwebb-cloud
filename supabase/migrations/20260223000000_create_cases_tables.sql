-- Cases table for tracking suspicious activity investigations
CREATE TABLE cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT DEFAULT 'proposed',
  confidence REAL,
  entities TEXT[],
  suggested_questions TEXT[],
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Case evidence table for investigation results, notes, fact checks
CREATE TABLE case_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID REFERENCES cases(id) ON DELETE CASCADE NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  sources JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX idx_cases_status ON cases (status);
CREATE INDEX idx_cases_category ON cases (category);
CREATE INDEX idx_cases_updated_at ON cases (updated_at DESC);
CREATE INDEX idx_case_evidence_case_id ON case_evidence (case_id);
CREATE INDEX idx_case_evidence_type ON case_evidence (type);
