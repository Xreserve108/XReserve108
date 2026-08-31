-- XReserve Phase 33 — 2FA-Protected Bank Account Deletion
--
-- Phase 32 audit finding M1: bank account deletion previously used a direct
-- RLS-protected DELETE, which did not require 2FA. This created an
-- authorization asymmetry vs. bank account creation (add_bank_account RPC
-- with scoped 2FA verification token).
--
-- Changes:
--   1. New delete_bank_account RPC (SECURITY DEFINER) that requires a valid
--      2FA verification token with scope 'user_transaction'.
--   2. Drop the RLS DELETE policy — deletion is now only possible via the RPC.
--   3. Revoke direct DELETE privilege on the table from authenticated/anon.
--   4. The RPC uses auth.uid() for identity, _require_2fa_verification for
--      atomic token consumption, and verifies ownership before deleting.

-- =============================================================================
-- 1. SERVER-SIDE 2FA-PROTECTED DELETION RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION public.delete_bank_account(
  p_bank_account_id  UUID,
  p_verification_id  UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_deleted BOOLEAN := false;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Consume the scoped 2FA verification token (single-use, 5-min TTL)
  PERFORM public._require_2fa_verification(p_verification_id, 'user_transaction');

  -- Delete only if the bank account belongs to the authenticated user.
  -- The WHERE clause ensures ownership — no IDOR possible.
  DELETE FROM public.bank_accounts
  WHERE id = p_bank_account_id
    AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bank account not found or not owned by you';
  END IF;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_bank_account(UUID, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.delete_bank_account(UUID, UUID) TO   authenticated;

-- =============================================================================
-- 2. REMOVE DIRECT DELETE PATH
--    No INSERT policy existed before (migration 015); now no DELETE policy
--    either. All mutation must go through the 2FA-protected RPCs.
-- =============================================================================

DROP POLICY IF EXISTS "bank_accounts_delete_own" ON public.bank_accounts;

REVOKE DELETE ON public.bank_accounts FROM authenticated, anon, public;

-- =============================================================================
-- MIGRATION COMPLETE
-- Phase 33: Bank account deletion now requires 2FA verification
-- =============================================================================
