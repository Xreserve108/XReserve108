-- =============================================================================
-- Migration 021 — Pre-Reconstruction Cleanup
-- =============================================================================
-- Drops obsolete objects that are NOT present in the target production schema
-- and should not exist in the reconstructed NEW database.
--
-- Approved cleanup operations:
--   1. Drop obsolete orphan function _require_2fa_enabled
--   2. Drop insecure RLS policy admin_users_update_own
-- =============================================================================

-- 1. Drop obsolete orphan function _require_2fa_enabled()
--    - Created in migrations 004/005, never dropped
--    - Absent from OLD LIVE production database
--    - Not referenced by any frontend, Edge Function, trigger, policy,
--      or other database function
--    - Has REVOKE EXECUTE FROM authenticated, anon, public (inaccessible)
--    - Safe to drop

DROP FUNCTION IF EXISTS public._require_2fa_enabled();

-- 2. Drop insecure RLS policy admin_users_update_own
--    - Created in migration 003
--    - Absent from OLD LIVE production database
--    - Allows admins to UPDATE their own row in admin_users without
--      constraint on the role column (privilege escalation risk)
--    - The admin_users_select policy remains for read access

DROP POLICY IF EXISTS "admin_users_update_own" ON public.admin_users;
