-- Migration 040: Phase 23 — Fix Assurance Functions for Service-Role Context
--
-- Root cause: Migration 039's establish_login_assurance() and
-- establish_login_assurance_direct() rely on auth.uid() to derive the user
-- identity.  Edge Functions call these RPCs via a service-role client, for
-- which auth.uid() returns NULL (service-role JWTs carry no user claim).
-- This caused ALL login assurance establishment to fail with "not
-- authenticated", breaking TOTP login, recovery-code login, passkey login,
-- and mandatory enrollment.
--
-- Fix: add an optional p_user_id parameter.  When provided (Edge Function
-- path), use it directly.  When NULL, fall back to auth.uid() (frontend
-- path).  The internal _consume_verification_token call is replaced with
-- inline consumption logic that uses the resolved user_id for the
-- ownership check instead of auth.uid().

-- ============================================================================
-- 1. ESTABLISH ASSURANCE — accepts optional p_user_id
-- ============================================================================

CREATE OR REPLACE FUNCTION public.establish_login_assurance(
  p_session_id          TEXT,
  p_verification_token  UUID DEFAULT NULL,
  p_user_id             UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id      UUID;
  v_token_scope  TEXT;
  v_expires_at   TIMESTAMPTZ;
  v_used_at      TIMESTAMPTZ;
  v_token_user   UUID;
  v_assurance_id UUID;
BEGIN
  -- Resolve user identity: explicit parameter (Edge Function service-role
  -- path) or auth.uid() (frontend user-JWT path).
  IF p_user_id IS NOT NULL THEN
    v_user_id := p_user_id;
  ELSE
    v_user_id := auth.uid();
  END IF;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF p_session_id IS NULL OR p_session_id = '' THEN
    RAISE EXCEPTION 'session_id is required';
  END IF;

  -- If a verification token is provided, consume it inline.
  -- This replaces the call to _consume_verification_token() which relies
  -- on auth.uid() for ownership — we use v_user_id instead.
  IF p_verification_token IS NOT NULL THEN
    SELECT user_id, operation_scope, expires_at, used_at
    INTO v_token_user, v_token_scope, v_expires_at, v_used_at
    FROM public.user_2fa_verifications
    WHERE id = p_verification_token
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Invalid verification token';
    END IF;

    IF v_token_user != v_user_id THEN
      RAISE EXCEPTION 'Token ownership mismatch';
    END IF;

    IF NOW() > v_expires_at THEN
      RAISE EXCEPTION 'Verification token expired';
    END IF;

    IF v_used_at IS NOT NULL THEN
      RAISE EXCEPTION 'Verification token already used';
    END IF;

    -- Strict scope matching: token must have 'login' scope
    IF v_token_scope IS NULL OR v_token_scope != 'login' THEN
      RAISE EXCEPTION 'Operation scope mismatch: required login, got %', v_token_scope;
    END IF;

    UPDATE public.user_2fa_verifications
    SET used = true, used_at = NOW()
    WHERE id = p_verification_token;
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
-- 2. ESTABLISH ASSURANCE — DIRECT (accepts optional p_user_id)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.establish_login_assurance_direct(
  p_session_id TEXT,
  p_user_id    UUID DEFAULT NULL
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
  IF p_user_id IS NOT NULL THEN
    v_user_id := p_user_id;
  ELSE
    v_user_id := auth.uid();
  END IF;

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
-- 3. PERMISSIONS (updated to cover new signatures)
-- ============================================================================

-- Revoke from PUBLIC and anon; grant to authenticated only.

REVOKE ALL ON FUNCTION public.establish_login_assurance(TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.establish_login_assurance(TEXT, UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.establish_login_assurance(TEXT, UUID, UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.establish_login_assurance_direct(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.establish_login_assurance_direct(TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.establish_login_assurance_direct(TEXT, UUID) TO authenticated;

-- ============================================================================
-- MIGRATION COMPLETE
-- Phase 23: Fix assurance functions for service-role Edge Function context
-- - Added p_user_id parameter to establish_login_assurance()
-- - Added p_user_id parameter to establish_login_assurance_direct()
-- - Inline verification token consumption uses resolved user_id
-- - Backward compatible: NULL p_user_id falls back to auth.uid()
-- ============================================================================
