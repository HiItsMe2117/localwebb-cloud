-- Add 'basic' to the allowed roles in the profiles table.
-- The Stripe billing integration assigns 'basic' for the $49/mo tier,
-- but the original CHECK constraint only allowed (admin, pro, standard, elite).

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'pro', 'standard', 'elite', 'basic'));
