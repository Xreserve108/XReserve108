-- 032 — Admin Users Management V1 (Read-Only)
-- Three new SECURITY DEFINER RPCs for admin user listing, 360° detail, and stats.
-- Does NOT modify any existing tables, RLS policies, or RPCs.

-- =============================================================================
-- 1. admin_list_users — paginated user list with search and filters
-- =============================================================================
CREATE OR REPLACE FUNCTION public.admin_list_users(
  p_search TEXT DEFAULT NULL,
  p_filter TEXT DEFAULT 'all',
  p_limit INT DEFAULT 20,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  user_id UUID,
  username TEXT,
  email TEXT,
  full_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ,
  available_usdt NUMERIC,
  has_2fa BOOLEAN,
  has_pending_deposit BOOLEAN,
  has_pending_sell_order BOOLEAN,
  total_deposits BIGINT,
  total_sell_orders BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Authorization: must be an active admin
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE user_id = auth.uid() AND is_active = true
  ) THEN
    RAISE EXCEPTION 'admin_only';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.username,
    p.email,
    p.full_name,
    p.avatar_url,
    p.created_at,
    COALESCE(wb.available_usdt, 0),
    COALESCE(u2fa.enabled, false),
    COALESCE(pd.has_pending, false),
    COALESCE(ps.has_pending, false),
    COALESCE(td.cnt, 0),
    COALESCE(ts.cnt, 0)
  FROM public.profiles p
  LEFT JOIN public.wallets w ON w.user_id = p.id
  LEFT JOIN public.wallet_balances wb ON wb.wallet_id = w.id
  LEFT JOIN public.user_2fa u2fa ON u2fa.user_id = p.id
  LEFT JOIN LATERAL (
    SELECT true AS has_pending
    FROM public.deposits d
    WHERE d.user_id = p.id AND d.status IN ('PENDING', 'PENDING_VERIFICATION', 'UNDER_REVIEW')
    LIMIT 1
  ) pd ON true
  LEFT JOIN LATERAL (
    SELECT true AS has_pending
    FROM public.sell_orders so
    WHERE so.user_id = p.id AND so.status IN ('PAYMENT_PENDING', 'PAYMENT_PROOF_UPLOADED', 'MANUAL_REVIEW')
    LIMIT 1
  ) ps ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS cnt
    FROM public.deposits d2
    WHERE d2.user_id = p.id
  ) td ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::BIGINT AS cnt
    FROM public.sell_orders so2
    WHERE so2.user_id = p.id
  ) ts ON true
  WHERE
    -- Search filter
    (p_search IS NULL OR p_search = '' OR
     p.username ILIKE '%' || p_search || '%' OR
     p.email ILIKE '%' || p_search || '%' OR
     p.id::TEXT ILIKE '%' || p_search || '%')
    AND
    -- Category filter
    CASE p_filter
      WHEN 'all' THEN true
      WHEN '2fa_on' THEN COALESCE(u2fa.enabled, false) = true
      WHEN '2fa_off' THEN COALESCE(u2fa.enabled, false) = false
      WHEN 'pending_deposit' THEN COALESCE(pd.has_pending, false) = true
      WHEN 'pending_sell' THEN COALESCE(ps.has_pending, false) = true
      ELSE true
    END
  ORDER BY p.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$$;

-- =============================================================================
-- 2. admin_get_user_360 — full user detail aggregation
-- =============================================================================
CREATE OR REPLACE FUNCTION public.admin_get_user_360(
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_profile JSONB;
  v_wallet JSONB;
  v_deposits JSONB;
  v_sell_orders JSONB;
  v_bank_accounts JSONB;
  v_two_fa JSONB;
BEGIN
  -- Authorization: must be an active admin
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE user_id = auth.uid() AND is_active = true
  ) THEN
    RAISE EXCEPTION 'admin_only';
  END IF;

  -- Profile
  SELECT jsonb_build_object(
    'user_id', p.id,
    'username', p.username,
    'email', p.email,
    'full_name', p.full_name,
    'avatar_url', p.avatar_url,
    'created_at', p.created_at,
    'updated_at', p.updated_at
  ) INTO v_profile
  FROM public.profiles p
  WHERE p.id = p_user_id;

  IF v_profile IS NULL THEN
    RETURN NULL;
  END IF;

  -- Wallet balance
  SELECT jsonb_build_object(
    'available_usdt', COALESCE(wb.available_usdt, 0),
    'reserved_usdt', COALESCE(wb.reserved_usdt, 0),
    'total_usdt', COALESCE(wb.available_usdt, 0) + COALESCE(wb.reserved_usdt, 0)
  ) INTO v_wallet
  FROM public.wallets w
  LEFT JOIN public.wallet_balances wb ON wb.wallet_id = w.id
  WHERE w.user_id = p_user_id;

  -- Deposits (latest 50)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', d.id,
      'network', d.network,
      'token', d.token,
      'expected_amount', d.expected_amount,
      'actual_amount', d.actual_amount,
      'declared_amount', d.declared_amount,
      'verified_amount', d.verified_amount,
      'status', d.status,
      'tx_hash', d.tx_hash,
      'created_at', d.created_at,
      'updated_at', d.updated_at
    ) ORDER BY d.created_at DESC
  ), '[]'::jsonb) INTO v_deposits
  FROM public.deposits d
  WHERE d.user_id = p_user_id
  LIMIT 50;

  -- Sell orders (latest 50)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', so.id,
      'usdt_amount', so.usdt_amount,
      'inr_amount', so.inr_amount,
      'exchange_rate', so.exchange_rate,
      'status', so.status,
      'bank_name', so.bank_name,
      'account_holder_name', so.account_holder_name,
      'account_number', _mask_account(so.account_number),
      'ifsc_code', so.ifsc_code,
      'created_at', so.created_at,
      'updated_at', so.updated_at
    ) ORDER BY so.created_at DESC
  ), '[]'::jsonb) INTO v_sell_orders
  FROM public.sell_orders so
  WHERE so.user_id = p_user_id
  LIMIT 50;

  -- Bank accounts (with masked account numbers)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', ba.id,
      'bank_name', ba.bank_name,
      'account_holder_name', ba.account_holder_name,
      'account_number', _mask_account(ba.account_number),
      'ifsc_code', ba.ifsc_code,
      'created_at', ba.created_at
    ) ORDER BY ba.created_at DESC
  ), '[]'::jsonb) INTO v_bank_accounts
  FROM public.bank_accounts ba
  WHERE ba.user_id = p_user_id;

  -- 2FA status (safe fields only — never expose secrets)
  SELECT jsonb_build_object(
    'enabled', COALESCE(u2fa.enabled, false),
    'created_at', u2fa.created_at,
    'last_verified_at', u2fa.last_verified_at
  ) INTO v_two_fa
  FROM public.user_2fa u2fa
  WHERE u2fa.user_id = p_user_id;

  RETURN jsonb_build_object(
    'profile', v_profile,
    'wallet', v_wallet,
    'deposits', v_deposits,
    'sell_orders', v_sell_orders,
    'bank_accounts', v_bank_accounts,
    'two_fa', v_two_fa
  );
END;
$$;

-- =============================================================================
-- 3. admin_user_stats — summary statistics
-- =============================================================================
CREATE OR REPLACE FUNCTION public.admin_user_stats()
RETURNS TABLE (
  total_users BIGINT,
  users_with_2fa BIGINT,
  users_with_pending_activity BIGINT,
  new_users_7d BIGINT,
  new_users_30d BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Authorization: must be an active admin
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE user_id = auth.uid() AND is_active = true
  ) THEN
    RAISE EXCEPTION 'admin_only';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT COUNT(*)::BIGINT FROM public.profiles) AS total_users,
    (SELECT COUNT(*)::BIGINT FROM public.user_2fa WHERE enabled = true) AS users_with_2fa,
    (
      SELECT COUNT(DISTINCT p.id)::BIGINT
      FROM public.profiles p
      WHERE EXISTS (
        SELECT 1 FROM public.deposits d
        WHERE d.user_id = p.id AND d.status IN ('PENDING', 'PENDING_VERIFICATION', 'UNDER_REVIEW')
      )
      OR EXISTS (
        SELECT 1 FROM public.sell_orders so
        WHERE so.user_id = p.id AND so.status IN ('PAYMENT_PENDING', 'PAYMENT_PROOF_UPLOADED', 'MANUAL_REVIEW')
      )
    ) AS users_with_pending_activity,
    (SELECT COUNT(*)::BIGINT FROM public.profiles WHERE created_at >= now() - INTERVAL '7 days') AS new_users_7d,
    (SELECT COUNT(*)::BIGINT FROM public.profiles WHERE created_at >= now() - INTERVAL '30 days') AS new_users_30d;
END;
$$;

-- =============================================================================
-- Helper: mask account number (mirrors frontend maskAccountNumber logic)
-- Shows only last 4 digits.
-- =============================================================================
CREATE OR REPLACE FUNCTION public._mask_account(p_account_number TEXT)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  v_raw TEXT;
  v_last4 TEXT;
  v_prefix_len INT;
  v_masked TEXT;
  v_i INT;
BEGIN
  v_raw := TRIM(COALESCE(p_account_number, ''));
  IF LENGTH(v_raw) <= 4 THEN
    RETURN 'XXXX ' || v_raw;
  END IF;
  v_last4 := RIGHT(v_raw, 4);
  v_prefix_len := LENGTH(v_raw) - 4;
  v_masked := '';
  v_i := 0;
  WHILE v_i < v_prefix_len LOOP
    v_masked := v_masked || 'XXXX ';
    v_i := v_i + 4;
  END LOOP;
  RETURN TRIM(v_masked || v_last4);
END;
$$;
