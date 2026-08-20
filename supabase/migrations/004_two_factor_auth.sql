-- XReserve Phase 9A — Mandatory Two-Factor Authentication (TOTP)
-- Requires pgcrypto for HMAC-SHA1 (TOTP) and gen_random_bytes.

-- =============================================================================
-- 0. EXTENSION
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. TABLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_2fa (
  user_id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_secret    TEXT NOT NULL,
  enabled             BOOLEAN NOT NULL DEFAULT false,
  failed_attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  last_verified_at    TIMESTAMPTZ,
  last_code_hash      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_2fa ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_2fa FROM authenticated, anon, public;

CREATE TABLE IF NOT EXISTS public.recovery_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recovery_codes_user_id ON public.recovery_codes(user_id);
ALTER TABLE public.recovery_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recovery_codes FROM authenticated, anon, public;

CREATE TABLE IF NOT EXISTS public.user_2fa_verifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_2fa_verifications_user ON public.user_2fa_verifications(user_id);
ALTER TABLE public.user_2fa_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_2fa_verifications FROM authenticated, anon, public;

-- =============================================================================
-- 2. HELPER — Base32 Decode (RFC 4648)
-- =============================================================================

CREATE OR REPLACE FUNCTION public._base32_decode(p_input TEXT)
RETURNS BYTEA LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_clean   TEXT;
  v_len     INT;
  v_accum   BIT(64) := B'0000000000000000000000000000000000000000000000000000000000000000';
  v_bits    INT := 0;
  v_result  BYTEA := '';
  v_ch      CHAR(1);
  v_val     INT;
  v_byte_int INT;
  i         INT;
BEGIN
  v_clean := UPPER(REPLACE(REPLACE(p_input, ' ', ''), '=', ''));
  v_len   := LENGTH(v_clean);
  FOR i IN 1..v_len LOOP
    v_ch := SUBSTRING(v_clean FROM i FOR 1);
    v_val := CASE v_ch
      WHEN 'A' THEN 0  WHEN 'B' THEN 1  WHEN 'C' THEN 2  WHEN 'D' THEN 3
      WHEN 'E' THEN 4  WHEN 'F' THEN 5  WHEN 'G' THEN 6  WHEN 'H' THEN 7
      WHEN 'I' THEN 8  WHEN 'J' THEN 9  WHEN 'K' THEN 10 WHEN 'L' THEN 11
      WHEN 'M' THEN 12 WHEN 'N' THEN 13 WHEN 'O' THEN 14 WHEN 'P' THEN 15
      WHEN 'Q' THEN 16 WHEN 'R' THEN 17 WHEN 'S' THEN 18 WHEN 'T' THEN 19
      WHEN 'U' THEN 20 WHEN 'V' THEN 21 WHEN 'W' THEN 22 WHEN 'X' THEN 23
      WHEN 'Y' THEN 24 WHEN 'Z' THEN 25 WHEN '2' THEN 26 WHEN '3' THEN 27
      WHEN '4' THEN 28 WHEN '5' THEN 29 WHEN '6' THEN 30 WHEN '7' THEN 31
      ELSE RAISE EXCEPTION 'Invalid base32 character: %', v_ch
    END;
    v_accum := (v_accum << 5) | v_val::BIT(64);
    v_bits  := v_bits + 5;
    IF v_bits >= 8 THEN
      v_byte_int := (v_accum >> (v_bits - 8))::INT & 255;
      v_result   := v_result || SET_BYTE(''::BYTEA, 0, v_byte_int);
      v_bits     := v_bits - 8;
      v_accum    := v_accum & ((1::BIT(64) << v_bits) - 1::BIT(64));
    END IF;
  END LOOP;
  RETURN v_result;
END;
$$;

-- =============================================================================
-- 3. HELPER — TOTP Verify (RFC 6238 / RFC 4226)
--    Returns TRUE if code matches for time step ±1.
-- =============================================================================

CREATE OR REPLACE FUNCTION public._verify_totp(p_secret_base32 TEXT, p_code TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
  v_key       BYTEA;
  v_t         BIGINT;
  v_offset    INT;
  v_bin_code  INT;
  v_hash      BYTEA;
  v_step      BIGINT;
BEGIN
  v_key := public._base32_decode(p_secret_base32);
  v_t   := FLOOR(EXTRACT(EPOCH FROM NOW()) / 30)::BIGINT;

  FOR v_step IN (v_t - 1)..(v_t + 1) LOOP
    v_hash := HMAC(pg_catalog.int8send(v_step), v_key, 'sha1');

    v_offset   := GET_BYTE(v_hash, 19) & 15;
    v_bin_code := ((GET_BYTE(v_hash, v_offset)     & 127) << 24)
                | ((GET_BYTE(v_hash, v_offset + 1) & 255) << 16)
                | ((GET_BYTE(v_hash, v_offset + 2) & 255) << 8)
                |  (GET_BYTE(v_hash, v_offset + 3) & 255);
    v_bin_code := v_bin_code % 1000000;

    IF LPAD(p_code, 6, '0') = LPAD(v_bin_code::TEXT, 6, '0') THEN
      RETURN TRUE;
    END IF;
  END LOOP;
  RETURN FALSE;
END;
$$;

-- =============================================================================
-- 4. HELPER — Generate random base32 secret (16 bytes → 26 chars)
-- =============================================================================

CREATE OR REPLACE FUNCTION public._generate_base32_secret()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_bytes   BYTEA;
  v_chars   TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  v_result  TEXT := '';
  v_bit_buf BIT(80) := B'0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
  v_bits    INT := 0;
  v_idx     INT;
  i         INT;
BEGIN
  v_bytes := GEN_RANDOM_BYTES(16);
  FOR i IN 0..15 LOOP
    v_bit_buf := v_bit_buf | (GET_BYTE(v_bytes, i)::BIT(80) << (72 - i * 8));
    v_bits    := v_bits + 8;
    WHILE v_bits >= 5 LOOP
      v_idx   := (v_bit_buf >> (v_bits - 5))::INT & 31;
      v_result := v_result || SUBSTRING(v_chars FROM (v_idx + 1) FOR 1);
      v_bits  := v_bits - 5;
    END LOOP;
  END LOOP;
  IF v_bits > 0 THEN
    v_idx   := (v_bit_buf << (5 - v_bits))::INT & 31;
    -- Need to shift remaining bits to top then extract
    v_idx   := ((v_bit_buf >> (v_bits - 5))::INT) & 31;
    v_result := v_result || SUBSTRING(v_chars FROM (v_idx + 1) FOR 1);
  END IF;
  RETURN v_result;
END;
$$;

-- =============================================================================
-- 5. 2FA STATUS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_2fa_status()
RETURNS TABLE (enabled BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

-- =============================================================================
-- 6. BEGIN 2FA ENROLLMENT — generates secret, returns otpauth URI
-- =============================================================================

CREATE OR REPLACE FUNCTION public.begin_2fa_enrollment()
RETURNS TABLE (secret TEXT, qr_uri TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_secret  TEXT;
  v_email   TEXT;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_user_id;

  -- If already enabled, reject
  IF EXISTS (SELECT 1 FROM public.user_2fa WHERE user_id = v_user_id AND enabled = true) THEN
    RAISE EXCEPTION '2FA is already enabled';
  END IF;

  v_secret := public._generate_base32_secret();

  INSERT INTO public.user_2fa (user_id, encrypted_secret, enabled)
  VALUES (v_user_id, v_secret, false)
  ON CONFLICT (user_id) DO UPDATE
    SET encrypted_secret = v_secret, enabled = false,
        failed_attempts = 0, locked_until = NULL, last_code_hash = NULL,
        updated_at = now();

  RETURN QUERY SELECT v_secret,
    'otpauth://totp/XReserve:' || COALESCE(v_email, v_user_id::TEXT)
    || '?secret=' || v_secret || '&issuer=XReserve&digits=6&period=30';
END;
$$;

-- =============================================================================
-- 7. CONFIRM 2FA ENROLLMENT — verify code, enable, generate recovery codes
-- =============================================================================

CREATE OR REPLACE FUNCTION public.confirm_2fa_enrollment(p_code TEXT)
RETURNS TABLE (success BOOLEAN, recovery_codes TEXT[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_secret  TEXT;
  v_codes   TEXT[] := '{}';
  v_chars   TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code    TEXT;
  v_hash    TEXT;
  i         INT;
  j         INT;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT encrypted_secret INTO v_secret
  FROM public.user_2fa WHERE user_id = v_user_id AND enabled = false;

  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'No pending 2FA enrollment. Call begin_2fa_enrollment first.';
  END IF;

  IF NOT public._verify_totp(v_secret, p_code) THEN
    UPDATE public.user_2fa SET failed_attempts = failed_attempts + 1 WHERE user_id = v_user_id;
    RAISE EXCEPTION 'Invalid code';
  END IF;

  UPDATE public.user_2fa SET enabled = true, failed_attempts = 0,
    locked_until = NULL, last_verified_at = now(), updated_at = now()
  WHERE user_id = v_user_id;

  DELETE FROM public.recovery_codes WHERE user_id = v_user_id;

  FOR i IN 1..10 LOOP
    v_code := '';
    FOR j IN 1..8 LOOP
      v_code := v_code || SUBSTRING(v_chars FROM (FLOOR(RANDOM() * 32)::INT + 1) FOR 1);
    END LOOP;
    v_hash := ENCODE(DIGEST(v_code, 'sha256'), 'hex');
    INSERT INTO public.recovery_codes (user_id, code_hash) VALUES (v_user_id, v_hash);
    v_codes := v_codes || v_code;
  END LOOP;

  INSERT INTO public.audit_logs (actor_id, action, target_type, metadata)
  VALUES (v_user_id, '2FA_ENABLED', 'user_2fa', jsonb_build_object('user_id', v_user_id));

  RETURN QUERY SELECT TRUE, v_codes;
END;
$$;

-- =============================================================================
-- 8. DISABLE 2FA — requires valid TOTP code
-- =============================================================================

CREATE OR REPLACE FUNCTION public.disable_2fa(p_code TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_secret  TEXT;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT encrypted_secret INTO v_secret
  FROM public.user_2fa WHERE user_id = v_user_id AND enabled = true;

  IF v_secret IS NULL THEN RAISE EXCEPTION '2FA is not enabled'; END IF;

  IF NOT public._verify_totp(v_secret, p_code) THEN
    UPDATE public.user_2fa SET failed_attempts = failed_attempts + 1 WHERE user_id = v_user_id;
    RAISE EXCEPTION 'Invalid code';
  END IF;

  UPDATE public.user_2fa SET enabled = false, updated_at = now() WHERE user_id = v_user_id;
  DELETE FROM public.recovery_codes WHERE user_id = v_user_id;
  DELETE FROM public.user_2fa_verifications WHERE user_id = v_user_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, metadata)
  VALUES (v_user_id, '2FA_DISABLED', 'user_2fa', jsonb_build_object('user_id', v_user_id));

  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 9. GET RECOVERY CODES — requires valid TOTP code
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_recovery_codes(p_code TEXT)
RETURNS TABLE (code TEXT, used BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_secret  TEXT;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT encrypted_secret INTO v_secret
  FROM public.user_2fa WHERE user_id = v_user_id AND enabled = true;

  IF v_secret IS NULL THEN RAISE EXCEPTION '2FA is not enabled'; END IF;

  IF NOT public._verify_totp(v_secret, p_code) THEN
    RAISE EXCEPTION 'Invalid code';
  END IF;

  RETURN QUERY SELECT rc.code_hash, rc.used FROM public.recovery_codes rc
    WHERE rc.user_id = v_user_id ORDER BY rc.created_at;
END;
$$;

-- =============================================================================
-- 10. VERIFY TOTP — creates verification record (5-min window)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.verify_2fa_code(p_code TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id    UUID := auth.uid();
  v_secret     TEXT;
  v_locked     TIMESTAMPTZ;
  v_code_hash  TEXT;
  v_ver_id     UUID;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  SELECT encrypted_secret, locked_until, last_code_hash
  INTO v_secret, v_locked, v_code_hash
  FROM public.user_2fa WHERE user_id = v_user_id AND enabled = true;

  IF v_secret IS NULL THEN RAISE EXCEPTION '2FA is not enabled'; END IF;

  -- Rate limit check
  IF v_locked IS NOT NULL AND v_locked > now() THEN
    RAISE EXCEPTION 'Too many failed attempts. Try again in % minutes',
      CEIL(EXTRACT(EPOCH FROM (v_locked - now())) / 60)::INT;
  END IF;

  -- Lockout after 5 failures
  IF (SELECT failed_attempts FROM public.user_2fa WHERE user_id = v_user_id) >= 5 THEN
    UPDATE public.user_2fa SET locked_until = now() + INTERVAL '15 minutes',
      failed_attempts = 0, updated_at = now() WHERE user_id = v_user_id;
    RAISE EXCEPTION 'Too many failed attempts. Locked for 15 minutes';
  END IF;

  -- Recovery code check
  v_code_hash := ENCODE(DIGEST(p_code, 'sha256'), 'hex');
  IF EXISTS (SELECT 1 FROM public.recovery_codes
    WHERE user_id = v_user_id AND code_hash = v_code_hash AND used = false) THEN
    UPDATE public.recovery_codes SET used = true, used_at = now()
    WHERE user_id = v_user_id AND code_hash = v_code_hash AND used = false;
    UPDATE public.user_2fa SET failed_attempts = 0, last_verified_at = now(),
      updated_at = now() WHERE user_id = v_user_id;
    INSERT INTO public.user_2fa_verifications (user_id, expires_at)
    VALUES (v_user_id, now() + INTERVAL '5 minutes') RETURNING id INTO v_ver_id;
    INSERT INTO public.audit_logs (actor_id, action, target_type, metadata)
    VALUES (v_user_id, '2FA_RECOVERY_USED', 'user_2fa', jsonb_build_object('user_id', v_user_id));
    RETURN v_ver_id;
  END IF;

  -- TOTP check
  IF NOT public._verify_totp(v_secret, p_code) THEN
    UPDATE public.user_2fa SET failed_attempts = failed_attempts + 1, updated_at = now()
    WHERE user_id = v_user_id;
    INSERT INTO public.audit_logs (actor_id, action, target_type, metadata)
    VALUES (v_user_id, '2FA_FAILED_ATTEMPT', 'user_2fa',
      jsonb_build_object('user_id', v_user_id));
    RAISE EXCEPTION 'Invalid code';
  END IF;

  -- Replay prevention
  IF v_code_hash IS NOT NULL AND v_code_hash = ENCODE(DIGEST(p_code, 'sha256'), 'hex') THEN
    -- Allow same code within 30s window only if no verification exists in current window
    IF EXISTS (SELECT 1 FROM public.user_2fa_verifications
      WHERE user_id = v_user_id AND expires_at > now() AND used = false) THEN
      RAISE EXCEPTION 'Code already used. Wait for a new code.';
    END IF;
  END IF;

  UPDATE public.user_2fa SET failed_attempts = 0, last_verified_at = now(),
    last_code_hash = ENCODE(DIGEST(p_code, 'sha256'), 'hex'), updated_at = now()
  WHERE user_id = v_user_id;

  INSERT INTO public.user_2fa_verifications (user_id, expires_at)
  VALUES (v_user_id, now() + INTERVAL '5 minutes') RETURNING id INTO v_ver_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, metadata)
  VALUES (v_user_id, '2FA_VERIFIED', 'user_2fa',
    jsonb_build_object('user_id', v_user_id, 'verification_id', v_ver_id));

  RETURN v_ver_id;
END;
$$;

-- =============================================================================
-- 11. HELPER — Check valid verification (used by enforcement)
-- =============================================================================

CREATE OR REPLACE FUNCTION public._require_2fa_verification(p_verification_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.user_2fa
    WHERE user_id = v_user_id AND enabled = true) THEN
    RAISE EXCEPTION '2FA is required but not enabled. Enable 2FA in Security settings.';
  END IF;

  IF p_verification_id IS NULL THEN
    RAISE EXCEPTION '2FA verification required. Provide a valid TOTP verification.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.user_2fa_verifications
    WHERE id = p_verification_id AND user_id = v_user_id
      AND expires_at > now() AND used = false) THEN
    RAISE EXCEPTION '2FA verification expired or invalid. Please verify again.';
  END IF;

  UPDATE public.user_2fa_verifications SET used = true WHERE id = p_verification_id;
  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 12. HELPER — Check 2FA enabled (no verification needed)
-- =============================================================================

CREATE OR REPLACE FUNCTION public._require_2fa_enabled()
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_2fa
    WHERE user_id = v_user_id AND enabled = true) THEN
    RAISE EXCEPTION '2FA is required. Enable 2FA in Security settings.';
  END IF;
  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 13. HELPER — Admin 2FA verification check
-- =============================================================================

CREATE OR REPLACE FUNCTION public._require_admin_2fa(p_verification_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_admin_user() THEN RAISE EXCEPTION 'not authorized'; END IF;
  PERFORM public._require_2fa_verification(p_verification_id);
  RETURN TRUE;
END;
$$;


-- =============================================================================
-- 14. ENFORCEMENT — create_sell_order requires TOTP verification
-- =============================================================================

DROP FUNCTION IF EXISTS public.create_sell_order(NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT);

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

  -- 2FA verification required
  PERFORM public._require_2fa_verification(p_verification_id);

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

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (v_user_id, 'SELL_ORDER_CREATED', 'sell_order', v_order_id,
    jsonb_build_object('usdt_amount', p_usdt_amount, 'inr_amount', p_inr_amount, 'verification_id', p_verification_id));

  RETURN v_order_id;
END;
$$;

-- =============================================================================
-- 15. ENFORCEMENT — Admin deposit functions require TOTP verification
-- =============================================================================

-- admin_update_deposit_status
DROP FUNCTION IF EXISTS public.admin_update_deposit_status(UUID, TEXT);

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
  PERFORM public._require_admin_2fa(p_verification_id);

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
  VALUES (
    auth.uid(),
    CASE p_new_status
      WHEN 'UNDER_REVIEW' THEN 'DEPOSIT_UNDER_REVIEW'
      WHEN 'REJECTED'     THEN 'DEPOSIT_REJECTED'
      WHEN 'PENDING'      THEN 'DEPOSIT_REOPENED'
      ELSE 'DEPOSIT_STATUS_CHANGE'
    END,
    'deposit', p_deposit_id,
    jsonb_build_object('previous_status', v_current_status, 'new_status', p_new_status, 'verification_id', p_verification_id)
  );

  RETURN TRUE;
END;
$$;

-- admin_credit_deposit
DROP FUNCTION IF EXISTS public.admin_credit_deposit(UUID, NUMERIC);

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
  PERFORM public._require_admin_2fa(p_verification_id);

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
  VALUES
    (v_wallet_id, 'CREDIT', p_amount, v_balance_before, v_balance_before + p_amount, 'deposit', p_deposit_id, '{"direction":"credit","context":"admin_deposit_credit"}'::jsonb);

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
-- 16. ENFORCEMENT — Admin sell order functions require TOTP verification
-- =============================================================================

-- admin_complete_sell_order
DROP FUNCTION IF EXISTS public.admin_complete_sell_order(UUID);

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
  PERFORM public._require_admin_2fa(p_verification_id);

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

  UPDATE public.wallet_balances
     SET reserved_usdt = reserved_usdt - v_order.usdt_amount, updated_at = now()
   WHERE wallet_id = v_wallet_id;

  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES
    (v_wallet_id, 'CONSUME', v_order.usdt_amount, v_reserved, v_reserved - v_order.usdt_amount, 'sell_order', p_order_id, '{"direction":"reserved_subtracted","context":"sell_completed"}'::jsonb);

  UPDATE public.sell_orders
     SET status = 'COMPLETED', updated_at = now()
   WHERE id = p_order_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'SELL_COMPLETED', 'sell_order', p_order_id,
    jsonb_build_object('previous_status', v_order.status, 'new_status', 'COMPLETED', 'usdt_amount', v_order.usdt_amount, 'inr_amount', v_order.inr_amount, 'user_id', v_order.user_id, 'verification_id', p_verification_id));

  RETURN TRUE;
END;
$$;

-- admin_reject_sell_order
DROP FUNCTION IF EXISTS public.admin_reject_sell_order(UUID, TEXT);

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
  PERFORM public._require_admin_2fa(p_verification_id);

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

  UPDATE public.wallet_balances
     SET reserved_usdt  = reserved_usdt - v_order.usdt_amount,
         available_usdt = available_usdt + v_order.usdt_amount,
         updated_at = now()
   WHERE wallet_id = v_wallet_id;

  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES
    (v_wallet_id, 'RELEASE', v_order.usdt_amount, v_available, v_available + v_order.usdt_amount, 'sell_order', p_order_id, ('{"direction":"reserved_to_available","context":"sell_' || lower(p_status) || '"}')::jsonb);

  UPDATE public.sell_orders
     SET status = p_status, updated_at = now()
   WHERE id = p_order_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    CASE p_status WHEN 'CANCELLED' THEN 'SELL_CANCELLED' ELSE 'SELL_REJECTED' END,
    'sell_order', p_order_id,
    jsonb_build_object('previous_status', v_order.status, 'new_status', p_status, 'usdt_amount', v_order.usdt_amount, 'user_id', v_order.user_id, 'verification_id', p_verification_id)
  );

  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 17. SECURITY — REVOKE CLIENT ACCESS
-- =============================================================================

-- 2FA management: authenticated users only
REVOKE EXECUTE ON FUNCTION public.get_2fa_status()                  FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.begin_2fa_enrollment()            FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.confirm_2fa_enrollment(TEXT)      FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.disable_2fa(TEXT)                 FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_recovery_codes(TEXT)          FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.verify_2fa_code(TEXT)             FROM anon, public;

-- Internal helpers: revoke from ALL client roles
REVOKE EXECUTE ON FUNCTION public._base32_decode(TEXT)              FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public._verify_totp(TEXT, TEXT)          FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public._generate_base32_secret()         FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public._require_2fa_verification(UUID)   FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public._require_2fa_enabled()            FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public._require_admin_2fa(UUID)          FROM authenticated, anon, public;

-- Updated create_sell_order signature
REVOKE EXECUTE ON FUNCTION public.create_sell_order(NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, UUID) FROM anon, public;

-- Updated admin functions
REVOKE EXECUTE ON FUNCTION public.admin_update_deposit_status(UUID, TEXT, UUID)   FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_credit_deposit(UUID, NUMERIC, UUID)       FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_complete_sell_order(UUID, UUID)           FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_reject_sell_order(UUID, TEXT, UUID)       FROM anon, public;
