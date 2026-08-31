-- Migration 043: Phase 30 — Fix Passkey Deletion Verification Token Context
--
-- Root cause: passkey-manage Edge Function calls _consume_verification_token()
-- via a user-JWT PostgREST client.  Migration 006 revoked EXECUTE from
-- authenticated, so PostgREST denies the call before the function body runs:
--   "permission denied for function _consume_verification_token"
--
-- Fix: create an internal variant that accepts an explicit p_user_id parameter
-- (from verifyAuth() in the Edge Function) instead of relying on auth.uid().
-- Called via serviceClient() so PostgREST function-level permissions for
-- authenticated users are irrelevant.
--
-- This follows the exact pattern established in Migration 040
-- (establish_login_assurance with optional p_user_id).
--
-- Security properties preserved from the original _consume_verification_token:
--   1. Token ownership (p_user_id from JWT, not browser)
--   2. Token expiry
--   3. Single-use / replay protection (SELECT FOR UPDATE atomic lock)
--   4. Strict scope matching
--   5. User binding (verified JWT → userId → token → scope → consumed)

-- ============================================================================
-- 1. INTERNAL TOKEN CONSUMPTION — accepts explicit p_user_id
-- ============================================================================

CREATE OR REPLACE FUNCTION public._consume_verification_token_internal(
  p_token_id       UUID,
  p_required_scope TEXT DEFAULT NULL,
  p_user_id        UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id     UUID;
  v_token_scope TEXT;
  v_expires_at  TIMESTAMPTZ;
  v_used_at     TIMESTAMPTZ;
  v_auth_user   UUID;
BEGIN
  -- Resolve user identity: explicit parameter (Edge Function service-role
  -- path) or auth.uid() (frontend user-JWT path).
  -- This mirrors the pattern in establish_login_assurance (Migration 040).
  IF p_user_id IS NOT NULL THEN
    v_auth_user := p_user_id;
  ELSE
    v_auth_user := auth.uid();
  END IF;

  IF v_auth_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Atomic lock: SELECT FOR UPDATE prevents concurrent reads
  -- (identical to original _consume_verification_token)
  SELECT user_id, operation_scope, expires_at, used_at
  INTO v_user_id, v_token_scope, v_expires_at, v_used_at
  FROM public.user_2fa_verifications
  WHERE id = p_token_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid verification token';
  END IF;

  -- Ownership check
  IF v_user_id != v_auth_user THEN
    RAISE EXCEPTION 'Token ownership mismatch';
  END IF;

  -- Expiration check
  IF NOW() > v_expires_at THEN
    RAISE EXCEPTION 'Verification token expired';
  END IF;

  -- Single-use check
  IF v_used_at IS NOT NULL THEN
    RAISE EXCEPTION 'Verification token already used';
  END IF;

  -- STRICT scope matching: null-scoped tokens rejected for scoped operations
  IF p_required_scope IS NOT NULL THEN
    IF v_token_scope IS NULL THEN
      RAISE EXCEPTION 'Token has no operation scope';
    END IF;
    IF v_token_scope != p_required_scope THEN
      RAISE EXCEPTION 'Operation scope mismatch: required %, got %', p_required_scope, v_token_scope;
    END IF;
  END IF;

  -- Atomic consumption
  UPDATE public.user_2fa_verifications
  SET used = true, used_at = NOW()
  WHERE id = p_token_id;

  RETURN true;
END;
$$;

-- ============================================================================
-- 2. PERMISSIONS — internal only, no client access
-- ============================================================================

REVOKE ALL ON FUNCTION public._consume_verification_token_internal(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._consume_verification_token_internal(UUID, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public._consume_verification_token_internal(UUID, TEXT, UUID) FROM authenticated;

-- ============================================================================
-- 3. VERIFY ORIGINAL FUNCTION REMAINS RESTRICTED
-- ============================================================================
-- _consume_verification_token(UUID, TEXT) remains revoked from
-- authenticated, anon, public (Migration 006).  No changes to it.

-- ============================================================================
-- MIGRATION COMPLETE
-- Phase 30: Fix passkey deletion verification token context
-- - _consume_verification_token_internal accepts explicit p_user_id
-- - Called via serviceClient from passkey-manage Edge Function
-- - Original _consume_verification_token remains client-inaccessible
-- - All security semantics preserved (ownership, expiry, replay, scope)
-- ============================================================================
