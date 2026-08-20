-- XReserve Phase 15 — User Bank Accounts
-- Additive migration. Creates dedicated bank_accounts table with RLS
-- and server-side enforcement of the 2-account maximum per user.
--
-- Security corrections (pre-deployment review):
--   1. Advisory transaction lock closes the TOCTOU race on the 2-account limit.
--   2. No redefinition of the shared public.set_updated_at() function (001).
--   3. Bank account creation goes through a SECURITY DEFINER RPC that
--      consumes a scoped 2FA verification token server-side; direct client
--      INSERT is removed (no INSERT policy, INSERT privilege revoked).
--   4. SECURITY DEFINER functions use SET search_path = public and have
--      EXECUTE revoked from anon/public.

-- =============================================================================
-- 1. BANK ACCOUNTS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  bank_name           TEXT NOT NULL CHECK (length(trim(bank_name)) > 0),
  ifsc_code           TEXT NOT NULL CHECK (length(trim(ifsc_code)) > 0),
  account_number      TEXT NOT NULL CHECK (length(trim(account_number)) > 0),
  account_holder_name TEXT NOT NULL CHECK (length(trim(account_holder_name)) > 0),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts_user_id
  ON public.bank_accounts(user_id);

ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- 2. RLS POLICIES
-- =============================================================================

-- Users can only see their own bank accounts
CREATE POLICY "bank_accounts_select_own"
  ON public.bank_accounts FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT policy: creation is only possible via the add_bank_account RPC
-- (SECURITY DEFINER), which enforces 2FA server-side.

-- Users can only delete their own bank accounts
CREATE POLICY "bank_accounts_delete_own"
  ON public.bank_accounts FOR DELETE
  USING (auth.uid() = user_id);

-- Defense-in-depth: block direct client INSERT even if table-level grants exist
REVOKE INSERT ON public.bank_accounts FROM authenticated, anon, public;

-- =============================================================================
-- 3. SERVER-SIDE MAXIMUM 2 ACCOUNTS PER USER
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_bank_account_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Serialize inserts per user so the count-then-insert check is race-safe.
  -- Two concurrent inserts for the same user are ordered; the second one
  -- sees the first row and is rejected if the limit is reached.
  PERFORM pg_advisory_xact_lock(hashtext(NEW.user_id::text));

  IF (
    SELECT count(*) FROM public.bank_accounts
    WHERE user_id = NEW.user_id
  ) >= 2 THEN
    RAISE EXCEPTION 'Maximum of 2 bank accounts allowed';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enforce_bank_account_limit() FROM anon, public;

DROP TRIGGER IF EXISTS bank_account_limit_trigger ON public.bank_accounts;

CREATE TRIGGER bank_account_limit_trigger
  BEFORE INSERT ON public.bank_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_bank_account_limit();

-- =============================================================================
-- 4. SERVER-SIDE 2FA-PROTECTED CREATION RPC
--    Mirrors the create_sell_order / submit_deposit pattern: the client passes
--    a verification_id (scope 'user_transaction') which is consumed atomically
--    via _require_2fa_verification before any row is written.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.add_bank_account(
  p_bank_name           TEXT,
  p_ifsc_code           TEXT,
  p_account_number      TEXT,
  p_account_holder_name TEXT,
  p_verification_id     UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_id      UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Consume the scoped 2FA verification token (single-use, 5-min TTL)
  PERFORM public._require_2fa_verification(p_verification_id, 'user_transaction');

  INSERT INTO public.bank_accounts (user_id, bank_name, ifsc_code, account_number, account_holder_name)
  VALUES (
    v_user_id,
    trim(p_bank_name),
    upper(trim(p_ifsc_code)),
    trim(p_account_number),
    trim(p_account_holder_name)
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_bank_account(TEXT, TEXT, TEXT, TEXT, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.add_bank_account(TEXT, TEXT, TEXT, TEXT, UUID) TO   authenticated;

-- =============================================================================
-- 5. AUTOMATIC updated_at
--    Reuses the shared public.set_updated_at() created in migration 001.
--    It is intentionally NOT redefined here.
-- =============================================================================

DROP TRIGGER IF EXISTS bank_accounts_updated_at_trigger ON public.bank_accounts;

CREATE TRIGGER bank_accounts_updated_at_trigger
  BEFORE UPDATE ON public.bank_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();
