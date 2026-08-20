-- XReserve Phase 12C — Second Admin RPC Security Fix
-- Production verification after Migration 012 revealed TWO issues:
--
-- FINDING 1: Insecure 2-argument admin_update_deposit_status(uuid, text)
-- still exists in production. It has NO 2FA requirement and allows any
-- admin to change deposit status without admin_financial verification.
--
-- FINDING 2: The secure 3-argument admin_update_deposit_status(uuid, text, uuid)
-- accepts 'CREDITED' as a valid target status. This allows an admin to set
-- status = 'CREDITED' WITHOUT performing the actual wallet/ledger credit
-- operation (which is handled by admin_credit_deposit()). This creates a
-- status/balance inconsistency: status=CREDITED but wallet not credited.
--
-- KEY PRINCIPLE:
-- The ONLY function that may set a deposit to CREDITED is admin_credit_deposit().
-- That function performs the wallet balance update, ledger entry, and THEN
-- sets status = 'CREDITED'. A status-only RPC must NEVER bypass the financial
-- credit workflow.
--
-- THIS MIGRATION:
-- - Drops insecure 2-arg admin_update_deposit_status(uuid, text)
-- - Removes 'CREDITED' from allowed target statuses in the 3-arg function
-- - Only PENDING, UNDER_REVIEW, and REJECTED are valid status transitions
-- - Preserves all existing security: is_admin_user() + admin_financial 2FA
-- - Preserves PENDING_VERIFICATION protections (defense-in-depth)
-- - Does NOT modify admin_credit_deposit()
-- - Does NOT modify any data, wallets, ledger, or user records
-- - Does NOT modify migrations 001-012
--
-- =============================================================================
-- 1. DROP INSECURE 2-ARGUMENT admin_update_deposit_status()
--    This overload has no 2FA requirement. It was created in migration 003
--    before the verification token architecture existed. It must be removed
--    to prevent any admin from changing deposit status without admin_financial 2FA.
--
--    NOTE: DROP FUNCTION removes all associated privileges automatically.
--    No separate REVOKE is needed (this caused migration 012 to fail).
-- =============================================================================

DROP FUNCTION IF EXISTS public.admin_update_deposit_status(UUID, TEXT);

-- =============================================================================
-- 2. FIX admin_update_deposit_status(uuid, text, uuid)
--    Remove 'CREDITED' from the allowed target statuses.
--    Only PENDING, UNDER_REVIEW, and REJECTED are valid for this status-only RPC.
--    All financial crediting MUST go through admin_credit_deposit() which
--    performs the wallet balance update and ledger entry before setting CREDITED.
--
--    Allowed transitions after this fix:
--      PENDING → UNDER_REVIEW (flag for investigation)
--      PENDING → REJECTED (decline the deposit)
--      PENDING_VERIFICATION → PENDING (revert to pre-submission state)
--      PENDING_VERIFICATION → UNDER_REVIEW (flag for investigation)
--      PENDING_VERIFICATION → REJECTED (decline the deposit)
--      UNDER_REVIEW → PENDING (re-open for further review)
--      UNDER_REVIEW → REJECTED (decline the deposit)
--      REJECTED → PENDING (re-open the deposit)
--      REJECTED → UNDER_REVIEW (re-open for investigation)
--
--    NOT allowed (must use admin_credit_deposit instead):
--      ANY STATUS → CREDITED
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_update_deposit_status(
  p_deposit_id      UUID,
  p_new_status      TEXT,
  p_verification_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_current_status TEXT;
BEGIN
  -- Authorization: must be admin with admin_financial 2FA
  IF NOT public.is_admin_user() THEN RAISE EXCEPTION 'not authorized'; END IF;
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');

  -- Only non-financial status transitions are allowed through this RPC.
  -- CREDITED is NOT permitted — wallet crediting must use admin_credit_deposit().
  IF p_new_status NOT IN ('PENDING', 'UNDER_REVIEW', 'REJECTED') THEN
    RAISE EXCEPTION 'admin_update_deposit_status: invalid status %. Use admin_credit_deposit() to credit a deposit.', p_new_status;
  END IF;

  SELECT status INTO v_current_status
  FROM public.deposits WHERE id = p_deposit_id FOR UPDATE;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'admin_update_deposit_status: deposit not found';
  END IF;
  IF v_current_status = 'CREDITED' THEN
    RAISE EXCEPTION 'admin_update_deposit_status: cannot modify credited deposit';
  END IF;
  IF v_current_status = 'REJECTED' AND p_new_status NOT IN ('PENDING', 'UNDER_REVIEW') THEN
    RAISE EXCEPTION 'admin_update_deposit_status: rejected deposit can only be set to PENDING or UNDER_REVIEW';
  END IF;

  -- Defense-in-depth: PENDING_VERIFICATION deposits should never reach CREDITED
  -- through any path. This guard is redundant now that CREDITED is not in the
  -- allowed status list, but is retained as an explicit safety check.
  IF v_current_status = 'PENDING_VERIFICATION' AND p_new_status = 'CREDITED' THEN
    RAISE EXCEPTION 'admin_update_deposit_status: cannot credit a PENDING_VERIFICATION deposit. Blockchain verification is required before crediting.';
  END IF;

  UPDATE public.deposits
  SET status = p_new_status, updated_at = now()
  WHERE id = p_deposit_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(),
    CASE p_new_status
      WHEN 'UNDER_REVIEW' THEN 'DEPOSIT_UNDER_REVIEW'
      WHEN 'REJECTED'     THEN 'DEPOSIT_REJECTED'
      WHEN 'PENDING'      THEN 'DEPOSIT_REOPENED'
      ELSE 'DEPOSIT_STATUS_CHANGE'
    END,
    'deposit', p_deposit_id,
    jsonb_build_object('previous_status', v_current_status, 'new_status', p_new_status, 'verification_id', p_verification_id));

  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 3. REVOKE — ensure the secure 3-arg function retains correct privileges
--    The 2-arg function was dropped in section 1; DROP removes all associated
--    privileges, so no REVOKE is needed for the dropped overload.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION public.admin_update_deposit_status(UUID, TEXT, UUID) FROM anon, public;

-- =============================================================================
-- 4. MIGRATION COMPLETE
-- =============================================================================
-- Phase 12C Second Admin RPC Security Fix
-- - Dropped insecure 2-arg admin_update_deposit_status(uuid, text)
-- - Removed CREDITED from allowed statuses in 3-arg function
-- - Only PENDING, UNDER_REVIEW, REJECTED are valid for status-only updates
-- - All wallet crediting must go through admin_credit_deposit()
-- - No data modified, no wallets touched, no ledger entries changed
-- - admin_credit_deposit() unchanged (still requires admin_financial 2FA)
-- =============================================================================
