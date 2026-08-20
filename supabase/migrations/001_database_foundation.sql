-- XReserve Phase 3 - Database Foundation
-- Schema-only migration. No RPC, Edge Functions, or business logic.

-- =============================================================================
-- 1. PROFILES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name  TEXT,
  avatar_url TEXT,
  email      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Users read only their own profile
CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

-- Users can update their own profile (name, avatar)
CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- =============================================================================
-- 2. WALLETS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wallets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wallets_select_own"
  ON public.wallets FOR SELECT
  USING (auth.uid() = user_id);

-- =============================================================================
-- 3. WALLET BALANCES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.wallet_balances (
  wallet_id       UUID PRIMARY KEY REFERENCES public.wallets(id) ON DELETE CASCADE,
  available_usdt  NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (available_usdt >= 0),
  reserved_usdt   NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (reserved_usdt >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.wallet_balances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "wallet_balances_select_own"
  ON public.wallet_balances FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.wallets w
      WHERE w.id = wallet_balances.wallet_id
        AND w.user_id = auth.uid()
    )
  );

-- =============================================================================
-- 4. LEDGER ENTRIES (immutable)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ledger_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id       UUID NOT NULL REFERENCES public.wallets(id) ON DELETE CASCADE,
  entry_type      TEXT NOT NULL,
  amount          NUMERIC(18,8) NOT NULL CHECK (amount > 0),
  balance_before  NUMERIC(18,8) NOT NULL,
  balance_after   NUMERIC(18,8) NOT NULL,
  reference_type  TEXT,
  reference_id    UUID,
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_entries_wallet_id ON public.ledger_entries(wallet_id);
CREATE INDEX idx_ledger_entries_created_at ON public.ledger_entries(created_at DESC);

ALTER TABLE public.ledger_entries ENABLE ROW LEVEL SECURITY;

-- Users read only their own ledger entries
CREATE POLICY "ledger_entries_select_own"
  ON public.ledger_entries FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.wallets w
      WHERE w.id = ledger_entries.wallet_id
        AND w.user_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies - all writes are server-side only.

-- Block UPDATE and DELETE at the database level (ledger is append-only)
CREATE OR REPLACE FUNCTION public.block_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries are immutable - UPDATE and DELETE are not allowed';
END;
$$;

DROP TRIGGER IF EXISTS trg_block_ledger_mutation ON public.ledger_entries;

CREATE TRIGGER trg_block_ledger_mutation
  BEFORE UPDATE OR DELETE ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.block_ledger_mutation();

-- =============================================================================
-- 5. DEPOSITS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.deposits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  network         TEXT NOT NULL,
  token           TEXT NOT NULL DEFAULT 'USDT',
  expected_amount NUMERIC(18,8) NOT NULL CHECK (expected_amount > 0),
  actual_amount   NUMERIC(18,8),
  tx_hash         TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','UNDER_REVIEW','CREDITED','REJECTED')),
  metadata        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deposits_user_id ON public.deposits(user_id);
CREATE INDEX idx_deposits_status ON public.deposits(status);

-- Prevent duplicate blockchain credits (NULL tx_hash allowed, uniqueness only when NOT NULL)
CREATE UNIQUE INDEX idx_deposits_tx_hash_unique ON public.deposits(tx_hash) WHERE tx_hash IS NOT NULL;

ALTER TABLE public.deposits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deposits_select_own"
  ON public.deposits FOR SELECT
  USING (auth.uid() = user_id);

-- Writes are server-side only.

-- =============================================================================
-- 6. SELL ORDERS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.sell_orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  usdt_amount         NUMERIC(18,8) NOT NULL CHECK (usdt_amount > 0),
  inr_amount          NUMERIC(18,2) NOT NULL CHECK (inr_amount > 0),
  exchange_rate       NUMERIC(10,4) NOT NULL CHECK (exchange_rate > 0),
  bank_name           TEXT NOT NULL,
  account_holder_name TEXT NOT NULL,
  account_number      TEXT NOT NULL,
  ifsc_code           TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PAYMENT_PENDING'
                        CHECK (status IN (
                          'PAYMENT_PENDING','PAYMENT_PROOF_UPLOADED',
                          'COMPLETED','CANCELLED','REJECTED','MANUAL_REVIEW'
                        )),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sell_orders_user_id ON public.sell_orders(user_id);
CREATE INDEX idx_sell_orders_status ON public.sell_orders(status);

ALTER TABLE public.sell_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sell_orders_select_own"
  ON public.sell_orders FOR SELECT
  USING (auth.uid() = user_id);

-- Writes are server-side only.

-- =============================================================================
-- 7. EXCHANGE SETTINGS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.exchange_settings (
  setting_key   TEXT PRIMARY KEY,
  setting_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.exchange_settings ENABLE ROW LEVEL SECURITY;

-- Explicitly revoke all client access
REVOKE ALL ON public.exchange_settings FROM authenticated, anon, public;

-- Seed default settings (jsonb_build_object ensures now() is evaluated at insert time)
INSERT INTO public.exchange_settings (setting_key, setting_value)
VALUES
  ('platform_usdt_inr_rate', jsonb_build_object('rate', 92.00, 'updated_at', now())),
  ('sell_limits',            jsonb_build_object('min_usdt', 100, 'max_usdt', 50000))
ON CONFLICT (setting_key) DO NOTHING;

-- =============================================================================
-- 8. AUDIT LOGS
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   UUID,
  metadata    JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_logs_actor_id ON public.audit_logs(actor_id);
CREATE INDEX idx_audit_logs_target ON public.audit_logs(target_type, target_id);
CREATE INDEX idx_audit_logs_created_at ON public.audit_logs(created_at DESC);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Explicitly revoke all client access
REVOKE ALL ON public.audit_logs FROM authenticated, anon, public;

-- =============================================================================
-- 9. AUTO-PROVISION TRIGGER
--    On new auth.users -> profile -> wallet -> wallet_balances
-- =============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _wallet_id UUID;
BEGIN
  -- 1. Profile
  INSERT INTO public.profiles (id, full_name, avatar_url, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'avatar_url',
    NEW.email
  );

  -- 2. Wallet
  INSERT INTO public.wallets (user_id)
  VALUES (NEW.id)
  RETURNING id INTO _wallet_id;

  -- 3. Balance row
  INSERT INTO public.wallet_balances (wallet_id)
  VALUES (_wallet_id);

  RETURN NEW;
END;
$$;

-- Drop and recreate to make the migration idempotent
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- =============================================================================
-- 10. UPDATED_AT TRIGGER (reusable)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_deposits_updated_at
  BEFORE UPDATE ON public.deposits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_sell_orders_updated_at
  BEFORE UPDATE ON public.sell_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_exchange_settings_updated_at
  BEFORE UPDATE ON public.exchange_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
