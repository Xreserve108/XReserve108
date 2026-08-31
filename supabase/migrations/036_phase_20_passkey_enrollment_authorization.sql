-- Migration 036: Passkey Enrollment Authorization
-- Phase 20 — Server-side authorization gate for passkey enrollment
--
-- Protects auth.webauthn_credentials INSERT with a trigger that requires
-- a short-lived, single-use authorization row. This prevents a stolen JWT
-- from directly registering a passkey via the GoTrue API.
--
-- Does NOT modify:
--   - Financial RPCs
--   - _consume_verification_token()
--   - Existing verification-token semantics
--   - GoTrue-owned table schema / ownership
--   - Last-factor protection

-- ============================================================================
-- 1. AUTHORIZATION TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.passkey_enrollment_authorizations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  consumed_at         TIMESTAMPTZ,
  verification_method TEXT NOT NULL,
  is_signup           BOOLEAN NOT NULL DEFAULT false,

  CONSTRAINT chk_enrollment_verification_method
    CHECK (verification_method IN ('totp', 'passkey', 'signup'))
);

-- Index for finding active (unconsumed, unexpired) authorizations by user.
-- Note: Cannot use NOW() in index predicate (volatile). Plain index on
-- (user_id, consumed_at) lets the trigger efficiently find candidate rows.
CREATE INDEX IF NOT EXISTS idx_enrollment_auth_user_active
  ON public.passkey_enrollment_authorizations (user_id, consumed_at);

-- ============================================================================
-- 2. ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.passkey_enrollment_authorizations ENABLE ROW LEVEL SECURITY;

-- No permissive policies for authenticated/anon.
-- Access is via Edge Function (service_role) and trigger (supabase_auth_admin) only.

-- ============================================================================
-- 3. PERMISSIONS
-- ============================================================================

-- supabase_auth_admin (GoTrue role) — needs SELECT + column-level UPDATE
-- on consumed_at for the trigger to find and atomically consume authorizations.
-- The trigger function runs as the table owner (supabase_auth_admin on
-- auth.webauthn_credentials), so it needs explicit grants on this public table.
GRANT SELECT ON public.passkey_enrollment_authorizations TO supabase_auth_admin;
GRANT UPDATE (consumed_at) ON public.passkey_enrollment_authorizations TO supabase_auth_admin;

-- service_role — needs INSERT for Edge Functions to create authorization rows.
-- service_role bypasses RLS by default.
GRANT INSERT ON public.passkey_enrollment_authorizations TO service_role;

-- ============================================================================
-- 4. TRIGGER FUNCTION
-- ============================================================================
-- Runs as supabase_auth_admin (owner of auth.webauthn_credentials).
-- NO SECURITY DEFINER needed — the owner already has all required privileges.
-- Fixed search_path = public.

CREATE OR REPLACE FUNCTION public._check_passkey_enrollment_auth()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_auth_id UUID;
BEGIN
  -- Find and atomically consume exactly one valid authorization for NEW.user_id.
  -- FOR UPDATE SKIP LOCKED ensures safe concurrent registration attempts.
  SELECT a.id
  INTO v_auth_id
  FROM public.passkey_enrollment_authorizations a
  WHERE a.user_id = NEW.user_id
    AND a.consumed_at IS NULL
    AND a.expires_at > NOW()
  ORDER BY a.created_at DESC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION 'Passkey enrollment not authorized. Complete 2FA verification before adding a passkey.';
  END IF;

  -- Mark authorization as consumed (single-use)
  UPDATE public.passkey_enrollment_authorizations
  SET consumed_at = NOW()
  WHERE id = v_auth_id;

  RETURN NEW;
END;
$$;

-- ============================================================================
-- 5. TRIGGER
-- ============================================================================
-- AFTER INSERT on auth.webauthn_credentials — fires for each new credential.
-- Does NOT govern UPDATE or DELETE (existing management flows untouched).

DROP TRIGGER IF EXISTS check_passkey_enrollment_auth ON auth.webauthn_credentials;
CREATE TRIGGER check_passkey_enrollment_auth
  AFTER INSERT ON auth.webauthn_credentials
  FOR EACH ROW
  EXECUTE FUNCTION public._check_passkey_enrollment_auth();

-- ============================================================================
-- MIGRATION COMPLETE
-- Phase 20: Passkey Enrollment Authorization
-- - Authorization table with single-use, short-lived gate
-- - RLS enabled, no client policies
-- - Trigger on auth.webauthn_credentials INSERT
-- - No SECURITY DEFINER (runs as table owner)
-- - No financial RPCs modified
-- - No _consume_verification_token() modifications
-- ============================================================================
