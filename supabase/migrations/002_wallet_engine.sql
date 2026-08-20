-- XReserve Phase 4A - Admin-Controlled Wallet & Order Flow
-- Wallet engine for offline admin-operated exchange.
-- User functions use auth.uid(). Admin functions accept p_user_id (service-role only).

-- =============================================================================
-- USER FUNCTIONS
-- =============================================================================

-- =============================================================================
-- 1. CREATE SELL ORDER (user)
--    Atomically: reserve USDT + create sell order + ledger entry.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_sell_order(
  p_usdt_amount         NUMERIC(18,8),
  p_inr_amount          NUMERIC(18,2),
  p_exchange_rate       NUMERIC(10,4),
  p_bank_name           TEXT,
  p_account_holder_name TEXT,
  p_account_number      TEXT,
  p_ifsc_code           TEXT
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

  IF p_usdt_amount IS NULL OR p_usdt_amount <= 0 THEN
    RAISE EXCEPTION 'create_sell_order: usdt_amount must be greater than zero';
  END IF;

  IF p_inr_amount IS NULL OR p_inr_amount <= 0 THEN
    RAISE EXCEPTION 'create_sell_order: inr_amount must be greater than zero';
  END IF;

  IF p_exchange_rate IS NULL OR p_exchange_rate <= 0 THEN
    RAISE EXCEPTION 'create_sell_order: exchange_rate must be greater than zero';
  END IF;

  -- Lock wallet and validate balance
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

  -- Reserve USDT
  UPDATE public.wallet_balances
     SET available_usdt = available_usdt - p_usdt_amount,
         reserved_usdt  = reserved_usdt + p_usdt_amount,
         updated_at     = now()
   WHERE wallet_id = v_wallet_id;

  -- Ledger entry
  INSERT INTO public.ledger_entries (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'RESERVE', p_usdt_amount, v_balance_before, v_balance_before - p_usdt_amount, 'sell_order', NULL, '{"direction":"available_to_reserved","context":"sell_order_creation"}'::jsonb);

  -- Create sell order
  INSERT INTO public.sell_orders (user_id, usdt_amount, inr_amount, exchange_rate, bank_name, account_holder_name, account_number, ifsc_code, status)
  VALUES (v_user_id, p_usdt_amount, p_inr_amount, p_exchange_rate, p_bank_name, p_account_holder_name, p_account_number, p_ifsc_code, 'PAYMENT_PENDING')
  RETURNING id INTO v_order_id;

  RETURN v_order_id;
END;
$$;

-- =============================================================================
-- ADMIN FUNCTIONS (service-role only)
-- All accept p_user_id. Revoked from authenticated/anon/public.
-- =============================================================================

-- =============================================================================
-- 3. CREDIT WALLET (admin)
--    Credit any user's wallet. Updates deposit status when applicable.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.credit_wallet(
  p_user_id        UUID,
  p_amount         NUMERIC(18,8),
  p_reference_type TEXT,
  p_reference_id   UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_wallet_id      UUID;
  v_balance_before NUMERIC(18,8);
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'credit_wallet: amount must be greater than zero';
  END IF;

  SELECT wb.wallet_id, wb.available_usdt
    INTO v_wallet_id, v_balance_before
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = p_user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'credit_wallet: wallet not found for user %', p_user_id;
  END IF;

  -- Credit available balance
  UPDATE public.wallet_balances
     SET available_usdt = available_usdt + p_amount,
         updated_at     = now()
   WHERE wallet_id = v_wallet_id;

  -- Ledger entry
  INSERT INTO public.ledger_entries (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'CREDIT', p_amount, v_balance_before, v_balance_before + p_amount, p_reference_type, p_reference_id, '{"direction":"credit"}'::jsonb);

  -- Update deposit status if reference is a deposit
  IF p_reference_type = 'deposit' AND p_reference_id IS NOT NULL THEN
    UPDATE public.deposits
       SET status      = 'CREDITED',
           actual_amount = p_amount,
           updated_at  = now()
     WHERE id = p_reference_id
       AND user_id = p_user_id
       AND status = 'PENDING';
  END IF;

  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 4. RELEASE RESERVED USDT (admin)
--    Move reserved back to available (e.g. sell order cancelled/rejected).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.release_reserved_usdt(
  p_user_id UUID,
  p_amount  NUMERIC(18,8)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_wallet_id UUID;
  v_reserved  NUMERIC(18,8);
  v_available NUMERIC(18,8);
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'release_reserved_usdt: amount must be greater than zero';
  END IF;

  SELECT wb.wallet_id, wb.reserved_usdt, wb.available_usdt
    INTO v_wallet_id, v_reserved, v_available
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = p_user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'release_reserved_usdt: wallet not found for user %', p_user_id;
  END IF;

  IF v_reserved < p_amount THEN
    RAISE EXCEPTION 'release_reserved_usdt: insufficient reserved balance (have %, need %)', v_reserved, p_amount;
  END IF;

  UPDATE public.wallet_balances
     SET reserved_usdt  = reserved_usdt - p_amount,
         available_usdt = available_usdt + p_amount,
         updated_at     = now()
   WHERE wallet_id = v_wallet_id;

  INSERT INTO public.ledger_entries (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'RELEASE', p_amount, v_available, v_available + p_amount, 'release_reserved', NULL, '{"direction":"reserved_to_available"}'::jsonb);

  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 5. CONSUME RESERVED USDT (admin)
--    Subtract from reserved (e.g. sell order completed).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.consume_reserved_usdt(
  p_user_id UUID,
  p_amount  NUMERIC(18,8)
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_wallet_id UUID;
  v_reserved  NUMERIC(18,8);
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'consume_reserved_usdt: amount must be greater than zero';
  END IF;

  SELECT wb.wallet_id, wb.reserved_usdt
    INTO v_wallet_id, v_reserved
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = p_user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'consume_reserved_usdt: wallet not found for user %', p_user_id;
  END IF;

  IF v_reserved < p_amount THEN
    RAISE EXCEPTION 'consume_reserved_usdt: insufficient reserved balance (have %, need %)', v_reserved, p_amount;
  END IF;

  UPDATE public.wallet_balances
     SET reserved_usdt = reserved_usdt - p_amount,
         updated_at    = now()
   WHERE wallet_id = v_wallet_id;

  INSERT INTO public.ledger_entries (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'CONSUME', p_amount, v_reserved, v_reserved - p_amount, 'consume_reserved', NULL, '{"direction":"reserved_subtracted"}'::jsonb);

  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 6. ADMIN COMPLETE SELL (admin)
--    Consume reserved USDT + mark order COMPLETED. Atomic.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_complete_sell(
  p_order_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_order        RECORD;
  v_wallet_id    UUID;
  v_reserved     NUMERIC(18,8);
BEGIN
  -- Fetch and lock the order
  SELECT * INTO v_order
    FROM public.sell_orders
   WHERE id = p_order_id
     FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'admin_complete_sell: order not found';
  END IF;

  IF v_order.status NOT IN ('PAYMENT_PENDING', 'PAYMENT_PROOF_UPLOADED', 'MANUAL_REVIEW') THEN
    RAISE EXCEPTION 'admin_complete_sell: order cannot be completed (status: %)', v_order.status;
  END IF;

  -- Get wallet balance
  SELECT wb.wallet_id, wb.reserved_usdt
    INTO v_wallet_id, v_reserved
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = v_order.user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'admin_complete_sell: wallet not found';
  END IF;

  IF v_reserved < v_order.usdt_amount THEN
    RAISE EXCEPTION 'admin_complete_sell: insufficient reserved balance (have %, need %)', v_reserved, v_order.usdt_amount;
  END IF;

  -- Consume reserved
  UPDATE public.wallet_balances
     SET reserved_usdt = reserved_usdt - v_order.usdt_amount,
         updated_at    = now()
   WHERE wallet_id = v_wallet_id;

  -- Ledger entry
  INSERT INTO public.ledger_entries (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'CONSUME', v_order.usdt_amount, v_reserved, v_reserved - v_order.usdt_amount, 'sell_order', p_order_id, '{"direction":"reserved_subtracted","context":"sell_completed"}'::jsonb);

  -- Mark order completed
  UPDATE public.sell_orders
     SET status     = 'COMPLETED',
         updated_at = now()
   WHERE id = p_order_id;

  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 7. ADMIN REJECT SELL (admin)
--    Release reserved USDT + mark order CANCELLED or REJECTED. Atomic.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_reject_sell(
  p_order_id UUID,
  p_status   TEXT DEFAULT 'CANCELLED'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_order        RECORD;
  v_wallet_id    UUID;
  v_reserved     NUMERIC(18,8);
  v_available    NUMERIC(18,8);
BEGIN
  IF p_status NOT IN ('CANCELLED', 'REJECTED') THEN
    RAISE EXCEPTION 'admin_reject_sell: status must be CANCELLED or REJECTED';
  END IF;

  SELECT * INTO v_order
    FROM public.sell_orders
   WHERE id = p_order_id
     FOR UPDATE;

  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'admin_reject_sell: order not found';
  END IF;

  IF v_order.status NOT IN ('PAYMENT_PENDING', 'PAYMENT_PROOF_UPLOADED', 'MANUAL_REVIEW') THEN
    RAISE EXCEPTION 'admin_reject_sell: order cannot be rejected (status: %)', v_order.status;
  END IF;

  -- Get wallet balance
  SELECT wb.wallet_id, wb.reserved_usdt, wb.available_usdt
    INTO v_wallet_id, v_reserved, v_available
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = v_order.user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'admin_reject_sell: wallet not found';
  END IF;

  IF v_reserved < v_order.usdt_amount THEN
    RAISE EXCEPTION 'admin_reject_sell: insufficient reserved balance (have %, need %)', v_reserved, v_order.usdt_amount;
  END IF;

  -- Release reserved back to available
  UPDATE public.wallet_balances
     SET reserved_usdt  = reserved_usdt - v_order.usdt_amount,
         available_usdt = available_usdt + v_order.usdt_amount,
         updated_at     = now()
   WHERE wallet_id = v_wallet_id;

  -- Ledger entry
  INSERT INTO public.ledger_entries (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'RELEASE', v_order.usdt_amount, v_available, v_available + v_order.usdt_amount, 'sell_order', p_order_id, '{"direction":"reserved_to_available","context":"sell_' || lower(p_status) || '"}'::jsonb);

  -- Mark order rejected/cancelled
  UPDATE public.sell_orders
     SET status     = p_status,
         updated_at = now()
   WHERE id = p_order_id;

  RETURN TRUE;
END;
$$;

-- =============================================================================
-- SECURITY - REVOKE CLIENT ACCESS
-- =============================================================================

-- User functions: revoke from anon/public (authenticated CAN call create_sell_order)
REVOKE EXECUTE ON FUNCTION public.create_sell_order(NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT) FROM anon, public;

-- Admin functions: revoke from ALL client roles (service-role only)
REVOKE EXECUTE ON FUNCTION public.credit_wallet(UUID, NUMERIC, TEXT, UUID)     FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.release_reserved_usdt(UUID, NUMERIC)         FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.consume_reserved_usdt(UUID, NUMERIC)         FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_complete_sell(UUID)                    FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_reject_sell(UUID, TEXT)                FROM authenticated, anon, public;
