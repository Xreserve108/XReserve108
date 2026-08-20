-- XReserve Phase 14 — TRC20 USDT Blockchain Verification + Manual Admin Verification
-- SECURITY-FIRST IMPLEMENTATION
--
-- ARCHITECTURE (SINGLE admin_financial 2FA CHALLENGE — AT CREDIT TIME ONLY):
-- 1. USER SUBMITS DEPOSIT (with user_transaction 2FA)  → PENDING_VERIFICATION
-- 2. SERVER-SIDE BLOCKCHAIN VERIFICATION              → sets verified_amount
-- 3. ADMIN MANUAL VERIFICATION (no 2FA — just checklist confirmation) → marks manually_verified_at
-- 4. ADMIN CLICKS "Credit Deposit"
-- 5. ADMIN_FINANCIAL 2FA CHALLENGE (single)
-- 6. admin_credit_deposit() executes the wallet credit using the
--    server-derived verified_amount (NOT p_amount)
--
-- KEY PRINCIPLES:
-- - The blockchain is the source of truth for the actual received amount
-- - The user-declared amount is NEVER used for crediting
-- - The admin CANNOT override the verified blockchain amount
-- - The single 2FA challenge is at the actual financial action (credit)
-- - Manual verification is a logged confirmation with a mandatory checklist
-- - TRC20 only — BEP20 must remain inactive
--
-- DO NOT execute this migration. Manual review required.
-- DO NOT modify migrations 001-013.

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

-- verified_amount already exists from migration 011; ensure positive when set
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

REVOKE EXECUTE ON FUNCTION public.get_deposit_verification_details(UUID) FROM anon, public, authenticated;

-- =============================================================================
-- 6. RPC: admin_manually_verify_deposit
--    Admin records manual verification AFTER blockchain verification has
--    succeeded. This is a logged confirmation action — it does NOT perform
--    any wallet write and does NOT require admin_financial 2FA.
--
--    The single admin_financial 2FA challenge is reserved exclusively for
--    the actual wallet credit (admin_credit_deposit).
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
--    These correspond to the items the admin must independently confirm
--    (TXID, TRC20 network, USDT token, sender, recipient, blockchain verified
--    amount, transaction status/finality, relevant wallet/blockchain info).
--
--    Records: manually_verified_at, manually_verified_by, manual_verification_notes,
--             manual_verification_checklist
--    Audit log: DEPOSIT_MANUALLY_VERIFIED
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_manually_verify_deposit(
  p_deposit_id UUID,
  p_notes      TEXT DEFAULT NULL,
  p_checklist  JSONB
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
  -- (admin_credit_deposit). Manual verification is a logged
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

REVOKE EXECUTE ON FUNCTION public.admin_manually_verify_deposit(UUID, TEXT, JSONB)
  FROM anon, public, authenticated;

-- =============================================================================
-- 7. STRENGTHEN admin_credit_deposit
--    The single admin_financial 2FA challenge happens immediately before the
--    wallet credit. p_amount is still accepted in the signature for backward
--    compatibility with existing UI, but the server is the source of truth:
--    the credit amount is COMPUTED from deposits.verified_amount, never from
--    p_amount. p_amount is validated as a cross-check and must equal the
--    server-side verified_amount, otherwise the request is rejected.
--
--    New validations:
--    - Blockchain verification must have completed (blockchain_verified_at IS NOT NULL)
--    - Manual admin verification must have completed (manually_verified_at IS NOT NULL)
--    - verified_amount must be set
--    - p_amount must equal verified_amount (admin cannot override)
--    - Manual verification checklist must be present and complete
--
--    Defense in depth:
--    - v_credit_amount := v_deposit.verified_amount (DB-derived, authoritative)
--    - The wallet update and ledger entry use v_credit_amount, NOT p_amount
--    - Even if the p_amount = verified_amount check were bypassed by a code
--      change, the credit would still use the DB value
--
--    All existing security preserved:
--    - is_admin_user() check
--    - admin_financial 2FA scope
--    - SELECT FOR UPDATE on deposit row
--    - SELECT FOR UPDATE on wallet balance
--    - Atomic wallet update + ledger entry + status change
--    - Rejects already-credited
--
--    This is implemented as CREATE OR REPLACE since we are overwriting
--    the migration 012 version. The signature remains identical.
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
  v_credit_amount    NUMERIC(18,6);  -- authoritative, derived from DB
BEGIN
  -- Authorization
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');

  -- Amount sanity (will be cross-checked against verified_amount below)
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'admin_credit_deposit: amount must be greater than zero';
  END IF;

  -- Lock the deposit row
  SELECT * INTO v_deposit
  FROM public.deposits
  WHERE id = p_deposit_id
  FOR UPDATE;

  IF v_deposit.id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_deposit: deposit not found';
  END IF;

  IF v_deposit.status = 'CREDITED' THEN
    RAISE EXCEPTION 'admin_credit_deposit: deposit already credited';
  END IF;

  -- Only PENDING_VERIFICATION deposits are creditable (the only state after
  -- both blockchain verification AND manual verification are complete).
  IF v_deposit.status NOT IN ('PENDING_VERIFICATION') THEN
    RAISE EXCEPTION 'admin_credit_deposit: cannot credit deposit with status %. Both blockchain and manual verification are required.', v_deposit.status;
  END IF;

  -- Phase 14: blockchain verification must have completed
  IF v_deposit.blockchain_verified_at IS NULL THEN
    RAISE EXCEPTION 'admin_credit_deposit: blockchain verification has not completed';
  END IF;

  -- Phase 14: manual admin verification must have completed
  IF v_deposit.manually_verified_at IS NULL THEN
    RAISE EXCEPTION 'admin_credit_deposit: manual admin verification has not completed';
  END IF;

  -- Phase 14: manual verification checklist must be present and complete
  IF v_deposit.manual_verification_checklist IS NULL
     OR NOT (
       (v_deposit.manual_verification_checklist ? 'txid')        AND (v_deposit.manual_verification_checklist->>'txid')::boolean = true AND
       (v_deposit.manual_verification_checklist ? 'network')     AND (v_deposit.manual_verification_checklist->>'network')::boolean = true AND
       (v_deposit.manual_verification_checklist ? 'token')       AND (v_deposit.manual_verification_checklist->>'token')::boolean = true AND
       (v_deposit.manual_verification_checklist ? 'sender')      AND (v_deposit.manual_verification_checklist->>'sender')::boolean = true AND
       (v_deposit.manual_verification_checklist ? 'recipient')   AND (v_deposit.manual_verification_checklist->>'recipient')::boolean = true AND
       (v_deposit.manual_verification_checklist ? 'amount')      AND (v_deposit.manual_verification_checklist->>'amount')::boolean = true AND
       (v_deposit.manual_verification_checklist ? 'finality')    AND (v_deposit.manual_verification_checklist->>'finality')::boolean = true AND
       (v_deposit.manual_verification_checklist ? 'wallet_info') AND (v_deposit.manual_verification_checklist->>'wallet_info')::boolean = true
     ) THEN
    RAISE EXCEPTION 'admin_credit_deposit: manual verification checklist is incomplete';
  END IF;

  -- Phase 14: verified_amount must be set
  IF v_deposit.verified_amount IS NULL OR v_deposit.verified_amount <= 0 THEN
    RAISE EXCEPTION 'admin_credit_deposit: deposit has no verified amount';
  END IF;

  -- Phase 14: DERIVE the credit amount from the database (defense in depth).
  -- Even if p_amount is tampered with at the application layer, the actual
  -- wallet credit and ledger entry use this DB-derived value, NOT p_amount.
  v_credit_amount := v_deposit.verified_amount;

  -- Phase 14: p_amount MUST equal verified_amount (rejects any override attempt)
  IF p_amount <> v_credit_amount THEN
    RAISE EXCEPTION 'admin_credit_deposit: amount (%) does not match blockchain-verified amount (%). Admin cannot override the verified amount.', p_amount, v_credit_amount;
  END IF;

  -- Lock wallet balance
  SELECT wb.wallet_id, wb.available_usdt
    INTO v_wallet_id, v_balance_before
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = v_deposit.user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_deposit: wallet not found';
  END IF;

  -- Update wallet balance (uses v_credit_amount from DB, NOT p_amount)
  UPDATE public.wallet_balances
     SET available_usdt = available_usdt + v_credit_amount,
         updated_at     = now()
   WHERE wallet_id = v_wallet_id;

  -- Insert ledger entry (uses v_credit_amount from DB, NOT p_amount)
  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'CREDIT', v_credit_amount, v_balance_before, v_balance_before + v_credit_amount,
          'deposit', p_deposit_id,
          jsonb_build_object(
            'direction', 'credit',
            'context', 'admin_deposit_credit',
            'verified_amount', v_deposit.verified_amount,
            'declared_amount', v_deposit.declared_amount,
            'blockchain_verified_at', v_deposit.blockchain_verified_at,
            'manually_verified_at', v_deposit.manually_verified_at
          ));

  -- Update deposit: set CREDITED, actual_amount, metadata
  -- actual_amount is set to v_credit_amount (the DB-derived value, not p_amount)
  UPDATE public.deposits
     SET status = 'CREDITED',
         actual_amount = v_credit_amount,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'credited_at', now(),
           'credited_by', auth.uid(),
           'verified_amount', v_deposit.verified_amount,
           'declared_amount', v_deposit.declared_amount
         ),
         updated_at = now()
   WHERE id = p_deposit_id;

  -- Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'DEPOSIT_CREDITED', 'deposit', p_deposit_id,
    jsonb_build_object(
      'amount', v_credit_amount,
      'p_amount_supplied', p_amount,
      'previous_status', v_deposit.status,
      'new_status', 'CREDITED',
      'user_id', v_deposit.user_id,
      'verified_amount', v_deposit.verified_amount,
      'declared_amount', v_deposit.declared_amount,
      'verification_id', p_verification_id
    ));

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_credit_deposit(UUID, NUMERIC, UUID) FROM anon, public;

-- =============================================================================
-- 8. RPC: admin_list_blockchain_verified_deposits
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

REVOKE EXECUTE ON FUNCTION public.admin_list_blockchain_verified_deposits() FROM anon, public, authenticated;

-- =============================================================================
-- 9. RPC: admin_list_pending_blockchain_verification
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

REVOKE EXECUTE ON FUNCTION public.admin_list_pending_blockchain_verification() FROM anon, public, authenticated;

-- =============================================================================
-- 10. MIGRATION COMPLETE
-- =============================================================================
-- Phase 14: TRC20 USDT Blockchain Verification + Manual Admin Verification
--
-- CORRECTED ARCHITECTURE (single 2FA challenge at credit time only):
--
--   USER
--     ↓
--   USER 2FA (user_transaction scope, for submit_deposit)
--     ↓
--   PENDING_VERIFICATION
--     ↓
--   BLOCKCHAIN VERIFICATION (server-side, TronGrid, idempotent)
--     ↓
--   BLOCKCHAIN VERIFIED  (verified_amount set, blockchain_verified_at set)
--     ↓
--   ADMIN MANUAL VERIFICATION (no 2FA, just 8-item checklist confirmation)
--     ↓
--   MANUALLY VERIFIED    (manually_verified_at set, checklist stored)
--     ↓
--   ADMIN CLICKS "Credit Deposit"
--     ↓
--   ADMIN_FINANCIAL 2FA  (the SINGLE financial 2FA challenge)
--     ↓
--   admin_credit_deposit()  (uses DB-derived verified_amount, NOT p_amount)
--     ↓
--   wallet balance + ledger + deposit status = CREDITED
--
-- Added columns to deposits:
--   - blockchain_verified_at (timestamp)
--   - blockchain_verification_data (JSONB)
--   - blockchain_provider (text)
--   - blockchain_verification_error (text)
--   - blockchain_verification_attempts (int)
--   - blockchain_verification_last_attempt_at (timestamp)
--   - manually_verified_at (timestamp)
--   - manually_verified_by (uuid)
--   - manual_verification_notes (text)
--   - manual_verification_checklist (JSONB)  [NEW]
--
-- Added RPCs:
--   - request_blockchain_verification(deposit_id)                  [user-callable]
--   - get_deposit_verification_details(deposit_id)                 [admin only]
--   - admin_manually_verify_deposit(deposit_id, notes, checklist)  [admin only, NO 2FA]
--   - admin_list_blockchain_verified_deposits()                    [admin only]
--   - admin_list_pending_blockchain_verification()                 [admin only]
--
-- Strengthened:
--   - admin_credit_deposit() now REQUIRES (single admin_financial 2FA):
--     * blockchain_verified_at IS NOT NULL
--     * manually_verified_at IS NOT NULL
--     * manual_verification_checklist complete (8 items all TRUE)
--     * p_amount = verified_amount (rejected otherwise)
--     * DEFENSE IN DEPTH: actual credit uses v_credit_amount := v_deposit.verified_amount
--       (not p_amount), so the wallet and ledger always reflect the DB value
--     * status must be PENDING_VERIFICATION
--
-- Security:
--   - All admin RPCs require is_admin_user()
--   - Only admin_credit_deposit() requires admin_financial 2FA
--   - admin_manually_verify_deposit() does NOT require 2FA
--   - Manual verification requires an 8-item checklist all TRUE
--   - User cannot modify verification state, verified_amount, or actual_amount
--     (RLS unchanged from migration 001: SELECT only for deposit owner)
--   - All client DML access revoked via REVOKE EXECUTE
--
-- BEP20: not activated. Only TRC20 deposit methods are active.
-- =============================================================================
