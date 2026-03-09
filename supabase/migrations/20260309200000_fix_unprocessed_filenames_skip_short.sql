-- Fix infinite skip loop: filter out files with < 100 chars total content
-- These are junk OCR outputs (scanned images, labels, etc.) that will never
-- produce useful entity extractions and block the bulk extract loop forever.
CREATE OR REPLACE FUNCTION public.get_unprocessed_filenames(batch_limit INT DEFAULT 10)
RETURNS TABLE(filename TEXT)
LANGUAGE sql
STABLE
AS $$
  SELECT sub.filename
  FROM (
    SELECT dc.filename, SUM(LENGTH(COALESCE(dc.text, ''))) AS total_chars
    FROM public.document_chunks dc
    WHERE dc.filename IS NOT NULL
      AND dc.filename NOT IN (
        SELECT DISTINCT e.source_filename
        FROM public.edges e
        WHERE e.source_filename IS NOT NULL AND e.source_filename != ''
      )
    GROUP BY dc.filename
    HAVING SUM(LENGTH(COALESCE(dc.text, ''))) >= 100
  ) sub
  LIMIT batch_limit;
$$;
