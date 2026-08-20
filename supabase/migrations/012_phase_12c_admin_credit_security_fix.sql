-- XReserve Phase 12C — Corrective Security Fix
-- Production audit discovered three security issues that must be resolved
-- before blockchain verification is implemented.
--
-- FINDINGS:
-- 1. Insecure 2-argument admin_credit_deposit(uuid, numeric) exists in
--    production without 2FA. Must be dropped.
-- 2. Migration 011 incorrectly added PENDING_VERIFICATION to the list of
--    creditable statuses in admin_credit_deposit(). PENDING_VERIFICATION
--    means "user declared they sent funds" — NOT "blockchain verified."
--    Crediting at this stage collapses user declaration and blockchain
--    verification into one step, violating the core architecture.
-- 3. admin_update_deposit_status() does not prevent transitioning a
--    PENDING_VERIFICATION deposit directly to CREDITED, allowing an admin
--    to bypass the wallet credit workflow and create a status/balance
--    inconsistency (status=CREDITED but wallet not actually credited).
--
-- KEY PRINCIPLE:
-- PENDING_VERIFICATION deposits are NOT creditable until blockchain
-- verification is implemented in a future phase. No admin action,
-- regardless of 2FA status, may credit a PENDING_VERIFICATION deposit.
--
-- THIS MIGRATION:
-- - Drops insecure 2-arg admin_credit_deposit(uuid, numeric)
-- - Reverts admin_credit_deposit(uuid, numeric, uuid) to only accept
--   PENDING and UNDER_REVIEW (removes PENDING_VERIFICATION)
-- - Fixes admin_update_deposit_status() to prevent PENDING_VERIFICATION
--   from being transitioned to CREDITED
-- - Does NOT modify any data, wallets, ledger, or user records
-- - Does NOT modify migrations 001-011
-- - Does NOT execute automatically
--
-- =============================================================================
-- 1. DROP INSECURE 2-ARGUMENT admin_credit_deposit()
--    This overload has no 2FA requirement. It was created in early migrations
--    before the verification token architecture existed. It must be removed
--    to prevent any admin from crediting a deposit without admin_financial 2FA.
-- =============================================================================

DROP FUNCTION IF EXISTS public.admin_credit_deposit(UUID, NUMERIC);

-- =============================================================================
-- 2. REVERT admin_credit_deposit(uuid, numeric, uuid)
--    Remove PENDING_VERIFICATION from the creditable status list.
--    Only PENDING and UNDER_REVIEW deposits may be credited.
--    This restores the correct separation:
--      USER DECLARATION → PENDING_VERIFICATION (not creditable)
--      FUTURE BLOCKCHAIN VERIFICATION → would transition to creditable state
--      ADMIN FINANCIAL AUTH → credit only after verification
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_credit_deposit(
  p_deposit_id      UUID,
  p_amount          NUMERIC,
  p_verification_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_deposit          RECORD;
  v_wallet_id        UUID;
  v_balance_before   NUMERIC(18,8);
BEGIN
  IF NOT public.is_admin_user() THEN RAISE EXCEPTION 'not authorized'; END IF;
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'admin_credit_deposit: amount must be greater than zero';
  END IF;

  SELECT * INTO v_deposit FROM public.deposits WHERE id = p_deposit_id FOR UPDATE;
  IF v_deposit.id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_deposit: deposit not found';
  END IF;
  IF v_deposit.status = 'CREDITED' THEN
    RAISE EXCEPTION 'admin_credit_deposit: deposit already credited';
  END IF;
  -- PENDING_VERIFICATION is NOT creditable — blockchain verification required first.
  -- Only PENDING and UNDER_REVIEW deposits may be credited by an admin.
  IF v_deposit.status NOT IN ('PENDING', 'UNDER_REVIEW') THEN
    RAISE EXCEPTION 'admin_credit_deposit: cannot credit deposit with status %. Blockchain verification is required before crediting.', v_deposit.status;
  END IF;

  SELECT wb.wallet_id, wb.available_usdt
    INTO v_wallet_id, v_balance_before
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = v_deposit.user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_deposit: wallet not found';
  END IF;

  UPDATE public.wallet_balances
     SET available_usdt = available_usdt + p_amount, updated_at = now()
   WHERE wallet_id = v_wallet_id;

  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'CREDIT', p_amount, v_balance_before, v_balance_before + p_amount, 'deposit', p_deposit_id, '{"direction":"credit","context":"admin_deposit_credit"}'::jsonb);

  UPDATE public.deposits
     SET status = 'CREDITED', actual_amount = p_amount, updated_at = now()
   WHERE id = p_deposit_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'DEPOSIT_CREDITED', 'deposit', p_deposit_id,
    jsonb_build_object('amount', p_amount, 'previous_status', v_deposit.status, 'new_status', 'CREDITED', 'user_id', v_deposit.user_id, 'verification_id', p_verification_id));

  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 3. FIX admin_update_deposit_status()
--    Prevent PENDING_VERIFICATION deposits from being transitioned to CREDITED.
--    Without this fix, an admin could use the status update function to mark
--    a PENDING_VERIFICATION deposit as CREDITED without actually crediting
--    the wallet, creating a status/balance inconsistency.
--
--    PENDING_VERIFICATION deposits may only transition to:
--    - PENDING (revert to pre-submission state)
--    - UNDER_REVIEW (flag for manual investigation)
--    - REJECTED (decline the deposit)
--    They may NOT transition to CREDITED until blockchain verification exists.
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
  IF NOT public.is_admin_user() THEN RAISE EXCEPTION 'not authorized'; END IF;
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');

  IF p_new_status NOT IN ('PENDING', 'UNDER_REVIEW', 'CREDITED', 'REJECTED') THEN
    RAISE EXCEPTION 'admin_update_deposit_status: invalid status %', p_new_status;
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

  -- PENDING_VERIFICATION deposits cannot be marked CREDITED via status update.
  -- Blockchain verification is required before any deposit can be credited.
  -- This prevents bypassing the wallet credit workflow.
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
-- 4. REVOKE — ensure the secure 3-arg function retains correct privileges
--    The 2-arg function was dropped in section 1; DROP removes all associated
--    privileges, so no REVOKE is needed for the dropped overload.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION public.admin_credit_deposit(UUID, NUMERIC, UUID) FROM anon, public;

-- =============================================================================
-- 5. MIGRATION COMPLETE
-- =============================================================================
-- Phase 12C Corrective Security Fix
-- - Dropped insecure 2-arg admin_credit_deposit(uuid, numeric)
-- - Reverted 3-arg admin_credit_deposit to exclude PENDING_VERIFICATION
-- - Fixed admin_update_deposit_status to prevent PENDING_VERIFICATION → CREDITED
-- - No data modified, no wallets touched, no ledger entries changed
-- - PENDING_VERIFICATION deposits are NOT creditable until blockchain
--   verification is implemented in a future phase
-- =============================================================================
