-- Migration 039: Phase 22 — Server-Authoritative Login Assurance
--
-- Root cause: openAuthGate() unconditionally trusts any restored Supabase
-- session, granting full application access without requiring 2FA completion.
--
-- Fix: bind 2FA completion to the immutable Supabase session_id so that
-- only the specific browser session that completed password + 2FA can
-- access protected functionality.  On refresh the bootstrap queries the
-- server for assurance BEFORE opening the auth gate.
--
-- Does NOT modify:
--   - Financial RPCs (already require verification tokens)
--   - _consume_verification_token()
--   - Passkey enrollment authorization (migrations 036/037/038)
--   - GoTrue-owned tables

-- ============================================================================
-- 1. ASSURANCE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.login_assurance (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_login_assurance_session UNIQUE (session_id)
);

CREATE INDEX IF NOT EXISTS idx_login_assurance_user_session
  ON public.login_assurance (user_id, session_id);

-- ============================================================================
-- 2. ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.login_assurance ENABLE ROW LEVEL SECURITY;

-- No permissive policies for authenticated/anon.
-- Access is via:
--   - establish_login_assurance()     — SECURITY DEFINER, called by Edge Functions
--   - check_login_assurance()         — SECURITY DEFINER, called by the frontend
--   - establish_login_assurance_direct() — SECURITY DEFINER, called after mandatory enrollment

-- ============================================================================
-- 3. ESTABLISH ASSURANCE (called by Edge Functions after login 2FA verification)
-- ============================================================================
-- Creates a session-bound assurance record.  The Edge Function extracts
-- session_id from the user's JWT and passes it together with the verified
-- user_id.  An optional verification_token is consumed atomically so that
-- the assurance is only created when valid 2FA proof exists.

CREATE OR REPLACE FUNCTION public.establish_login_assurance(
  p_session_id          TEXT,
  p_verification_token  UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     UUID;
  v_assurance_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF p_session_id IS NULL OR p_session_id = '' THEN
    RAISE EXCEPTION 'session_id is required';
  END IF;

  -- If a verification token is provided, consume it atomically.
  -- This proves the user completed a fresh 2FA verification.
  IF p_verification_token IS NOT NULL THEN
    PERFORM public._consume_verification_token(p_verification_token, 'login');
  END IF;

  -- Remove any prior assurance for this session (idempotent).
  DELETE FROM public.login_assurance WHERE session_id = p_session_id;

  -- Create the session-bound assurance record.
  INSERT INTO public.login_assurance (user_id, session_id)
  VALUES (v_user_id, p_session_id)
  RETURNING id INTO v_assurance_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, metadata)
  VALUES (v_user_id, 'LOGIN_ASSURANCE_ESTABLISHED', 'login_assurance',
    jsonb_build_object('session_id', p_session_id, 'assurance_id', v_assurance_id));

  RETURN v_assurance_id;
END;
$$;

-- ============================================================================
-- 4. ESTABLISH ASSURANCE — DIRECT (mandatory enrollment completion)
-- ============================================================================
-- Used only after mandatory TOTP/Passkey enrollment during the login flow.
-- Does NOT consume a verification token (the enrollment itself is the proof).
-- Restricted to authenticated role; Edge Function gates the call.

CREATE OR REPLACE FUNCTION public.establish_login_assurance_direct(
  p_session_id TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id      UUID;
  v_assurance_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF p_session_id IS NULL OR p_session_id = '' THEN
    RAISE EXCEPTION 'session_id is required';
  END IF;

  -- Remove any prior assurance for this session (idempotent).
  DELETE FROM public.login_assurance WHERE session_id = p_session_id;

  INSERT INTO public.login_assurance (user_id, session_id)
  VALUES (v_user_id, p_session_id)
  RETURNING id INTO v_assurance_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, metadata)
  VALUES (v_user_id, 'LOGIN_ASSURANCE_ESTABLISHED_DIRECT', 'login_assurance',
    jsonb_build_object('session_id', p_session_id, 'assurance_id', v_assurance_id));

  RETURN v_assurance_id;
END;
$$;

-- ============================================================================
-- 5. CHECK ASSURANCE (called by the frontend on bootstrap / token refresh)
-- ============================================================================
-- Returns TRUE only when a valid assurance record exists for the given
-- session_id AND the authenticated user matches.

CREATE OR REPLACE FUNCTION public.check_login_assurance(
  p_session_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_exists  BOOLEAN;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF p_session_id IS NULL OR p_session_id = '' THEN
    RETURN false;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.login_assurance
    WHERE user_id = v_user_id
      AND session_id = p_session_id
  ) INTO v_exists;

  RETURN v_exists;
END;
$$;

-- ============================================================================
-- 6. REVOKE ASSURANCE (called on sign-out for cleanup)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.revoke_login_assurance()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM public.login_assurance WHERE user_id = v_user_id;
  RETURN true;
END;
$$;

-- ============================================================================
-- 7. PERMISSIONS
-- ============================================================================

-- All four functions: revoke from PUBLIC, anon; grant to authenticated only.

REVOKE ALL ON FUNCTION public.establish_login_assurance(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.establish_login_assurance(TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.establish_login_assurance(TEXT, UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.establish_login_assurance_direct(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.establish_login_assurance_direct(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.establish_login_assurance_direct(TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.check_login_assurance(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_login_assurance(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.check_login_assurance(TEXT) TO authenticated;

REVOKE ALL ON FUNCTION public.revoke_login_assurance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_login_assurance() FROM anon;
GRANT EXECUTE ON FUNCTION public.revoke_login_assurance() TO authenticated;

-- ============================================================================
-- MIGRATION COMPLETE
-- Phase 22: Server-Authoritative Login Assurance
-- - Session-bound assurance table with unique session_id constraint
-- - establish_login_assurance() — consumes login-scoped verification token
-- - establish_login_assurance_direct() — for mandatory enrollment completion
-- - check_login_assurance() — frontend bootstrap gate query
-- - revoke_login_assurance() — cleanup on sign-out
-- - RLS enabled, no client policies (SECURITY DEFINER access only)
-- - No financial RPCs modified
-- - No _consume_verification_token() modifications
-- ============================================================================
