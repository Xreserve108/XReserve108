-- Migration 006: Phase 9C — Final 2FA RPC Security Audit
-- Self-contained: safe on fresh or existing database
-- Fixes: atomic token consumption, strict scope enforcement, deposit verification, dead code removal
-- Replaces all functions from migrations 004 and 005

-- ============================================================================
-- 0. EXTENSION
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. DROP DEAD CODE — PL/pgSQL TOTP functions (from 004, replaced by Edge Functions)
-- ============================================================================
DROP FUNCTION IF EXISTS public._base32_decode(TEXT);
DROP FUNCTION IF EXISTS public._verify_totp(TEXT, TEXT);
DROP FUNCTION IF EXISTS public._generate_base32_secret();
DROP FUNCTION IF EXISTS public.begin_2fa_enrollment();
DROP FUNCTION IF EXISTS public.confirm_2fa_enrollment(TEXT);
DROP FUNCTION IF EXISTS public.disable_2fa(TEXT);
DROP FUNCTION IF EXISTS public.verify_2fa_code(TEXT);
DROP FUNCTION IF EXISTS public.get_recovery_codes(TEXT);

-- Drop dead service-role helpers (from 002, superseded by 003 admin functions)
DROP FUNCTION IF EXISTS public.admin_complete_sell(UUID);
DROP FUNCTION IF EXISTS public.admin_reject_sell(UUID, TEXT);
DROP FUNCTION IF EXISTS public.credit_wallet(UUID, NUMERIC, TEXT, UUID);
DROP FUNCTION IF EXISTS public.release_reserved_usdt(UUID, NUMERIC);
DROP FUNCTION IF EXISTS public.consume_reserved_usdt(UUID, NUMERIC);

-- Drop old 2FA verification helpers (signatures changing)
DROP FUNCTION IF EXISTS public._require_2fa_verification(UUID);
DROP FUNCTION IF EXISTS public._require_2fa_verification(UUID, TEXT);
DROP FUNCTION IF EXISTS public._require_admin_2fa(UUID);
DROP FUNCTION IF EXISTS public._require_admin_2fa(UUID, TEXT);

-- Drop old financial RPC signatures (recreated below with strict 2FA)
DROP FUNCTION IF EXISTS public.create_deposit(TEXT, TEXT, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.create_sell_order(NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, UUID);
DROP FUNCTION IF EXISTS public.admin_update_deposit_status(UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS public.admin_credit_deposit(UUID, NUMERIC, UUID);
DROP FUNCTION IF EXISTS public.admin_complete_sell_order(UUID, UUID);
DROP FUNCTION IF EXISTS public.admin_reject_sell_order(UUID, TEXT, UUID);
DROP FUNCTION IF EXISTS public.admin_update_exchange_rate(NUMERIC, UUID);

-- ============================================================================
-- 2. TABLES (idempotent — preserved from 004/005)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_2fa (
  user_id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_secret    TEXT NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT false,
  key_version         INTEGER NOT NULL DEFAULT 1,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  last_verified_at    TIMESTAMPTZ,
  last_code_hash      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_2fa ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_2fa ADD COLUMN IF NOT EXISTS key_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS public.recovery_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id ON public.recovery_codes(user_id);
ALTER TABLE public.recovery_codes ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.user_2fa_verifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  verified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  used            BOOLEAN NOT NULL DEFAULT false,
  operation_scope TEXT
);

CREATE INDEX IF NOT EXISTS idx_2fa_verifications_user ON public.user_2fa_verifications(user_id);
ALTER TABLE public.user_2fa_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_2fa_verifications ADD COLUMN IF NOT EXISTS operation_scope TEXT;

-- ============================================================================
-- 3. 2FA STATUS (read-only RPC — no TOTP logic, Edge Functions handle that)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_2fa_status()
RETURNS TABLE (enabled BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  RETURN QUERY
  SELECT u2fa.enabled, u2fa.created_at
  FROM public.user_2fa u2fa WHERE u2fa.user_id = auth.uid();
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE::BOOLEAN, NULL::TIMESTAMPTZ;
  END IF;
END;
$$;

-- ============================================================================
-- 4. VERIFICATION TOKEN HELPERS (FIXED: strict scope + atomic consumption)
-- ============================================================================

-- Internal: create a scoped verification token (called by Edge Functions via service role)
CREATE OR REPLACE FUNCTION public._create_verification_token(
  p_user_id UUID,
  p_scope   TEXT,
  p_expires INTERVAL DEFAULT INTERVAL '5 minutes'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_token_id UUID;
BEGIN
  INSERT INTO public.user_2fa_verifications (user_id, expires_at, operation_scope)
  VALUES (p_user_id, NOW() + p_expires, p_scope)
  RETURNING id INTO v_token_id;

  RETURN v_token_id;
END;
$$;

-- Internal: consume a verification token with ATOMIC row-level locking
-- FIXED: SELECT FOR UPDATE prevents concurrent consumption race condition
-- FIXED: strict scope — null-scoped tokens rejected for scoped operations
CREATE OR REPLACE FUNCTION public._consume_verification_token(
  p_token_id       UUID,
  p_required_scope TEXT DEFAULT NULL
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
  v_auth_user := auth.uid();
  IF v_auth_user IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Atomic lock: SELECT FOR UPDATE prevents concurrent reads
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

-- Internal: require 2FA + consume token (used by all financial RPCs)
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

  -- 2FA must be enabled
  IF NOT EXISTS (SELECT 1 FROM public.user_2fa
    WHERE user_id = v_user_id AND enabled = true) THEN
    RAISE EXCEPTION '2FA is required but not enabled. Enable 2FA in Security settings.';
  END IF;

  IF p_verification_id IS NULL THEN
    RAISE EXCEPTION '2FA verification required. Provide a valid TOTP verification.';
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

-- Internal: admin 2FA check (admin status + 2FA + scope)
CREATE OR REPLACE FUNCTION public._require_admin_2fa(
  p_verification_id UUID,
  p_scope           TEXT DEFAULT 'admin_financial'
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_user() THEN RAISE EXCEPTION 'not authorized'; END IF;
  PERFORM public._require_2fa_verification(p_verification_id, p_scope);
  RETURN TRUE;
END;
$$;

-- ============================================================================
-- 5. DEPOSIT FUNCTIONS (FIXED: require verification token, not just 2FA enabled)
-- ============================================================================

-- User creates deposit — requires 2FA verification token with user_transaction scope
CREATE OR REPLACE FUNCTION public.create_deposit(
  p_token           TEXT,
  p_network         TEXT,
  p_expected_amount NUMERIC,
  p_tx_hash         TEXT DEFAULT NULL,
  p_verification_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id    UUID := auth.uid();
  v_deposit_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_deposit: not authenticated';
  END IF;

  -- Require 2FA verification token (not just 2FA enabled)
  PERFORM public._require_2fa_verification(p_verification_id, 'user_transaction');

  IF p_expected_amount IS NULL OR p_expected_amount <= 0 THEN
    RAISE EXCEPTION 'create_deposit: expected_amount must be greater than zero';
  END IF;

  INSERT INTO public.deposits (user_id, token, network, expected_amount, tx_hash, status)
  VALUES (v_user_id, p_token, p_network, p_expected_amount, p_tx_hash, 'PENDING')
  RETURNING id INTO v_deposit_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (v_user_id, 'DEPOSIT_CREATED', 'deposit', v_deposit_id,
    jsonb_build_object('token', p_token, 'network', p_network,
      'expected_amount', p_expected_amount, 'tx_hash', p_tx_hash));

  RETURN v_deposit_id;
END;
$$;

-- ============================================================================
-- 6. SELL ORDER FUNCTIONS (require verification token)
-- ============================================================================

-- User creates sell order — requires user_transaction scope
CREATE OR REPLACE FUNCTION public.create_sell_order(
  p_usdt_amount         NUMERIC(18,8),
  p_inr_amount          NUMERIC(18,2),
  p_exchange_rate       NUMERIC(10,4),
  p_bank_name           TEXT,
  p_account_holder_name TEXT,
  p_account_number      TEXT,
  p_ifsc_code           TEXT,
  p_verification_id     UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id        UUID := auth.uid();
  v_wallet_id      UUID;
  v_balance_before NUMERIC(18,8);
  v_order_id       UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_sell_order: not authenticated';
  END IF;

  PERFORM public._require_2fa_verification(p_verification_id, 'user_transaction');

  IF p_usdt_amount IS NULL OR p_usdt_amount <= 0 THEN
    RAISE EXCEPTION 'create_sell_order: usdt_amount must be greater than zero';
  END IF;
  IF p_inr_amount IS NULL OR p_inr_amount <= 0 THEN
    RAISE EXCEPTION 'create_sell_order: inr_amount must be greater than zero';
  END IF;
  IF p_exchange_rate IS NULL OR p_exchange_rate <= 0 THEN
    RAISE EXCEPTION 'create_sell_order: exchange_rate must be greater than zero';
  END IF;

  SELECT wb.wallet_id, wb.available_usdt
    INTO v_wallet_id, v_balance_before
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = v_user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'create_sell_order: wallet not found';
  END IF;
  IF v_balance_before < p_usdt_amount THEN
    RAISE EXCEPTION 'create_sell_order: insufficient available balance (have %, need %)', v_balance_before, p_usdt_amount;
  END IF;

  UPDATE public.wallet_balances
     SET available_usdt = available_usdt - p_usdt_amount,
         reserved_usdt  = reserved_usdt + p_usdt_amount,
         updated_at     = now()
   WHERE wallet_id = v_wallet_id;

  INSERT INTO public.ledger_entries (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'RESERVE', p_usdt_amount, v_balance_before, v_balance_before - p_usdt_amount, 'sell_order', NULL, '{"direction":"available_to_reserved","context":"sell_order_creation"}'::jsonb);

  INSERT INTO public.sell_orders (user_id, usdt_amount, inr_amount, exchange_rate, bank_name, account_holder_name, account_number, ifsc_code, status)
  VALUES (v_user_id, p_usdt_amount, p_inr_amount, p_exchange_rate, p_bank_name, p_account_holder_name, p_account_number, p_ifsc_code, 'PAYMENT_PENDING')
  RETURNING id INTO v_order_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (v_user_id, 'SELL_ORDER_CREATED', 'sell_order', v_order_id,
    jsonb_build_object('usdt_amount', p_usdt_amount, 'inr_amount', p_inr_amount, 'verification_id', p_verification_id));

  RETURN v_order_id;
END;
$$;

-- ============================================================================
-- 7. ADMIN DEPOSIT FUNCTIONS (require admin_financial scope)
-- ============================================================================

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
  IF v_deposit.status NOT IN ('PENDING', 'UNDER_REVIEW') THEN
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

-- ============================================================================
-- 8. ADMIN SELL ORDER FUNCTIONS (require admin_financial scope)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_complete_sell_order(
  p_order_id        UUID,
  p_verification_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_order     RECORD;
  v_wallet_id UUID;
  v_reserved  NUMERIC(18,8);
BEGIN
  IF NOT public.is_admin_user() THEN RAISE EXCEPTION 'not authorized'; END IF;
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');

  SELECT * INTO v_order FROM public.sell_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'admin_complete_sell_order: order not found';
  END IF;
  IF v_order.status NOT IN ('PAYMENT_PENDING', 'PAYMENT_PROOF_UPLOADED', 'MANUAL_REVIEW') THEN
    RAISE EXCEPTION 'admin_complete_sell_order: invalid status %', v_order.status;
  END IF;

  SELECT wb.wallet_id, wb.reserved_usdt
    INTO v_wallet_id, v_reserved
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = v_order.user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'admin_complete_sell_order: wallet not found';
  END IF;
  IF v_reserved < v_order.usdt_amount THEN
    RAISE EXCEPTION 'admin_complete_sell_order: insufficient reserved balance (have %, need %)', v_reserved, v_order.usdt_amount;
  END IF;

  UPDATE public.wallet_balances
     SET reserved_usdt = reserved_usdt - v_order.usdt_amount, updated_at = now()
   WHERE wallet_id = v_wallet_id;

  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'CONSUME', v_order.usdt_amount, v_reserved, v_reserved - v_order.usdt_amount, 'sell_order', p_order_id, '{"direction":"reserved_subtracted","context":"sell_completed"}'::jsonb);

  UPDATE public.sell_orders SET status = 'COMPLETED', updated_at = now() WHERE id = p_order_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'SELL_COMPLETED', 'sell_order', p_order_id,
    jsonb_build_object('previous_status', v_order.status, 'new_status', 'COMPLETED', 'usdt_amount', v_order.usdt_amount, 'inr_amount', v_order.inr_amount, 'user_id', v_order.user_id, 'verification_id', p_verification_id));

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_reject_sell_order(
  p_order_id        UUID,
  p_status          TEXT DEFAULT 'CANCELLED',
  p_verification_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_order     RECORD;
  v_wallet_id UUID;
  v_reserved  NUMERIC(18,8);
  v_available NUMERIC(18,8);
BEGIN
  IF NOT public.is_admin_user() THEN RAISE EXCEPTION 'not authorized'; END IF;
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');

  IF p_status NOT IN ('CANCELLED', 'REJECTED') THEN
    RAISE EXCEPTION 'admin_reject_sell_order: status must be CANCELLED or REJECTED';
  END IF;

  SELECT * INTO v_order FROM public.sell_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'admin_reject_sell_order: order not found';
  END IF;
  IF v_order.status NOT IN ('PAYMENT_PENDING', 'PAYMENT_PROOF_UPLOADED', 'MANUAL_REVIEW') THEN
    RAISE EXCEPTION 'admin_reject_sell_order: invalid status %', v_order.status;
  END IF;

  SELECT wb.wallet_id, wb.reserved_usdt, wb.available_usdt
    INTO v_wallet_id, v_reserved, v_available
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = v_order.user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'admin_reject_sell_order: wallet not found';
  END IF;
  IF v_reserved < v_order.usdt_amount THEN
    RAISE EXCEPTION 'admin_reject_sell_order: insufficient reserved balance (have %, need %)', v_reserved, v_order.usdt_amount;
  END IF;

  UPDATE public.wallet_balances
     SET reserved_usdt  = reserved_usdt - v_order.usdt_amount,
         available_usdt = available_usdt + v_order.usdt_amount,
         updated_at = now()
   WHERE wallet_id = v_wallet_id;

  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'RELEASE', v_order.usdt_amount, v_available, v_available + v_order.usdt_amount, 'sell_order', p_order_id, ('{"direction":"reserved_to_available","context":"sell_' || lower(p_status) || '"}')::jsonb);

  UPDATE public.sell_orders SET status = p_status, updated_at = now() WHERE id = p_order_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(),
    CASE p_status WHEN 'CANCELLED' THEN 'SELL_CANCELLED' ELSE 'SELL_REJECTED' END,
    'sell_order', p_order_id,
    jsonb_build_object('previous_status', v_order.status, 'new_status', p_status, 'usdt_amount', v_order.usdt_amount, 'user_id', v_order.user_id, 'verification_id', p_verification_id));

  RETURN TRUE;
END;
$$;

-- ============================================================================
-- 9. ADMIN EXCHANGE RATE (require admin_settings scope)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_update_exchange_rate(
  p_rate              NUMERIC(10,4),
  p_verification_id   UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_old_rate NUMERIC;
BEGIN
  IF NOT public.is_admin_user() THEN RAISE EXCEPTION 'not authorized'; END IF;
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_settings');

  IF p_rate IS NULL OR p_rate <= 0 THEN
    RAISE EXCEPTION 'admin_update_exchange_rate: rate must be greater than zero';
  END IF;

  SELECT (s.setting_value->>'rate')::NUMERIC INTO v_old_rate
  FROM public.exchange_settings s WHERE s.setting_key = 'platform_usdt_inr_rate';

  UPDATE public.exchange_settings
  SET setting_value = jsonb_build_object('rate', p_rate)
  WHERE setting_key = 'platform_usdt_inr_rate';

  INSERT INTO public.audit_logs (actor_id, action, target_type, metadata)
  VALUES (auth.uid(), 'EXCHANGE_RATE_UPDATED', 'exchange_settings',
    jsonb_build_object('old_rate', v_old_rate, 'new_rate', p_rate, 'verification_id', p_verification_id));

  RETURN TRUE;
END;
$$;

-- ============================================================================
-- 10. RLS POLICIES
-- ============================================================================

-- user_2fa: users read own row only
DROP POLICY IF EXISTS "user_2fa_select_own" ON public.user_2fa;
CREATE POLICY "user_2fa_select_own"
  ON public.user_2fa FOR SELECT
  USING (auth.uid() = user_id);

-- recovery_codes: users read own rows only
DROP POLICY IF EXISTS "recovery_codes_select_own" ON public.recovery_codes;
CREATE POLICY "recovery_codes_select_own"
  ON public.recovery_codes FOR SELECT
  USING (auth.uid() = user_id);

-- user_2fa_verifications: users manage own tokens
DROP POLICY IF EXISTS "user_2fa_verifications_own" ON public.user_2fa_verifications;
CREATE POLICY "user_2fa_verifications_own"
  ON public.user_2fa_verifications FOR ALL
  USING (auth.uid() = user_id);

-- ============================================================================
-- 11. SECURITY — REVOKE CLIENT ACCESS
-- ============================================================================

-- Read-only: authenticated users only
REVOKE EXECUTE ON FUNCTION public.get_2fa_status() FROM anon, public;

-- Internal helpers: revoke from ALL client roles
REVOKE EXECUTE ON FUNCTION public._create_verification_token(UUID, TEXT, INTERVAL) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public._consume_verification_token(UUID, TEXT) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public._require_2fa_verification(UUID, TEXT) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public._require_admin_2fa(UUID, TEXT) FROM authenticated, anon, public;

-- Financial RPCs: revoke from anon/public
REVOKE EXECUTE ON FUNCTION public.create_deposit(TEXT, TEXT, NUMERIC, TEXT, UUID) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.create_sell_order(NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, UUID) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_update_deposit_status(UUID, TEXT, UUID) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_credit_deposit(UUID, NUMERIC, UUID) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_complete_sell_order(UUID, UUID) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_reject_sell_order(UUID, TEXT, UUID) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_update_exchange_rate(NUMERIC, UUID) FROM anon, public;

-- ============================================================================
-- MIGRATION COMPLETE
-- Phase 9C: Final 2FA RPC Security Audit
-- - All financial RPCs require verification tokens
-- - Atomic token consumption with SELECT FOR UPDATE
-- - Strict scope enforcement (null scope rejected for scoped ops)
-- - Dead code removed (PL/pgSQL TOTP, old service-role helpers)
-- - admin_settings scope for exchange rate changes
-- ============================================================================
