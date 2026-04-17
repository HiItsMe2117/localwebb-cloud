-- Add source column to distinguish how cases were created
ALTER TABLE public.cases
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual' NOT NULL;

-- Backfill: mark existing cases that have "Initial AI Finding:" evidence as scan-generated
UPDATE public.cases SET source = 'scan'
WHERE id IN (
  SELECT DISTINCT case_id FROM public.case_evidence
  WHERE content LIKE 'Initial AI Finding:%'
);

CREATE INDEX idx_cases_source ON cases (source);
