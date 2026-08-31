-- =============================================================================
-- XReserve Migration 042 — Phase 28: Enforce permanent 2FA factor invariant
-- =============================================================================
--
-- OBJECTIVE:
--   Guarantee that every active user/admin account always has at least one
--   active 2FA factor (Authenticator/TOTP OR Passkey/WebAuthn).
--
--   The INVALID state (Authenticator = OFF AND Passkey = DELETED) must
--   never be reachable through normal UI, direct API calls, or concurrent
--   requests.
--
-- APPROACH:
--   1. A `factor_removal_receipts` table bridges the cross-system gap between
--      PostgreSQL (where TOTP state lives) and GoTrue (where passkeys live).
--      When a passkey deletion is authorized, a receipt is created recording
--      the expected passkey count after deletion.  TOTP disable checks these
--      receipts to detect in-flight passkey deletions.
--
--   2. `_authorize_factor_removal()` uses a transaction-level advisory lock
--      keyed on the user_id to serialize all factor-removal checks for a
--      given user.  This prevents concurrent requests from both observing
--      the other factor as present and then removing both.
--
--   3. Receipts are short-lived (10-minute TTL), user-bound, and cleaned up
--      by Edge Functions after successful GoTrue operations.  Stale receipts
--      self-expire and are cleaned by subsequent calls.
--
-- SECURITY:
--   - All functions are SECURITY DEFINER with SET search_path = public
--   - EXECUTE revoked from anon/public, granted to authenticated only
--   - Receipts are impossible for clients to manufacture directly
--     (all client roles revoked on the table)
--   - Receipts are user-bound and operation-bound
-- =============================================================================

-- =============================================================================
-- 1. FACTOR REMOVAL RECEIPTS TABLE
-- =============================================================================

CREATE TABLE public.factor_removal_receipts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  factor_type       TEXT NOT NULL CHECK (factor_type IN ('passkey', 'totp')),
  passkeys_remaining INTEGER,          -- NULL for TOTP; count after deletion for passkey
  completed         BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for efficient lookup by user (used by both authorize and cleanup)
CREATE INDEX idx_factor_removal_receipts_user
  ON public.factor_removal_receipts (user_id, created_at DESC);

-- Enable RLS (no client policies — all access through SECURITY DEFINER RPCs)
ALTER TABLE public.factor_removal_receipts ENABLE ROW LEVEL SECURITY;

-- Revoke all direct client access
REVOKE ALL ON public.factor_removal_receipts FROM anon, authenticated, public;

-- =============================================================================
-- 2. _authorize_factor_removal — atomic invariant check + receipt creation
-- =============================================================================

CREATE OR REPLACE FUNCTION public._authorize_factor_removal(
  p_factor_type          TEXT,
  p_current_passkey_count INTEGER DEFAULT 0
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id        UUID;
  v_totp_enabled   BOOLEAN := false;
  v_blocking_count INTEGER;
  v_remaining      INTEGER;
BEGIN
  -- Serialize all factor-removal operations for this user.
  -- Transaction-level advisory lock: held until COMMIT/ROLLBACK.
  -- Two concurrent calls for the same user_id are serialized.
  PERFORM pg_advisory_xact_lock(hashtext(auth.uid()::text));

  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Clean up expired receipts (> 10 minutes old)
  DELETE FROM public.factor_removal_receipts
  WHERE user_id = v_user_id
    AND created_at < now() - INTERVAL '10 minutes';

  -- ─────────────────────────────────────────────────────────────
  -- TOTP DISABLE path
  -- ─────────────────────────────────────────────────────────────
  IF p_factor_type = 'totp' THEN
    -- Check if TOTP is currently enabled
    SELECT enabled INTO v_totp_enabled
    FROM public.user_2fa
    WHERE user_id = v_user_id;

    IF NOT COALESCE(v_totp_enabled, false) THEN
      RAISE EXCEPTION 'authenticator is not enabled';
    END IF;

    -- Passkey count must be > 0 (at least one passkey must remain)
    IF p_current_passkey_count <= 0 THEN
      RAISE EXCEPTION 'cannot disable authenticator: no passkey is registered. Register a passkey first.';
    END IF;

    -- Check for blocking receipts: any uncompleted passkey-deletion receipt
    -- with passkeys_remaining = 0 means a passkey deletion is in flight or
    -- recently completed.  TOTP disable must wait.
    SELECT COUNT(*) INTO v_blocking_count
    FROM public.factor_removal_receipts
    WHERE user_id = v_user_id
      AND factor_type = 'passkey'
      AND NOT completed
      AND passkeys_remaining = 0;

    IF v_blocking_count > 0 THEN
      RAISE EXCEPTION 'cannot disable authenticator: passkey removal in progress. Please wait and try again.';
    END IF;

    -- Invariant satisfied: TOTP enabled AND at least one passkey exists
    -- AND no conflicting passkey removal in flight.
    -- TOTP disable does NOT create a receipt because the state change
    -- (user_2fa.enabled = false) happens atomically in the caller's
    -- Edge Function within the same request flow.
    RETURN true;

  -- ─────────────────────────────────────────────────────────────
  -- PASSKEY DELETION path
  -- ─────────────────────────────────────────────────────────────
  ELSIF p_factor_type = 'passkey' THEN
    IF p_current_passkey_count < 1 THEN
      RAISE EXCEPTION 'no passkeys to delete';
    END IF;

    -- Check if TOTP is enabled
    SELECT enabled INTO v_totp_enabled
    FROM public.user_2fa
    WHERE user_id = v_user_id;

    v_remaining := p_current_passkey_count - 1;

    IF COALESCE(v_totp_enabled, false) THEN
      -- TOTP is enabled: at least one factor (TOTP) will remain after
      -- passkey deletion.  Create a receipt to block concurrent TOTP
      -- disable when this would be the last passkey.
      INSERT INTO public.factor_removal_receipts (user_id, factor_type, passkeys_remaining)
      VALUES (v_user_id, 'passkey', v_remaining);

      RETURN true;
    END IF;

    -- TOTP is NOT enabled: passkey is the only factor.
    -- After deletion, passkeys_remaining must be >= 1.
    IF v_remaining < 1 THEN
      RAISE EXCEPTION 'cannot delete the last passkey when authenticator is not enabled. Enable authenticator first.';
    END IF;

    -- Other passkeys remain: create receipt (non-blocking for TOTP since
    -- passkeys_remaining > 0) and allow deletion.
    INSERT INTO public.factor_removal_receipts (user_id, factor_type, passkeys_remaining)
    VALUES (v_user_id, 'passkey', v_remaining);

    RETURN true;

  ELSE
    RAISE EXCEPTION 'invalid factor type: %', p_factor_type;
  END IF;
END;
$$;

-- Grants for _authorize_factor_removal
REVOKE EXECUTE ON FUNCTION public._authorize_factor_removal(TEXT, INTEGER) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public._authorize_factor_removal(TEXT, INTEGER) TO authenticated;

-- =============================================================================
-- 3. _cleanup_factor_removal_receipt — Edge Function cleanup after GoTrue
-- =============================================================================

CREATE OR REPLACE FUNCTION public._cleanup_factor_removal_receipt(
  p_factor_type TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Delete the most recent uncompleted receipt for this user + factor type
  DELETE FROM public.factor_removal_receipts
  WHERE id = (
    SELECT id
    FROM public.factor_removal_receipts
    WHERE user_id = v_user_id
      AND factor_type = p_factor_type
      AND NOT completed
    ORDER BY created_at DESC
    LIMIT 1
  );

  RETURN true;
END;
$$;

-- Grants for _cleanup_factor_removal_receipt
REVOKE EXECUTE ON FUNCTION public._cleanup_factor_removal_receipt(TEXT) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public._cleanup_factor_removal_receipt(TEXT) TO authenticated;
