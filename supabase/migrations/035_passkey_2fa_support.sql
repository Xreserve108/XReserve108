-- Migration 035: Passkey 2FA Support
-- Minimal changes to support passkey authentication alongside existing TOTP
-- Does NOT modify financial RPCs, RLS, or financial tables

-- ============================================================================
-- 1. ADD source_challenge_id TO user_2fa_verIFICATIONS (defense-in-depth)
-- ============================================================================

-- Add column for passkey challenge ID tracking (nullable — TOTP verifications leave it NULL)
ALTER TABLE public.user_2fa_verifications
  ADD COLUMN IF NOT EXISTS source_challenge_id UUID;

-- Partial unique index: prevents replay of the same passkey challenge
-- NULL values are excluded (multiple TOTP verifications with NULL are allowed)
CREATE UNIQUE INDEX IF NOT EXISTS idx_2fa_verifications_source_challenge_unique
  ON public.user_2fa_verifications (source_challenge_id)
  WHERE source_challenge_id IS NOT NULL;

-- ============================================================================
-- 2. MODIFY _create_verification_token TO accept optional source_challenge_id
-- ============================================================================

DROP FUNCTION IF EXISTS public._create_verification_token(UUID, TEXT, INTERVAL);

CREATE OR REPLACE FUNCTION public._create_verification_token(
  p_user_id              UUID,
  p_scope                TEXT,
  p_expires              INTERVAL DEFAULT INTERVAL '5 minutes',
  p_source_challenge_id  UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_token_id UUID;
BEGIN
  INSERT INTO public.user_2fa_verifications (user_id, expires_at, operation_scope, source_challenge_id)
  VALUES (p_user_id, NOW() + p_expires, p_scope, p_source_challenge_id)
  RETURNING id INTO v_token_id;

  RETURN v_token_id;
END;
$$;

-- ============================================================================
-- 3. MODIFY _require_2fa_verification — remove TOTP-only gate
-- ============================================================================
-- Previously checked user_2fa.enabled = true (TOTP-only).
-- Now accepts any valid verification token regardless of 2FA method.
-- Security: tokens are created ONLY by Edge Functions that verify the
-- 2FA method is enabled (TOTP or passkey) before creating the token.

DROP FUNCTION IF EXISTS public._require_2fa_verification(UUID, TEXT);

CREATE OR REPLACE FUNCTION public._require_2fa_verification(
  p_verification_id UUID,
  p_required_scope  TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  IF p_verification_id IS NULL THEN
    RAISE EXCEPTION '2FA verification required. Provide a valid verification.';
  END IF;

  -- Consume token (atomic, strict scope)
  PERFORM public._consume_verification_token(p_verification_id, p_required_scope);

  -- Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, metadata)
  VALUES (v_user_id, '2FA_VERIFIED_OPERATION', 'verification_token',
    jsonb_build_object('scope', p_required_scope, 'token_id', p_verification_id));

  RETURN true;
END;
$$;

-- ============================================================================
-- 4. SECURITY — Revoke execute on new function signature
-- ============================================================================

REVOKE EXECUTE ON FUNCTION public._create_verification_token(UUID, TEXT, INTERVAL, UUID) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public._require_2fa_verification(UUID, TEXT) FROM authenticated, anon, public;

-- ============================================================================
-- MIGRATION COMPLETE
-- Phase: Passkey 2FA Support
-- - source_challenge_id for passkey replay protection
-- - _create_verification_token accepts optional challenge ID
-- - _require_2fa_verification works for both TOTP and passkey tokens
-- - No financial RPCs modified
-- - No RLS modified
-- ============================================================================
