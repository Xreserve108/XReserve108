-- XReserve Phase 12C — Secure User Deposit Submission & Verification Queue
-- Extends the existing deposits table to support user-initiated deposit
-- submissions with TXID tracking, blockchain URL, and destination address
-- binding to the authoritative Active Deposit Method.
--
-- KEY PRINCIPLES:
-- - User-entered amount is DECLARATIVE only, never trusted for crediting
-- - Destination address resolved server-side from active deposit method
-- - TXID uniqueness enforced at database level (per network)
-- - All submissions require user_transaction 2FA scope
-- - Deposit created as PENDING_VERIFICATION — NO wallet crediting
-- - Existing create_deposit() RPC replaced with secure submit_deposit()
--
-- =============================================================================
-- 1. EXTEND DEPOSITS TABLE
--    Add columns needed for the Phase 12C submission workflow.
--    Existing columns preserved; new columns are additive.
-- =============================================================================

-- Destination address: the authoritative deposit address the user sent to.
-- Resolved server-side from the active deposit method — never trusted from client.
ALTER TABLE public.deposits
ADD COLUMN IF NOT EXISTS destination_address TEXT;

-- Blockchain explorer URL (optional, user-provided for admin convenience)
ALTER TABLE public.deposits
ADD COLUMN IF NOT EXISTS blockchain_url TEXT;

-- User-declared amount: the amount the user claims to have sent.
-- This is DECLARATIVE ONLY and must never be used for wallet crediting.
-- The existing expected_amount column serves a similar purpose, but we add
-- declared_amount for semantic clarity in the Phase 12C workflow.
ALTER TABLE public.deposits
ADD COLUMN IF NOT EXISTS declared_amount NUMERIC(18,6);

-- Verified amount: the amount actually confirmed on the blockchain.
-- NULL until blockchain verification occurs (future phase).
ALTER TABLE public.deposits
ADD COLUMN IF NOT EXISTS verified_amount NUMERIC(18,6);

-- Deposit method reference: links to the deposit_methods table row
-- that was active at the time of submission.
ALTER TABLE public.deposits
ADD COLUMN IF NOT EXISTS deposit_method_id UUID;

-- =============================================================================
-- 2. EXTEND STATUS CHECK CONSTRAINT
--    Add PENDING_VERIFICATION to the allowed status values.
--    Must drop old constraint and recreate with new value.
-- =============================================================================

ALTER TABLE public.deposits DROP CONSTRAINT IF EXISTS deposits_status_check;

ALTER TABLE public.deposits ADD CONSTRAINT deposits_status_check
CHECK (status IN (
  'PENDING',
  'PENDING_VERIFICATION',
  'UNDER_REVIEW',
  'CREDITED',
  'REJECTED'
));

-- =============================================================================
-- 3. AMOUNT VALIDATION CONSTRAINT
--    declared_amount must be positive if provided.
-- =============================================================================

ALTER TABLE public.deposits DROP CONSTRAINT IF EXISTS chk_declared_amount_positive;
ALTER TABLE public.deposits ADD CONSTRAINT chk_declared_amount_positive
CHECK (declared_amount IS NULL OR declared_amount > 0);

-- =============================================================================
-- 4. BLOCKCHAIN URL VALIDATION
--    If provided, must be HTTPS. Reject javascript:, data:, file: etc.
-- =============================================================================

ALTER TABLE public.deposits DROP CONSTRAINT IF EXISTS chk_blockchain_url_scheme;
ALTER TABLE public.deposits ADD CONSTRAINT chk_blockchain_url_scheme
CHECK (
  blockchain_url IS NULL
  OR char_length(trim(blockchain_url)) = 0
  OR lower(trim(blockchain_url)) LIKE 'https://%'
);

-- =============================================================================
-- 5. TXID UNIQUENESS INDEX
--    Enforce TXID uniqueness per network at the database level.
--    Only non-null, non-empty tx_hash values are considered.
--    This is a partial unique index — global per network.
--    A transaction ID is unique on a given blockchain regardless of user.
--
--    IMPORTANT: Migration 001 created idx_deposits_tx_hash_unique on (tx_hash)
--    which enforced GLOBAL uniqueness (same tx_hash blocked across ALL networks).
--    Phase 12C requires PER-NETWORK uniqueness (same tx_hash allowed on different
--    networks). The old index must be dropped to avoid blocking valid submissions
--    and to prevent constraint violations during INSERT.
-- =============================================================================

DROP INDEX IF EXISTS public.idx_deposits_tx_hash_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_tx_hash_per_network
  ON public.deposits (network, tx_hash)
  WHERE tx_hash IS NOT NULL AND char_length(trim(tx_hash)) > 0;

-- =============================================================================
-- 6. INDEXES for Phase 12C queries
-- =============================================================================

-- Pending verification deposits (for user's own pending view)
CREATE INDEX IF NOT EXISTS idx_deposits_user_status_pending
  ON public.deposits (user_id, status)
  WHERE status IN ('PENDING', 'PENDING_VERIFICATION');

-- =============================================================================
-- 7. REPLACE create_deposit() WITH submit_deposit()
--    The old create_deposit() is dropped and replaced with a new function
--    that:
--    1. Derives auth.uid()
--    2. Validates active deposit method for the network
--    3. Resolves authoritative destination address
--    4. Validates amount (positive, reasonable precision)
--    5. Validates TXID (non-empty, trimmed)
--    6. Validates optional blockchain URL (HTTPS only)
--    7. Requires user_transaction 2FA verification
--    8. Consumes verification token atomically
--    9. Checks duplicate TXID (database constraint)
--    10. Inserts deposit as PENDING_VERIFICATION
--    11. Records audit log
--    12. Returns deposit ID + status
-- =============================================================================

-- Drop old signature
DROP FUNCTION IF EXISTS public.create_deposit(TEXT, TEXT, NUMERIC, TEXT, UUID);

CREATE OR REPLACE FUNCTION public.submit_deposit(
  p_network         TEXT,
  p_declared_amount NUMERIC,
  p_tx_hash         TEXT,
  p_blockchain_url  TEXT DEFAULT NULL,
  p_verification_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id         UUID := auth.uid();
  v_deposit_id      UUID;
  v_deposit_status TEXT;
  v_method_id       UUID;
  v_dest_address    TEXT;
  v_asset           TEXT;
  v_clean_url       TEXT;
  v_clean_txid      TEXT;
BEGIN
  -- 1. Authentication
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- 2. Validate network — derive allowed networks from active deposit methods
  --    rather than relying on a hardcoded whitelist. This ensures BEP20 (or any
  --    other network) remains blocked until an admin explicitly activates a
  --    deposit method for it in the deposit_methods table.
  --    (Active method resolution below is the authoritative gate.)
  SELECT dm.id, dm.deposit_address, dm.asset
  INTO v_method_id, v_dest_address, v_asset
  FROM public.deposit_methods dm
  WHERE dm.network = p_network
    AND dm.is_active = true
  LIMIT 1;

  IF v_method_id IS NULL THEN
    RAISE EXCEPTION 'No active deposit method available for this network';
  END IF;

  -- 4. Validate declared amount
  IF p_declared_amount IS NULL THEN
    RAISE EXCEPTION 'Please enter a valid USDT amount greater than zero';
  END IF;
  IF p_declared_amount <= 0 THEN
    RAISE EXCEPTION 'Please enter a valid USDT amount greater than zero';
  END IF;
  -- Prevent absurd precision: max 6 decimal places (USDT on TRC20 has 6 decimals)
  IF p_declared_amount != ROUND(p_declared_amount, 6) THEN
    RAISE EXCEPTION 'Amount has too many decimal places';
  END IF;
  -- Prevent absurdly large amounts (sanity check: 1 billion USDT)
  IF p_declared_amount > 1000000000 THEN
    RAISE EXCEPTION 'Amount exceeds maximum allowed value';
  END IF;
  -- Reject NaN/Infinity (defensive — NUMERIC type should prevent this)
  IF p_declared_amount::TEXT = 'NaN' OR p_declared_amount::TEXT ~ '^[Ii]nf' THEN
    RAISE EXCEPTION 'Invalid amount value';
  END IF;

  -- 5. Validate TXID
  v_clean_txid := NULLIF(trim(p_tx_hash), '');
  IF v_clean_txid IS NULL THEN
    RAISE EXCEPTION 'Please enter the transaction ID';
  END IF;
  -- Reasonable max length for blockchain TXIDs (TRC20 tx hashes are 64 hex chars)
  IF char_length(v_clean_txid) > 256 THEN
    RAISE EXCEPTION 'Transaction ID is too long';
  END IF;

  -- 6. Validate optional blockchain URL
  v_clean_url := NULLIF(trim(p_blockchain_url), '');
  IF v_clean_url IS NOT NULL THEN
    IF char_length(v_clean_url) > 2048 THEN
      RAISE EXCEPTION 'Blockchain URL is too long';
    END IF;
    -- HTTPS check (redundant with CHECK constraint, but gives better error message)
    IF lower(v_clean_url) NOT LIKE 'https://%' THEN
      RAISE EXCEPTION 'Blockchain URL must use HTTPS';
    END IF;
    -- Reject obviously dangerous patterns
    IF lower(v_clean_url) LIKE '%javascript:%'
       OR lower(v_clean_url) LIKE '%data:%'
       OR lower(v_clean_url) LIKE '%file:%' THEN
      RAISE EXCEPTION 'Invalid blockchain URL';
    END IF;
  END IF;

  -- 7. Require 2FA verification with user_transaction scope
  PERFORM public._require_2fa_verification(p_verification_id, 'user_transaction');

  -- 8. Insert deposit — TXID uniqueness enforced by partial unique index
  --    If duplicate TXID on same network, the unique index will raise an error
  --    which we catch and re-raise with a user-friendly message.
  BEGIN
    INSERT INTO public.deposits (
      user_id,
      token,
      network,
      expected_amount,
      declared_amount,
      tx_hash,
      destination_address,
      blockchain_url,
      deposit_method_id,
      status
    )
    VALUES (
      v_user_id,
      v_asset,
      p_network,
      p_declared_amount,
      p_declared_amount,
      v_clean_txid,
      v_dest_address,
      v_clean_url,
      v_method_id,
      'PENDING_VERIFICATION'
    )
    RETURNING id, status INTO v_deposit_id, v_deposit_status;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This transaction has already been submitted and is currently being processed. Please check Pending Transactions rather than submitting it again.';
  END;

  -- 9. Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (
    v_user_id,
    'DEPOSIT_SUBMITTED',
    'deposit',
    v_deposit_id,
    jsonb_build_object(
      'network', p_network,
      'declared_amount', p_declared_amount,
      'asset', v_asset,
      'destination_address', v_dest_address,
      'tx_hash', v_clean_txid,
      'deposit_method_id', v_method_id,
      'status', v_deposit_status,
      'verification_id', p_verification_id,
      'blockchain_url_provided', v_clean_url IS NOT NULL
    )
  );

  -- 10. Return deposit info
  RETURN jsonb_build_object(
    'deposit_id', v_deposit_id,
    'status', v_deposit_status,
    'network', p_network,
    'declared_amount', p_declared_amount,
    'asset', v_asset
  );
END;
$$;

-- =============================================================================
-- 8. USER PENDING DEPOSITS RPC
--    Returns the user's own pending verification deposits.
--    Uses RLS (deposits_select_own policy) for data access.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_user_pending_deposits()
RETURNS TABLE (
  id                UUID,
  network           TEXT,
  asset             TEXT,
  declared_amount   NUMERIC,
  destination_address TEXT,
  tx_hash           TEXT,
  blockchain_url    TEXT,
  status            TEXT,
  created_at        TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN QUERY
  SELECT d.id, d.network, d.token, d.declared_amount,
         d.destination_address, d.tx_hash, d.blockchain_url,
         d.status, d.created_at
  FROM public.deposits d
  WHERE d.user_id = auth.uid()
    AND d.status IN ('PENDING', 'PENDING_VERIFICATION')
  ORDER BY d.created_at DESC;
END;
$$;

-- =============================================================================
-- 9. UPDATE admin_credit_deposit() TO ACCEPT PENDING_VERIFICATION
--    Phase 12C introduces PENDING_VERIFICATION status. The admin credit
--    function (originally from migration 006) only accepted PENDING and
--    UNDER_REVIEW. This update adds PENDING_VERIFICATION to the allowed
--    statuses so admins can review and credit Phase 12C deposits.
--    All other security controls remain identical:
--    - is_admin_user() check
--    - admin_financial 2FA scope via _require_admin_2fa()
--    - SELECT FOR UPDATE on deposit row
--    - Rejects already-credited, rejected, or invalid statuses
--    - Admin-supplied amount (not user-declared amount) is used for credit
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
  IF v_deposit.status NOT IN ('PENDING', 'PENDING_VERIFICATION', 'UNDER_REVIEW') THEN
    RAISE EXCEPTION 'admin_credit_deposit: cannot credit deposit with status %', v_deposit.status;
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
-- 10. SECURITY — REVOKE CLIENT ACCESS
-- =============================================================================

-- New submit RPC: revoke from anon/public (authenticated only)
REVOKE EXECUTE ON FUNCTION public.submit_deposit(TEXT, NUMERIC, TEXT, TEXT, UUID) FROM anon, public;

-- Pending deposits RPC: revoke from anon/public
REVOKE EXECUTE ON FUNCTION public.get_user_pending_deposits() FROM anon, public;

-- =============================================================================
-- 11. MIGRATION COMPLETE
-- =============================================================================
-- Phase 12C: Secure User Deposit Submission & Verification Queue
-- - Extended deposits table with destination_address, blockchain_url,
--   declared_amount, verified_amount, deposit_method_id columns
-- - Added PENDING_VERIFICATION status
-- - Dropped old idx_deposits_tx_hash_unique (global) in favor of
--   idx_deposits_tx_hash_per_network (per-network uniqueness)
-- - submit_deposit() replaces create_deposit() with full validation:
--   auth, active method resolution (no hardcoded network whitelist),
--   amount validation, TXID validation, URL validation, 2FA verification,
--   atomic token consumption
-- - Destination address resolved server-side from active deposit method
-- - User-entered amount stored as declared_amount (never trusted for credit)
-- - get_user_pending_deposits() for user's own pending view
-- - admin_credit_deposit() updated to accept PENDING_VERIFICATION status
-- - All client DML access revoked
-- =============================================================================
