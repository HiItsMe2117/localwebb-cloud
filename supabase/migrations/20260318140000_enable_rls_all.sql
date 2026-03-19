-- Enable RLS on all remaining tables
ALTER TABLE public.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edges ENABLE ROW LEVEL SECURITY;

-- 1. Cases Policies
CREATE POLICY "Users can view public cases or their own" ON public.cases
  FOR SELECT USING (is_public = true OR auth.uid() = user_id);

CREATE POLICY "Users can insert their own cases" ON public.cases
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own cases" ON public.cases
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own cases" ON public.cases
  FOR DELETE USING (auth.uid() = user_id);

-- 2. Case Evidence Policies (Linked to Cases)
CREATE POLICY "Users can view evidence of accessible cases" ON public.case_evidence
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.cases
      WHERE cases.id = case_evidence.case_id
      AND (cases.is_public = true OR cases.user_id = auth.uid())
    )
  );

CREATE POLICY "Users can manage evidence of their own cases" ON public.case_evidence
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.cases
      WHERE cases.id = case_evidence.case_id
      AND cases.user_id = auth.uid()
    )
  );

-- 3. Global Knowledge (document_chunks, nodes, edges)
-- Read: Open to all authenticated users (or everyone if public research)
-- Write: Admin only

CREATE POLICY "Anyone can view document chunks" ON public.document_chunks
  FOR SELECT USING (true);

CREATE POLICY "Only admins can manage document chunks" ON public.document_chunks
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Anyone can view nodes" ON public.nodes
  FOR SELECT USING (true);

CREATE POLICY "Only admins can manage nodes" ON public.nodes
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

CREATE POLICY "Anyone can view edges" ON public.edges
  FOR SELECT USING (true);

CREATE POLICY "Only admins can manage edges" ON public.edges
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );
