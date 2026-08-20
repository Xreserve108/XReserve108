-- XReserve Phase 5-7 - Admin Operations Foundation
-- admin_users table, admin check, and frontend-facing admin RPC functions.

-- =============================================================================
-- 1. ADMIN USERS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.admin_users (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'admin',
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

-- Admins can read the table
CREATE POLICY "admin_users_select"
  ON public.admin_users FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users au
      WHERE au.user_id = auth.uid()
    )
  );

-- Admins can update their own row
CREATE POLICY "admin_users_update_own"
  ON public.admin_users FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- =============================================================================
-- 2. ADMIN CHECK HELPER
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE user_id = auth.uid() AND is_active = true
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.is_admin_user() FROM anon, public;

-- updated_at trigger for admin_users
DROP TRIGGER IF EXISTS trg_admin_users_updated_at ON public.admin_users;

CREATE TRIGGER trg_admin_users_updated_at
  BEFORE UPDATE ON public.admin_users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 3. ADMIN DEPOSIT FUNCTIONS
-- =============================================================================

-- List deposits with optional status filter
CREATE OR REPLACE FUNCTION public.admin_list_deposits(p_status TEXT DEFAULT NULL)
RETURNS TABLE (
  id              UUID,
  user_id         UUID,
  user_email      TEXT,
  network         TEXT,
  token           TEXT,
  expected_amount NUMERIC,
  actual_amount   NUMERIC,
  tx_hash         TEXT,
  status          TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ
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
    d.status, d.metadata, d.created_at, d.updated_at
  FROM public.deposits d
  JOIN public.profiles p ON p.id = d.user_id
  WHERE COALESCE(p_status, d.status) = d.status
  ORDER BY d.created_at DESC;
END;
$$;

-- Update deposit status (mark under review / reject non-credited)
CREATE OR REPLACE FUNCTION public.admin_update_deposit_status(
  p_deposit_id UUID,
  p_new_status TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_current_status TEXT;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

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

  -- Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    CASE p_new_status
      WHEN 'UNDER_REVIEW' THEN 'DEPOSIT_UNDER_REVIEW'
      WHEN 'REJECTED'     THEN 'DEPOSIT_REJECTED'
      WHEN 'PENDING'      THEN 'DEPOSIT_REOPENED'
      ELSE 'DEPOSIT_STATUS_CHANGE'
    END,
    'deposit', p_deposit_id,
    jsonb_build_object('previous_status', v_current_status, 'new_status', p_new_status)
  );

  RETURN TRUE;
END;
$$;

-- Credit a deposit: credit wallet + mark deposit CREDITED. Atomic.
CREATE OR REPLACE FUNCTION public.admin_credit_deposit(
  p_deposit_id UUID,
  p_amount     NUMERIC
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
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'admin_credit_deposit: amount must be greater than zero';
  END IF;

  SELECT * INTO v_deposit
  FROM public.deposits WHERE id = p_deposit_id FOR UPDATE;

  IF v_deposit.id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_deposit: deposit not found';
  END IF;

  IF v_deposit.status = 'CREDITED' THEN
    RAISE EXCEPTION 'admin_credit_deposit: deposit already credited';
  END IF;

  IF v_deposit.status NOT IN ('PENDING', 'UNDER_REVIEW') THEN
    RAISE EXCEPTION 'admin_credit_deposit: cannot credit deposit with status %', v_deposit.status;
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

  -- Credit available balance
  UPDATE public.wallet_balances
     SET available_usdt = available_usdt + p_amount,
         updated_at = now()
   WHERE wallet_id = v_wallet_id;

  -- Ledger entry
  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES
    (v_wallet_id, 'CREDIT', p_amount, v_balance_before, v_balance_before + p_amount, 'deposit', p_deposit_id, '{"direction":"credit","context":"admin_deposit_credit"}'::jsonb);

  -- Mark deposit CREDITED
  UPDATE public.deposits
     SET status = 'CREDITED', actual_amount = p_amount, updated_at = now()
   WHERE id = p_deposit_id;

  -- Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'DEPOSIT_CREDITED', 'deposit', p_deposit_id,
    jsonb_build_object('amount', p_amount, 'previous_status', v_deposit.status, 'new_status', 'CREDITED', 'user_id', v_deposit.user_id));

  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 4. ADMIN SELL ORDER FUNCTIONS
-- =============================================================================

-- List sell orders with optional status filter
CREATE OR REPLACE FUNCTION public.admin_list_sell_orders(p_status TEXT DEFAULT NULL)
RETURNS TABLE (
  id                  UUID,
  user_id             UUID,
  user_email          TEXT,
  usdt_amount         NUMERIC,
  inr_amount          NUMERIC,
  exchange_rate       NUMERIC,
  bank_name           TEXT,
  account_holder_name TEXT,
  account_number      TEXT,
  ifsc_code           TEXT,
  status              TEXT,
  created_at          TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ
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
    so.id, so.user_id, p.email, so.usdt_amount, so.inr_amount,
    so.exchange_rate, so.bank_name, so.account_holder_name,
    so.account_number, so.ifsc_code, so.status,
    so.created_at, so.updated_at
  FROM public.sell_orders so
  JOIN public.profiles p ON p.id = so.user_id
  WHERE COALESCE(p_status, so.status) = so.status
  ORDER BY so.created_at DESC;
END;
$$;

-- Complete a sell order: consume reserved USDT + mark COMPLETED. Atomic.
CREATE OR REPLACE FUNCTION public.admin_complete_sell_order(p_order_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_order     RECORD;
  v_wallet_id UUID;
  v_reserved  NUMERIC(18,8);
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  SELECT * INTO v_order
  FROM public.sell_orders WHERE id = p_order_id FOR UPDATE;

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

  -- Consume reserved
  UPDATE public.wallet_balances
     SET reserved_usdt = reserved_usdt - v_order.usdt_amount,
         updated_at = now()
   WHERE wallet_id = v_wallet_id;

  -- Ledger entry
  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES
    (v_wallet_id, 'CONSUME', v_order.usdt_amount, v_reserved, v_reserved - v_order.usdt_amount, 'sell_order', p_order_id, '{"direction":"reserved_subtracted","context":"sell_completed"}'::jsonb);

  -- Mark COMPLETED
  UPDATE public.sell_orders
     SET status = 'COMPLETED', updated_at = now()
   WHERE id = p_order_id;

  -- Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'SELL_COMPLETED', 'sell_order', p_order_id,
    jsonb_build_object('previous_status', v_order.status, 'new_status', 'COMPLETED', 'usdt_amount', v_order.usdt_amount, 'inr_amount', v_order.inr_amount, 'user_id', v_order.user_id));

  RETURN TRUE;
END;
$$;

-- Reject or cancel a sell order: release reserved USDT + update status. Atomic.
CREATE OR REPLACE FUNCTION public.admin_reject_sell_order(
  p_order_id UUID,
  p_status   TEXT DEFAULT 'CANCELLED'
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
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  IF p_status NOT IN ('CANCELLED', 'REJECTED') THEN
    RAISE EXCEPTION 'admin_reject_sell_order: status must be CANCELLED or REJECTED';
  END IF;

  SELECT * INTO v_order
  FROM public.sell_orders WHERE id = p_order_id FOR UPDATE;

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

  -- Release reserved back to available
  UPDATE public.wallet_balances
     SET reserved_usdt  = reserved_usdt - v_order.usdt_amount,
         available_usdt = available_usdt + v_order.usdt_amount,
         updated_at = now()
   WHERE wallet_id = v_wallet_id;

  -- Ledger entry
  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES
    (v_wallet_id, 'RELEASE', v_order.usdt_amount, v_available, v_available + v_order.usdt_amount, 'sell_order', p_order_id, ('{"direction":"reserved_to_available","context":"sell_' || lower(p_status) || '"}')::jsonb);

  -- Mark rejected/cancelled
  UPDATE public.sell_orders
     SET status = p_status, updated_at = now()
   WHERE id = p_order_id;

  -- Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    CASE p_status WHEN 'CANCELLED' THEN 'SELL_CANCELLED' ELSE 'SELL_REJECTED' END,
    'sell_order', p_order_id,
    jsonb_build_object('previous_status', v_order.status, 'new_status', p_status, 'usdt_amount', v_order.usdt_amount, 'user_id', v_order.user_id)
  );

  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 5. DASHBOARD STATS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_dashboard_stats()
RETURNS TABLE (
  pending_deposits   BIGINT,
  pending_sell_orders BIGINT,
  total_users        BIGINT,
  credited_deposits  BIGINT,
  completed_sells    BIGINT,
  platform_rate      NUMERIC
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
    (SELECT count(*) FROM public.deposits WHERE status IN ('PENDING', 'UNDER_REVIEW'))::BIGINT,
    (SELECT count(*) FROM public.sell_orders WHERE status IN ('PAYMENT_PENDING', 'MANUAL_REVIEW'))::BIGINT,
    (SELECT count(*) FROM public.profiles)::BIGINT,
    (SELECT count(*) FROM public.deposits WHERE status = 'CREDITED')::BIGINT,
    (SELECT count(*) FROM public.sell_orders WHERE status = 'COMPLETED')::BIGINT,
    (SELECT (s.setting_value->>'rate')::NUMERIC FROM public.exchange_settings s WHERE s.setting_key = 'platform_usdt_inr_rate');
END;
$$;

-- =============================================================================
-- SECURITY - REVOKE CLIENT ACCESS
-- =============================================================================

REVOKE EXECUTE ON FUNCTION public.admin_list_deposits(TEXT)                FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_update_deposit_status(UUID, TEXT)   FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_credit_deposit(UUID, NUMERIC)       FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_list_sell_orders(TEXT)              FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_complete_sell_order(UUID)           FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_reject_sell_order(UUID, TEXT)       FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_dashboard_stats()                   FROM anon, public;
