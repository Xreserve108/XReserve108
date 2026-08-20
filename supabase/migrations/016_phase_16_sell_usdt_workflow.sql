-- XReserve Phase 16 — Sell USDT workflow
-- Extends the existing sell infrastructure instead of duplicating it:
--   - sell_orders table            (migration 001)
--   - wallet/ledger engine         (migrations 001/002)
--   - create_sell_order RPC        (migration 006, replaced below)
--   - admin_complete_sell_order    (migration 006, reused unchanged)
--   - admin_reject_sell_order      (migration 006, reused unchanged)
--   - admin_list_sell_orders       (migration 003, reused unchanged)
--   - bank_accounts                (migration 015)
--
-- Changes:
--   1. sell_orders: add bank_account_id reference + client_token idempotency key.
--   2. Replace create_sell_order with a hardened signature:
--      - Bank account is referenced by ID; ownership is enforced server-side
--        (a user can never sell to another user's bank account).
--      - Exchange rate is read server-side from exchange_settings; the browser
--        never supplies the rate or the INR amount.
--      - client_token idempotency protects against double-submission/retries.
--      - Wallet debit (available -> reserved) + order creation remain atomic
--        inside one transaction with SELECT ... FOR UPDATE row locking.
--   3. Drop the old 8-argument create_sell_order, which trusted client-supplied
--      bank text, exchange rate, and INR amount.
--
-- Duplicate-order UX (warning about similar pending orders) is client-side by
-- design: identical follow-up orders can be legitimate, so the server never
-- auto-rejects them. Server-side double-submission protection is provided by
-- the client_token unique index + single-use 2FA verification tokens.

-- =============================================================================
-- 1. SCHEMA EXTENSION
-- =============================================================================

-- Snapshot fields (bank_name, account_holder_name, account_number, ifsc_code)
-- remain on sell_orders so orders keep full payout details even if the user
-- later deletes the bank account. ON DELETE SET NULL only clears the reference.
ALTER TABLE public.sell_orders
  ADD COLUMN IF NOT EXISTS bank_account_id UUID REFERENCES public.bank_accounts(id) ON DELETE SET NULL;

ALTER TABLE public.sell_orders
  ADD COLUMN IF NOT EXISTS client_token UUID;

-- One order per (user, client_token). The frontend generates a fresh token per
-- sell intent; a retried submission with the same token is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sell_orders_user_client_token
  ON public.sell_orders(user_id, client_token)
  WHERE client_token IS NOT NULL;

-- =============================================================================
-- 2. DROP THE CLIENT-TRUSTED RPC (superseded below)
-- =============================================================================

DROP FUNCTION IF EXISTS public.create_sell_order(NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, UUID);

-- =============================================================================
-- 3. HARDENED SELL ORDER CREATION RPC
--    Requires a single-use 'user_transaction' verification token (2FA).
--    The wallet debit and order creation happen atomically in one transaction.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_sell_order(
  p_usdt_amount     NUMERIC(18,8),
  p_bank_account_id UUID,
  p_client_token    UUID,
  p_verification_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id        UUID := auth.uid();
  v_bank           RECORD;
  v_wallet_id      UUID;
  v_balance_before NUMERIC(18,8);
  v_rate           NUMERIC(10,4);
  v_inr_amount     NUMERIC(18,2);
  v_order_id       UUID;
  v_existing_id    UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_sell_order: not authenticated';
  END IF;

  IF p_usdt_amount IS NULL OR p_usdt_amount <= 0 THEN
    RAISE EXCEPTION 'create_sell_order: usdt_amount must be greater than zero';
  END IF;
  IF p_client_token IS NULL THEN
    RAISE EXCEPTION 'create_sell_order: client_token is required';
  END IF;

  -- Idempotent replay: a retry with the same client_token returns the order
  -- that was already created. Checked before 2FA consumption so a network
  -- retry of a successful submission does not demand a second code.
  SELECT id INTO v_existing_id
    FROM public.sell_orders
   WHERE user_id = v_user_id AND client_token = p_client_token;
  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  -- Consume the scoped 2FA verification token (single-use, 5-min TTL).
  -- No order can ever be created without a successful verification.
  PERFORM public._require_2fa_verification(p_verification_id, 'user_transaction');

  -- The bank account must belong to the authenticated user.
  SELECT bank_name, account_holder_name, account_number, ifsc_code
    INTO v_bank
    FROM public.bank_accounts
   WHERE id = p_bank_account_id
     AND user_id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_sell_order: bank account not found';
  END IF;

  -- Authoritative rate is read server-side; the browser value is never trusted.
  SELECT (s.setting_value->>'rate')::NUMERIC(10,4) INTO v_rate
    FROM public.exchange_settings s
   WHERE s.setting_key = 'platform_usdt_inr_rate';
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'create_sell_order: platform rate unavailable';
  END IF;

  v_inr_amount := round(p_usdt_amount * v_rate, 2);

  -- Lock the balance row for this user: concurrent sell submissions serialize
  -- here, so overspending / negative balances are impossible.
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

  -- Atomic debit (available -> reserved) + order creation in this transaction.
  UPDATE public.wallet_balances
     SET available_usdt = available_usdt - p_usdt_amount,
         reserved_usdt  = reserved_usdt + p_usdt_amount,
         updated_at     = now()
   WHERE wallet_id = v_wallet_id;

  INSERT INTO public.sell_orders
    (user_id, usdt_amount, inr_amount, exchange_rate, bank_account_id,
     bank_name, account_holder_name, account_number, ifsc_code,
     client_token, status)
  VALUES
    (v_user_id, p_usdt_amount, v_inr_amount, v_rate, p_bank_account_id,
     v_bank.bank_name, v_bank.account_holder_name, v_bank.account_number, v_bank.ifsc_code,
     p_client_token, 'PAYMENT_PENDING')
  RETURNING id INTO v_order_id;

  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'RESERVE', p_usdt_amount, v_balance_before, v_balance_before - p_usdt_amount,
          'sell_order', v_order_id, '{"direction":"available_to_reserved","context":"sell_order_creation"}'::jsonb);

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (v_user_id, 'SELL_ORDER_CREATED', 'sell_order', v_order_id,
    jsonb_build_object('usdt_amount', p_usdt_amount, 'inr_amount', v_inr_amount,
      'exchange_rate', v_rate, 'bank_account_id', p_bank_account_id,
      'client_token', p_client_token, 'verification_id', p_verification_id));

  RETURN v_order_id;

EXCEPTION
  WHEN unique_violation THEN
    -- A concurrent submission with the same client_token won the race.
    -- Raising rolls back this transaction's wallet debit; the client retries
    -- idempotently via the client_token pre-check above.
    RAISE EXCEPTION 'create_sell_order: duplicate submission';
END;
$$;

-- =============================================================================
-- 4. PRIVILEGES
-- =============================================================================

REVOKE EXECUTE ON FUNCTION public.create_sell_order(NUMERIC, UUID, UUID, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.create_sell_order(NUMERIC, UUID, UUID, UUID) TO   authenticated;
