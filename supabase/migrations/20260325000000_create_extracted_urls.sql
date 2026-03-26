-- Persisted URL extraction results
-- Stores URLs found in document_chunks so they can be viewed instantly
-- without re-scanning on every visit.

CREATE TABLE IF NOT EXISTS public.extracted_urls (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  domain TEXT,
  mention_count INT NOT NULL DEFAULT 1,
  is_junk BOOLEAN NOT NULL DEFAULT false,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  extracted_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extracted_urls_is_junk ON public.extracted_urls(is_junk);

-- RLS
ALTER TABLE public.extracted_urls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view extracted urls" ON public.extracted_urls
  FOR SELECT USING (true);

CREATE POLICY "Only admins can manage extracted urls" ON public.extracted_urls
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Service role full access on extracted_urls" ON public.extracted_urls
  FOR ALL TO service_role USING (true) WITH CHECK (true);
