-- Migration 041: Phase 23C — Resolve Login Assurance Function Overloads
--
-- Problem: Migration 039 created establish_login_assurance(TEXT, UUID) and
-- establish_login_assurance_direct(TEXT).  Migration 040 used CREATE OR REPLACE
-- to add p_user_id, but PostgreSQL treats different parameter counts as distinct
-- overloads — CREATE OR REPLACE does NOT remove the old signatures.  This left
-- TWO versions of each function in the live database, causing PostgREST to fail
-- with: "Could not choose the best candidate function between ..."
--
-- Fix: explicitly DROP every existing overload, then re-create each function
-- exactly ONCE with p_user_id UUID DEFAULT NULL so that callers passing either
-- 1 or 2 args (for _direct) or 2 or 3 args (for establish) resolve unambiguously.

-- ============================================================================
-- 1. DROP ALL EXISTING OVERLOADS
-- ============================================================================

-- establish_login_assurance: drop both the 2-arg (Migration 039) and
-- 3-arg (Migration 040) versions.

DROP FUNCTION IF EXISTS public.establish_login_assurance(TEXT, UUID);
DROP FUNCTION IF EXISTS public.establish_login_assurance(TEXT, UUID, UUID);

-- establish_login_assurance_direct: drop both the 1-arg (Migration 039) and
-- 2-arg (Migration 040) versions.

DROP FUNCTION IF EXISTS public.establish_login_assurance_direct(TEXT);
DROP FUNCTION IF EXISTS public.establish_login_assurance_direct(TEXT, UUID);

-- ============================================================================
-- 2. RE-CREATE — SINGLE SIGNATURE EACH (with DEFAULT NULL for p_user_id)
-- ============================================================================

-- establish_login_assurance: called by Edge Functions after TOTP/recovery/
-- passkey-action verification.  p_user_id is required when called from
-- service-role context (Edge Functions); falls back to auth.uid() when NULL
-- (frontend user-JWT context).

CREATE FUNCTION public.establish_login_assurance(
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

  -- Inline verification token consumption (uses resolved v_user_id instead
  -- of auth.uid() which returns NULL for service-role clients).
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

    IF v_token_scope IS NULL OR v_token_scope != 'login' THEN
      RAISE EXCEPTION 'Operation scope mismatch: required login, got %', v_token_scope;
    END IF;

    UPDATE public.user_2fa_verifications
    SET used = true, used_at = NOW()
    WHERE id = p_verification_token;
  END IF;

  DELETE FROM public.login_assurance WHERE session_id = p_session_id;

  INSERT INTO public.login_assurance (user_id, session_id)
  VALUES (v_user_id, p_session_id)
  RETURNING id INTO v_assurance_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, metadata)
  VALUES (v_user_id, 'LOGIN_ASSURANCE_ESTABLISHED', 'login_assurance',
    jsonb_build_object('session_id', p_session_id, 'assurance_id', v_assurance_id));

  RETURN v_assurance_id;
END;
$$;

-- establish_login_assurance_direct: called from the frontend (user JWT,
-- auth.uid() works) and from Edge Functions (service-role, p_user_id required).

CREATE FUNCTION public.establish_login_assurance_direct(
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
-- 3. PERMISSIONS — single signature each, no overloads
-- ============================================================================

REVOKE ALL ON FUNCTION public.establish_login_assurance(TEXT, UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.establish_login_assurance(TEXT, UUID, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.establish_login_assurance(TEXT, UUID, UUID) TO authenticated;

REVOKE ALL ON FUNCTION public.establish_login_assurance_direct(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.establish_login_assurance_direct(TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.establish_login_assurance_direct(TEXT, UUID) TO authenticated;

-- ============================================================================
-- MIGRATION COMPLETE
-- Phase 23C: Resolve login assurance function overloads
-- - Dropped all old overloads from Migrations 039 and 040
-- - Re-created single signatures with DEFAULT NULL for p_user_id
-- - PostgREST can now resolve calls unambiguously
-- ============================================================================
