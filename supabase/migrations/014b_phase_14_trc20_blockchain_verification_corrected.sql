-- XReserve Phase 14b — TRC20 USDT Blockchain Verification (Corrected)
-- CORRECTIVE / ADDITIVE MIGRATION
--
-- This migration is the safe, corrected version of Migration 014.
-- It implements the full Phase 14 blockchain verification pipeline
-- WITHOUT modifying the existing admin_credit_deposit() (Migration 012)
-- or admin_update_deposit_status() (Migration 013).
--
-- KEY DIFFERENCES FROM MIGRATION 014:
-- - Section 7 of Migration 014 (which overwrites admin_credit_deposit) is EXCLUDED.
-- - A NEW dedicated function admin_credit_verified_deposit() is introduced instead.
-- - A database trigger enforces the Phase 14 state-machine invariant:
--   deposits created by submit_deposit() (identified by deposit_method_id IS NOT NULL)
--   can NEVER transition to PENDING or UNDER_REVIEW, closing both the direct bypass
--   and the REJECTED → PENDING bypass to the legacy admin_credit_deposit() path.
-- - All new RPCs have explicit GRANT EXECUTE TO authenticated.
--
-- ARCHITECTURE:
-- 1. USER SUBMITS DEPOSIT (submit_deposit, user_transaction 2FA) → PENDING_VERIFICATION
-- 2. BLOCKCHAIN VERIFICATION (Edge Function, TronGrid API)        → sets verified_amount
-- 3. ADMIN MANUAL VERIFICATION (8-item checklist, no 2FA)        → sets manually_verified_at
-- 4. ADMIN CLICKS "Credit" → admin_financial 2FA challenge
-- 5. admin_credit_verified_deposit() credits wallet using verified_amount (DB-derived)
--
-- SECURITY INVARIANTS:
-- - The user-declared amount is NEVER used for crediting.
-- - verified_amount (blockchain-derived, stored in DB) is the sole credit authority.
-- - Phase 14 deposits (deposit_method_id IS NOT NULL) can only be credited through
--   admin_credit_verified_deposit(). The legacy admin_credit_deposit() is unreachable.
-- - A database trigger prevents Phase 14 deposits from entering PENDING/UNDER_REVIEW.
-- - Migration 012 (admin_credit_deposit) is NOT modified.
-- - Migration 013 (admin_update_deposit_status) is NOT modified.
--
-- PRODUCTION STATE:
-- - Migrations 001-010, 011b, 012, 013 are APPLIED.
-- - Migration 014 is NOT APPLIED.
-- - This migration (014b) is the corrected replacement for 014.

-- =============================================================================
-- 1. EXTEND DEPOSITS TABLE — Verification Stage Fields
--    All fields are additive. Existing data is preserved.
--    RLS remains unchanged: users can only SELECT their own deposits.
-- =============================================================================

-- Timestamp when blockchain verification completed successfully.
-- NULL means blockchain verification has not yet succeeded.
ALTER TABLE public.deposits
  ADD COLUMN IF NOT EXISTS blockchain_verified_at TIMESTAMPTZ;

-- Detailed blockchain transaction data captured during verification.
-- Schema: {"txid","block_number","block_timestamp","from_address","to_address",
--          "raw_amount","token_contract","confirmations","network"}
-- Stored as JSONB for flexibility; never accepts user-supplied values.
ALTER TABLE public.deposits
  ADD COLUMN IF NOT EXISTS blockchain_verification_data JSONB;

-- Provider name (e.g., 'trongrid'). Allows future multi-provider support.
ALTER TABLE public.deposits
  ADD COLUMN IF NOT EXISTS blockchain_provider TEXT;

-- Last blockchain verification error (transient — cleared on success).
ALTER TABLE public.deposits
  ADD COLUMN IF NOT EXISTS blockchain_verification_error TEXT;

-- Number of blockchain verification attempts (for retry tracking).
ALTER TABLE public.deposits
  ADD COLUMN IF NOT EXISTS blockchain_verification_attempts INTEGER NOT NULL DEFAULT 0;

-- Timestamp of last verification attempt (success or failure).
ALTER TABLE public.deposits
  ADD COLUMN IF NOT EXISTS blockchain_verification_last_attempt_at TIMESTAMPTZ;

-- When manual admin verification was completed.
-- NULL means no admin has manually confirmed this deposit yet.
ALTER TABLE public.deposits
  ADD COLUMN IF NOT EXISTS manually_verified_at TIMESTAMPTZ;

-- Admin user who performed manual verification.
ALTER TABLE public.deposits
  ADD COLUMN IF NOT EXISTS manually_verified_by UUID;

-- Optional admin notes from manual verification.
ALTER TABLE public.deposits
  ADD COLUMN IF NOT EXISTS manual_verification_notes TEXT;

-- Mandatory 8-item checklist confirming the admin independently verified:
--   txid, network, token, sender, recipient, verified_amount, finality, wallet info.
-- All entries MUST be present and TRUE before manual verification is accepted.
-- Schema: {"txid": true, "network": true, "token": true, "sender": true,
--          "recipient": true, "amount": true, "finality": true,
--          "wallet_info": true}
ALTER TABLE public.deposits
  ADD COLUMN IF NOT EXISTS manual_verification_checklist JSONB;

-- =============================================================================
-- 2. CONSTRAINTS
-- =============================================================================

-- blockchain_verified_at must be in the past (or null)
ALTER TABLE public.deposits
  DROP CONSTRAINT IF EXISTS chk_blockchain_verified_at_past;
ALTER TABLE public.deposits
  ADD CONSTRAINT chk_blockchain_verified_at_past
  CHECK (blockchain_verified_at IS NULL OR blockchain_verified_at <= now() + interval '5 minutes');

-- verified_amount already exists from migration 011b; ensure positive when set
ALTER TABLE public.deposits
  DROP CONSTRAINT IF EXISTS chk_verified_amount_positive;
ALTER TABLE public.deposits
  ADD CONSTRAINT chk_verified_amount_positive
  CHECK (verified_amount IS NULL OR verified_amount > 0);

-- blockchain_verification_attempts must be non-negative
ALTER TABLE public.deposits
  DROP CONSTRAINT IF EXISTS chk_blockchain_attempts_nonneg;
ALTER TABLE public.deposits
  ADD CONSTRAINT chk_blockchain_attempts_nonneg
  CHECK (blockchain_verification_attempts >= 0);

-- If manually_verified_at is set, manually_verified_by must be set too
ALTER TABLE public.deposits
  DROP CONSTRAINT IF EXISTS chk_manual_verification_consistency;
ALTER TABLE public.deposits
  ADD CONSTRAINT chk_manual_verification_consistency
  CHECK (
    (manually_verified_at IS NULL AND manually_verified_by IS NULL)
    OR
    (manually_verified_at IS NOT NULL AND manually_verified_by IS NOT NULL)
  );

-- Manual verification checklist must be NULL until manual verification,
-- and once set must contain exactly 8 booleans (all TRUE for completeness).
-- This is enforced by the RPC; the constraint here is structural only.
ALTER TABLE public.deposits
  DROP CONSTRAINT IF EXISTS chk_manual_checklist_structure;
ALTER TABLE public.deposits
  ADD CONSTRAINT chk_manual_checklist_structure
  CHECK (
    manual_verification_checklist IS NULL
    OR (
      jsonb_typeof(manual_verification_checklist) = 'object'
      AND manual_verification_checklist ? 'txid'
      AND manual_verification_checklist ? 'network'
      AND manual_verification_checklist ? 'token'
      AND manual_verification_checklist ? 'sender'
      AND manual_verification_checklist ? 'recipient'
      AND manual_verification_checklist ? 'amount'
      AND manual_verification_checklist ? 'finality'
      AND manual_verification_checklist ? 'wallet_info'
    )
  );

-- =============================================================================
-- 3. INDEXES for verification queries
-- =============================================================================

-- Pending blockchain verification queue (for edge function / cron)
CREATE INDEX IF NOT EXISTS idx_deposits_pending_blockchain_verification
  ON public.deposits (created_at)
  WHERE status = 'PENDING_VERIFICATION'
    AND blockchain_verified_at IS NULL
    AND blockchain_verification_attempts < 10;

-- Manual verification queue (admin UI)
CREATE INDEX IF NOT EXISTS idx_deposits_pending_manual_verification
  ON public.deposits (blockchain_verified_at)
  WHERE status = 'PENDING_VERIFICATION'
    AND blockchain_verified_at IS NOT NULL
    AND manually_verified_at IS NULL;

-- =============================================================================
-- 4. RPC: request_blockchain_verification
--    User-callable to mark a deposit as ready for blockchain verification.
--    Idempotent — calling multiple times has the same effect as calling once.
--    Does NOT perform the actual blockchain lookup (server-side edge function does that).
--    This RPC simply ensures the deposit is in the verification queue.
--
--    Authorization: deposit owner only.
--    No 2FA required — this is a non-financial read/queue operation.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.request_blockchain_verification(
  p_deposit_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id    UUID := auth.uid();
  v_deposit    RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF p_deposit_id IS NULL THEN
    RAISE EXCEPTION 'deposit_id is required';
  END IF;

  -- Lock the deposit row
  SELECT user_id, status, blockchain_verified_at, blockchain_verification_attempts
    INTO v_deposit
    FROM public.deposits
   WHERE id = p_deposit_id
     FOR UPDATE;

  IF v_deposit.user_id IS NULL THEN
    RAISE EXCEPTION 'deposit not found';
  END IF;

  -- User can only request verification for their own deposits
  IF v_deposit.user_id <> v_user_id THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- Only PENDING_VERIFICATION deposits can be queued for blockchain verification
  IF v_deposit.status <> 'PENDING_VERIFICATION' THEN
    RAISE EXCEPTION 'deposit is not in PENDING_VERIFICATION status';
  END IF;

  -- If already blockchain-verified, no action needed
  IF v_deposit.blockchain_verified_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'deposit_id', p_deposit_id,
      'status', v_deposit.status,
      'blockchain_verified', true,
      'message', 'deposit is already blockchain verified'
    );
  END IF;

  -- Reset retry counter if it was a transient error and the deposit is still in queue
  -- (We do NOT increment here — the edge function increments on each attempt.)
  -- This RPC just ensures the deposit is in the queue (which it already is by being PENDING_VERIFICATION).

  -- Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (
    v_user_id,
    'DEPOSIT_BLOCKCHAIN_VERIFICATION_REQUESTED',
    'deposit',
    p_deposit_id,
    jsonb_build_object('deposit_id', p_deposit_id, 'attempts', v_deposit.blockchain_verification_attempts)
  );

  RETURN jsonb_build_object(
    'deposit_id', p_deposit_id,
    'status', v_deposit.status,
    'blockchain_verified', false,
    'queued', true,
    'attempts', v_deposit.blockchain_verification_attempts,
    'message', 'deposit queued for blockchain verification'
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.request_blockchain_verification(UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.request_blockchain_verification(UUID) TO   authenticated;

-- =============================================================================
-- 5. RPC: get_deposit_verification_details
--    Admin-only RPC to fetch full verification data for the admin UI.
--    Returns: user, network, token, declared_amount, verified_amount, blockchain data,
--             manual verification data, status, audit trail summary.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_deposit_verification_details(
  p_deposit_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_deposit RECORD;
  v_user_email TEXT;
  v_manually_verified_by_email TEXT;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF p_deposit_id IS NULL THEN
    RAISE EXCEPTION 'deposit_id is required';
  END IF;

  SELECT d.*, p.email AS profile_email
    INTO v_deposit
    FROM public.deposits d
    LEFT JOIN public.profiles p ON p.id = d.user_id
   WHERE d.id = p_deposit_id;

  IF v_deposit.id IS NULL THEN
    RAISE EXCEPTION 'deposit not found';
  END IF;

  v_user_email := v_deposit.profile_email;

  -- If manually verified, look up the admin email
  IF v_deposit.manually_verified_by IS NOT NULL THEN
    SELECT email INTO v_manually_verified_by_email
    FROM public.profiles
    WHERE id = v_deposit.manually_verified_by;
  END IF;

  RETURN jsonb_build_object(
    'deposit_id', v_deposit.id,
    'user_id', v_deposit.user_id,
    'user_email', v_user_email,
    'network', v_deposit.network,
    'token', v_deposit.token,
    'declared_amount', v_deposit.declared_amount,
    'expected_amount', v_deposit.expected_amount,
    'verified_amount', v_deposit.verified_amount,
    'actual_amount', v_deposit.actual_amount,
    'tx_hash', v_deposit.tx_hash,
    'destination_address', v_deposit.destination_address,
    'blockchain_url', v_deposit.blockchain_url,
    'status', v_deposit.status,
    'created_at', v_deposit.created_at,
    'updated_at', v_deposit.updated_at,
    'blockchain_verified_at', v_deposit.blockchain_verified_at,
    'blockchain_verification_data', v_deposit.blockchain_verification_data,
    'blockchain_provider', v_deposit.blockchain_provider,
    'blockchain_verification_error', v_deposit.blockchain_verification_error,
    'blockchain_verification_attempts', v_deposit.blockchain_verification_attempts,
    'manually_verified_at', v_deposit.manually_verified_at,
    'manually_verified_by', v_deposit.manually_verified_by,
    'manually_verified_by_email', v_manually_verified_by_email,
    'manual_verification_notes', v_deposit.manual_verification_notes,
    'manual_verification_checklist', v_deposit.manual_verification_checklist,
    'deposit_method_id', v_deposit.deposit_method_id,
    'amount_difference',
      CASE
        WHEN v_deposit.declared_amount IS NOT NULL AND v_deposit.verified_amount IS NOT NULL
        THEN v_deposit.verified_amount - v_deposit.declared_amount
        ELSE NULL
      END
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_deposit_verification_details(UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.get_deposit_verification_details(UUID) TO   authenticated;

-- =============================================================================
-- 6. RPC: admin_manually_verify_deposit
--    Admin records manual verification AFTER blockchain verification has
--    succeeded. This is a logged confirmation action — it does NOT perform
--    any wallet write and does NOT require admin_financial 2FA.
--
--    The single admin_financial 2FA challenge is reserved exclusively for
--    the actual wallet credit (admin_credit_verified_deposit).
--
--    Validates:
--    - Caller is admin (is_admin_user())
--    - Deposit exists
--    - Deposit is in PENDING_VERIFICATION status
--    - Deposit has been blockchain verified (blockchain_verified_at IS NOT NULL)
--    - Deposit has NOT been manually verified yet
--    - Deposit has NOT been credited yet
--    - verified_amount IS NOT NULL
--    - p_checklist is a JSONB object containing 8 booleans, ALL must be TRUE
--
--    The 8 mandatory checklist items are:
--      txid, network, token, sender, recipient, amount, finality, wallet_info
--
--    Records: manually_verified_at, manually_verified_by, manual_verification_notes,
--             manual_verification_checklist
--    Audit log: DEPOSIT_MANUALLY_VERIFIED
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_manually_verify_deposit(
  p_deposit_id UUID,
  p_checklist  JSONB,
  p_notes      TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_deposit  RECORD;
  v_admin_id UUID := auth.uid();
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- IMPORTANT: This RPC does NOT require admin_financial 2FA.
  -- The 2FA challenge is reserved for the actual financial action
  -- (admin_credit_verified_deposit). Manual verification is a logged
  -- confirmation only and does not move money.

  IF p_deposit_id IS NULL THEN
    RAISE EXCEPTION 'deposit_id is required';
  END IF;

  -- Validate checklist structure: must be JSONB object with all 8 keys TRUE
  IF p_checklist IS NULL OR jsonb_typeof(p_checklist) <> 'object' THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: checklist is required (JSONB object)';
  END IF;
  IF NOT (
    (p_checklist ? 'txid')        AND (p_checklist->>'txid')::boolean = true AND
    (p_checklist ? 'network')     AND (p_checklist->>'network')::boolean = true AND
    (p_checklist ? 'token')       AND (p_checklist->>'token')::boolean = true AND
    (p_checklist ? 'sender')      AND (p_checklist->>'sender')::boolean = true AND
    (p_checklist ? 'recipient')   AND (p_checklist->>'recipient')::boolean = true AND
    (p_checklist ? 'amount')      AND (p_checklist->>'amount')::boolean = true AND
    (p_checklist ? 'finality')    AND (p_checklist->>'finality')::boolean = true AND
    (p_checklist ? 'wallet_info') AND (p_checklist->>'wallet_info')::boolean = true
  ) THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: all 8 checklist items must be explicitly confirmed (txid, network, token, sender, recipient, amount, finality, wallet_info)';
  END IF;

  -- Lock the deposit row
  SELECT * INTO v_deposit
  FROM public.deposits
  WHERE id = p_deposit_id
  FOR UPDATE;

  IF v_deposit.id IS NULL THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit not found';
  END IF;

  IF v_deposit.status = 'CREDITED' THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit is already credited';
  END IF;

  IF v_deposit.status <> 'PENDING_VERIFICATION' THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit must be in PENDING_VERIFICATION status (current: %)', v_deposit.status;
  END IF;

  -- Phase 14 marker: deposit_method_id must be set.
  -- This function only operates on Phase 14 deposits.
  IF v_deposit.deposit_method_id IS NULL THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit has no deposit method (not a Phase 14 deposit)';
  END IF;

  -- CRITICAL: blockchain verification must have completed
  IF v_deposit.blockchain_verified_at IS NULL THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit has not been blockchain verified yet';
  END IF;

  -- CRITICAL: verified_amount must be set
  IF v_deposit.verified_amount IS NULL OR v_deposit.verified_amount <= 0 THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit has no verified amount';
  END IF;

  -- Idempotency: if already manually verified, reject
  IF v_deposit.manually_verified_at IS NOT NULL THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit has already been manually verified';
  END IF;

  -- Record manual verification
  UPDATE public.deposits
     SET manually_verified_at         = now(),
         manually_verified_by         = v_admin_id,
         manual_verification_notes    = NULLIF(trim(p_notes), ''),
         manual_verification_checklist = p_checklist,
         updated_at                   = now()
   WHERE id = p_deposit_id;

  -- Audit log (no 2FA verification_id here — this RPC doesn't require 2FA)
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (
    v_admin_id,
    'DEPOSIT_MANUALLY_VERIFIED',
    'deposit',
    p_deposit_id,
    jsonb_build_object(
      'deposit_id', p_deposit_id,
      'user_id', v_deposit.user_id,
      'verified_amount', v_deposit.verified_amount,
      'declared_amount', v_deposit.declared_amount,
      'tx_hash', v_deposit.tx_hash,
      'notes_provided', p_notes IS NOT NULL,
      'checklist', p_checklist
    )
  );

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_manually_verify_deposit(UUID, JSONB, TEXT) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_manually_verify_deposit(UUID, JSONB, TEXT) TO   authenticated;

-- =============================================================================
-- 7. TRIGGER: Phase 14 Status-Transition Guard
--
--    PURPOSE:
--    Prevents Phase 14 deposits from ever reaching PENDING or UNDER_REVIEW
--    status, which would expose them to the legacy admin_credit_deposit()
--    path (Migration 012) that accepts a client-supplied amount.
--
--    PHASE 14 MARKER:
--    deposits.deposit_method_id IS NOT NULL
--    This column is set exclusively by submit_deposit() (Migration 011b)
--    and is never modified by any function after INSERT.
--    Legacy deposits (created by the old create_deposit()) have NULL.
--
--    BLOCKED TRANSITIONS (for Phase 14 deposits only):
--    - PENDING_VERIFICATION → PENDING
--    - PENDING_VERIFICATION → UNDER_REVIEW
--    - REJECTED → PENDING
--    - REJECTED → UNDER_REVIEW
--    - Any status → PENDING / UNDER_REVIEW (when deposit_method_id IS NOT NULL)
--
--    ALLOWED TRANSITIONS (for Phase 14 deposits):
--    - PENDING_VERIFICATION → REJECTED  (legitimate admin rejection)
--    - PENDING_VERIFICATION → CREDITED  (via admin_credit_verified_deposit)
--
--    LEGACY DEPOSITS (deposit_method_id IS NULL):
--    All transitions are unaffected. The trigger guard does not fire.
--
--    SAFETY:
--    - Uses DROP TRIGGER IF EXISTS + CREATE TRIGGER for rerunnability.
--    - Trigger function uses CREATE OR REPLACE for rerunnability.
--    - WHEN clause ensures the trigger body only evaluates on status changes.
--    - Does NOT interfere with non-status updates (e.g., blockchain
--      verification column changes by the Edge Function).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.trg_fn_enforce_phase14_status_transitions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only evaluate when status is actually changing.
  -- This prevents false blocks on non-status updates such as
  -- verification column changes by the Edge Function or
  -- updated_at changes by the trg_deposits_updated_at trigger.
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  -- Phase 14 deposit identification:
  -- deposit_method_id is set exclusively by submit_deposit() (Migration 011b)
  -- at creation time. It is never modified by any subsequent function.
  -- Legacy deposits (created by the old create_deposit() before Migration 011b)
  -- always have deposit_method_id = NULL.
  IF NEW.deposit_method_id IS NOT NULL THEN
    -- Block Phase 14 deposits from entering PENDING or UNDER_REVIEW.
    -- These are the only two statuses accepted by the legacy
    -- admin_credit_deposit() (Migration 012), which credits using
    -- a client-supplied p_amount. By preventing Phase 14 deposits
    -- from ever entering these statuses — regardless of the transition
    -- chain (direct, via REJECTED, or any other path) — we guarantee
    -- that admin_credit_deposit() can NEVER credit a Phase 14 deposit.
    IF NEW.status IN ('PENDING', 'UNDER_REVIEW') THEN
      RAISE EXCEPTION
        'Phase 14 security: cannot transition a Phase 14 deposit '
        '(deposit_method_id is set) to status %. '
        'Phase 14 deposits can only be REJECTED or credited via '
        'admin_credit_verified_deposit() using the blockchain-verified amount.',
        NEW.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_phase14_status_transitions ON public.deposits;

CREATE TRIGGER trg_enforce_phase14_status_transitions
  BEFORE UPDATE ON public.deposits
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_fn_enforce_phase14_status_transitions();

-- =============================================================================
-- 8. RPC: admin_credit_verified_deposit
--    Phase 14 dedicated credit function for blockchain-verified deposits.
--
--    This function COEXISTS with admin_credit_deposit() (Migration 012).
--    It does NOT replace, modify, or overwrite admin_credit_deposit().
--
--    admin_credit_deposit()           → credits PENDING / UNDER_REVIEW deposits
--                                         (legacy path, uses client-supplied p_amount)
--    admin_credit_verified_deposit()  → credits PENDING_VERIFICATION deposits
--                                         after blockchain + manual verification
--                                         (uses DB-derived verified_amount only)
--
--    CRITICAL: No p_amount parameter. The credit amount is derived
--    EXCLUSIVELY from deposits.verified_amount. The client supplies
--    only the deposit ID and the 2FA verification token.
--
--    Authorization: is_admin_user() + admin_financial 2FA
--    Idempotency: rejects already-CREDITED deposits
--    Locking: SELECT FOR UPDATE on deposit + wallet balance
--    Atomic: wallet update + ledger entry + status change in single transaction
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_credit_verified_deposit(
  p_deposit_id      UUID,
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
  v_credit_amount    NUMERIC(18,6);
  v_admin_id         UUID := auth.uid();
BEGIN
  -- 1. Authentication
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- 2. Authorization: must be admin
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 3. admin_financial 2FA verification
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');

  -- 4. Parameter validation
  IF p_deposit_id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit_id is required';
  END IF;

  -- 5. Lock the deposit row
  SELECT * INTO v_deposit
  FROM public.deposits
  WHERE id = p_deposit_id
  FOR UPDATE;

  -- 6. Deposit must exist
  IF v_deposit.id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit not found';
  END IF;

  -- 7. Reject already-credited deposits (idempotency)
  IF v_deposit.status = 'CREDITED' THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit already credited';
  END IF;

  -- 8. Status must be exactly PENDING_VERIFICATION
  IF v_deposit.status <> 'PENDING_VERIFICATION' THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit must be in PENDING_VERIFICATION status (current: %)', v_deposit.status;
  END IF;

  -- Phase 14 marker: deposit_method_id must be set.
  -- This function only operates on Phase 14 deposits.
  IF v_deposit.deposit_method_id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit has no deposit method (not a Phase 14 deposit)';
  END IF;

  -- 9. Blockchain verification must have completed
  IF v_deposit.blockchain_verified_at IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: blockchain verification has not completed';
  END IF;

  -- 10. Manual admin verification must have completed
  IF v_deposit.manually_verified_at IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: manual admin verification has not completed';
  END IF;

  -- 11. Manual verification checklist must be present
  IF v_deposit.manual_verification_checklist IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: manual verification checklist is missing';
  END IF;

  -- 12. Validate all 8 checklist items are present and TRUE
  IF NOT (
    (v_deposit.manual_verification_checklist ? 'txid')        AND (v_deposit.manual_verification_checklist->>'txid')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'network')     AND (v_deposit.manual_verification_checklist->>'network')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'token')       AND (v_deposit.manual_verification_checklist->>'token')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'sender')      AND (v_deposit.manual_verification_checklist->>'sender')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'recipient')   AND (v_deposit.manual_verification_checklist->>'recipient')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'amount')      AND (v_deposit.manual_verification_checklist->>'amount')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'finality')    AND (v_deposit.manual_verification_checklist->>'finality')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'wallet_info') AND (v_deposit.manual_verification_checklist->>'wallet_info')::boolean = true
  ) THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: manual verification checklist is incomplete';
  END IF;

  -- 13. verified_amount must be set and positive
  IF v_deposit.verified_amount IS NULL OR v_deposit.verified_amount <= 0 THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit has no valid verified amount';
  END IF;

  -- 14. DERIVE the credit amount exclusively from the database.
  --     No client-supplied amount is accepted. This is the authoritative value.
  v_credit_amount := v_deposit.verified_amount;

  -- 15. Lock the user's wallet balance
  SELECT wb.wallet_id, wb.available_usdt
    INTO v_wallet_id, v_balance_before
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = v_deposit.user_id
     FOR UPDATE OF wb;

  -- 16. Wallet must exist
  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: wallet not found';
  END IF;

  -- 17. Credit the wallet using verified_amount
  UPDATE public.wallet_balances
     SET available_usdt = available_usdt + v_credit_amount,
         updated_at     = now()
   WHERE wallet_id = v_wallet_id;

  -- 18. Insert ledger entry
  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after,
     reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'CREDIT', v_credit_amount, v_balance_before,
          v_balance_before + v_credit_amount, 'deposit', p_deposit_id,
          jsonb_build_object(
            'direction', 'credit',
            'context', 'admin_verified_deposit_credit',
            'verified_amount', v_deposit.verified_amount,
            'declared_amount', v_deposit.declared_amount,
            'blockchain_verified_at', v_deposit.blockchain_verified_at,
            'manually_verified_at', v_deposit.manually_verified_at,
            'verification_id', p_verification_id
          ));

  -- 19. Mark deposit as CREDITED
  UPDATE public.deposits
     SET status = 'CREDITED',
         actual_amount = v_credit_amount,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'credited_at', now(),
           'credited_by', v_admin_id,
           'verified_amount', v_deposit.verified_amount,
           'declared_amount', v_deposit.declared_amount,
           'credit_function', 'admin_credit_verified_deposit'
         ),
         updated_at = now()
   WHERE id = p_deposit_id;

  -- 20. Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (v_admin_id, 'DEPOSIT_CREDITED', 'deposit', p_deposit_id,
    jsonb_build_object(
      'amount', v_credit_amount,
      'verified_amount', v_deposit.verified_amount,
      'declared_amount', v_deposit.declared_amount,
      'previous_status', 'PENDING_VERIFICATION',
      'new_status', 'CREDITED',
      'user_id', v_deposit.user_id,
      'verification_id', p_verification_id,
      'credit_function', 'admin_credit_verified_deposit',
      'blockchain_verified_at', v_deposit.blockchain_verified_at,
      'manually_verified_at', v_deposit.manually_verified_at
    ));

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_credit_verified_deposit(UUID, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_credit_verified_deposit(UUID, UUID) TO   authenticated;

-- =============================================================================
-- 9. RPC: admin_list_blockchain_verified_deposits
--    Admin UI: list deposits that are blockchain-verified and awaiting manual review.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_list_blockchain_verified_deposits()
RETURNS TABLE (
  id                    UUID,
  user_id               UUID,
  user_email            TEXT,
  network               TEXT,
  token                 TEXT,
  declared_amount       NUMERIC,
  verified_amount       NUMERIC,
  tx_hash               TEXT,
  destination_address   TEXT,
  status                TEXT,
  created_at            TIMESTAMPTZ,
  blockchain_verified_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT d.id, d.user_id, p.email, d.network, d.token,
         d.declared_amount, d.verified_amount, d.tx_hash, d.destination_address,
         d.status, d.created_at, d.blockchain_verified_at
  FROM public.deposits d
  LEFT JOIN public.profiles p ON p.id = d.user_id
  WHERE d.status = 'PENDING_VERIFICATION'
    AND d.blockchain_verified_at IS NOT NULL
    AND d.manually_verified_at IS NULL
  ORDER BY d.blockchain_verified_at ASC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_list_blockchain_verified_deposits() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_list_blockchain_verified_deposits() TO   authenticated;

-- =============================================================================
-- 10. RPC: admin_list_pending_blockchain_verification
--    Admin UI: list deposits still awaiting blockchain verification.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_list_pending_blockchain_verification()
RETURNS TABLE (
  id                    UUID,
  user_id               UUID,
  user_email            TEXT,
  network               TEXT,
  token                 TEXT,
  declared_amount       NUMERIC,
  tx_hash               TEXT,
  status                TEXT,
  created_at            TIMESTAMPTZ,
  blockchain_verification_attempts INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT d.id, d.user_id, p.email, d.network, d.token,
         d.declared_amount, d.tx_hash, d.status, d.created_at,
         d.blockchain_verification_attempts
  FROM public.deposits d
  LEFT JOIN public.profiles p ON p.id = d.user_id
  WHERE d.status = 'PENDING_VERIFICATION'
    AND d.blockchain_verified_at IS NULL
  ORDER BY d.created_at ASC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_list_pending_blockchain_verification() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_list_pending_blockchain_verification() TO   authenticated;

-- =============================================================================
-- 11. RPC: admin_list_deposits_v2
--    Upgraded admin deposit listing that includes Phase 14 columns.
--    Does NOT modify the existing admin_list_deposits() (Migration 003).
--    The existing function remains intact for backward compatibility.
--
--    This function returns all columns from admin_list_deposits() plus:
--    declared_amount, verified_amount, destination_address,
--    blockchain_verified_at, manually_verified_at,
--    blockchain_verification_error, blockchain_verification_attempts
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_list_deposits_v2(
  p_status TEXT DEFAULT NULL
)
RETURNS TABLE (
  id                              UUID,
  user_id                         UUID,
  user_email                      TEXT,
  network                         TEXT,
  token                           TEXT,
  expected_amount                 NUMERIC,
  actual_amount                   NUMERIC,
  tx_hash                         TEXT,
  status                          TEXT,
  metadata                        JSONB,
  created_at                      TIMESTAMPTZ,
  updated_at                      TIMESTAMPTZ,
  declared_amount                 NUMERIC,
  verified_amount                 NUMERIC,
  destination_address             TEXT,
  blockchain_verified_at          TIMESTAMPTZ,
  manually_verified_at            TIMESTAMPTZ,
  blockchain_verification_error   TEXT,
  blockchain_verification_attempts INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    d.id, d.user_id, p.email, d.network, d.token,
    d.expected_amount, d.actual_amount, d.tx_hash,
    d.status, d.metadata, d.created_at, d.updated_at,
    d.declared_amount, d.verified_amount, d.destination_address,
    d.blockchain_verified_at, d.manually_verified_at,
    d.blockchain_verification_error, d.blockchain_verification_attempts
  FROM public.deposits d
  JOIN public.profiles p ON p.id = d.user_id
  WHERE COALESCE(p_status, d.status) = d.status
  ORDER BY d.created_at DESC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_list_deposits_v2(TEXT) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_list_deposits_v2(TEXT) TO   authenticated;

-- =============================================================================
-- 12. MIGRATION COMPLETE
-- =============================================================================
-- Phase 14b: TRC20 USDT Blockchain Verification + Manual Admin Verification
-- (Corrected — does NOT modify admin_credit_deposit or admin_update_deposit_status)
--
-- ARCHITECTURE:
--
--   USER
--     ↓
--   USER 2FA (user_transaction scope, for submit_deposit)
--     ↓
--   PENDING_VERIFICATION (deposit_method_id set — Phase 14 marker)
--     ↓
--   BLOCKCHAIN VERIFICATION (server-side Edge Function, TronGrid, idempotent)
--     ↓
--   BLOCKCHAIN VERIFIED  (verified_amount set, blockchain_verified_at set)
--     ↓
--   ADMIN MANUAL VERIFICATION (no 2FA, 8-item checklist confirmation)
--     ↓
--   MANUALLY VERIFIED    (manually_verified_at set, checklist stored)
--     ↓
--   ADMIN CLICKS "Credit Deposit"
--     ↓
--   ADMIN_FINANCIAL 2FA  (the SINGLE financial 2FA challenge)
--     ↓
--   admin_credit_verified_deposit()  (uses DB-derived verified_amount ONLY)
--     ↓
--   wallet balance + ledger + deposit status = CREDITED
--
-- STATE-MACHINE SECURITY:
--   A database trigger (trg_enforce_phase14_status_transitions) prevents
--   Phase 14 deposits (deposit_method_id IS NOT NULL) from ever entering
--   PENDING or UNDER_REVIEW status. This closes all bypass paths to the
--   legacy admin_credit_deposit() function:
--     - PENDING_VERIFICATION → PENDING         BLOCKED
--     - PENDING_VERIFICATION → UNDER_REVIEW    BLOCKED
--     - REJECTED → PENDING (for Phase 14)      BLOCKED
--     - REJECTED → UNDER_REVIEW (for Phase 14) BLOCKED
--   Legacy deposits (deposit_method_id IS NULL) are unaffected.
--
-- ADDED COLUMNS (10):
--   blockchain_verified_at, blockchain_verification_data, blockchain_provider,
--   blockchain_verification_error, blockchain_verification_attempts,
--   blockchain_verification_last_attempt_at, manually_verified_at,
--   manually_verified_by, manual_verification_notes, manual_verification_checklist
--
-- ADDED CONSTRAINTS (5):
--   chk_blockchain_verified_at_past, chk_verified_amount_positive,
--   chk_blockchain_attempts_nonneg, chk_manual_verification_consistency,
--   chk_manual_checklist_structure
--
-- ADDED INDEXES (2):
--   idx_deposits_pending_blockchain_verification,
--   idx_deposits_pending_manual_verification
--
-- ADDED TRIGGER (1):
--   trg_enforce_phase14_status_transitions (BEFORE UPDATE on deposits)
--
-- ADDED RPCs (7):
--   request_blockchain_verification(deposit_id)                  [user-callable]
--   get_deposit_verification_details(deposit_id)                 [admin only]
--   admin_manually_verify_deposit(deposit_id, notes, checklist)  [admin only, NO 2FA]
--   admin_credit_verified_deposit(deposit_id, verification_id)   [admin only, admin_financial 2FA]
--   admin_list_blockchain_verified_deposits()                    [admin only]
--   admin_list_pending_blockchain_verification()                 [admin only]
--   admin_list_deposits_v2(status)                               [admin only]
--
-- NOT MODIFIED:
--   admin_credit_deposit()          — Migration 012 version preserved
--   admin_update_deposit_status()   — Migration 013 version preserved
--   admin_list_deposits()           — Migration 003 version preserved
--
-- BEP20: not activated. Only TRC20 deposit methods are active.
-- =============================================================================
