-- Allow the service_role (used by backend scripts via the service key) to
-- read and write nodes, edges, and document_chunks.
-- The existing admin policies check auth.uid() against profiles, which
-- returns NULL for service-key API calls, blocking script writes.

CREATE POLICY "Service role full access on nodes" ON public.nodes
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on edges" ON public.edges
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on document_chunks" ON public.document_chunks
  FOR ALL TO service_role USING (true) WITH CHECK (true);
