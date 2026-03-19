CREATE OR REPLACE FUNCTION public.get_unique_filenames()
RETURNS TABLE(filename TEXT)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT filename FROM public.document_chunks WHERE filename IS NOT NULL;
$$;
