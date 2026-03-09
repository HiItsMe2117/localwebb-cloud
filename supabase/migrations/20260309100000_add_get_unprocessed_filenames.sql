CREATE OR REPLACE FUNCTION public.get_unprocessed_filenames(batch_limit INT DEFAULT 10)
RETURNS TABLE(filename TEXT)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT dc.filename
  FROM public.document_chunks dc
  WHERE dc.filename IS NOT NULL
    AND dc.filename NOT IN (
      SELECT DISTINCT e.source_filename
      FROM public.edges e
      WHERE e.source_filename IS NOT NULL AND e.source_filename != ''
    )
  LIMIT batch_limit;
$$;
