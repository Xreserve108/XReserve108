-- 033 — Fix admin_list_users() ambiguous user_id reference
-- The RETURNS TABLE output column "user_id" collides with the bare "user_id"
-- reference in the auth check's WHERE clause (admin_users.user_id).
-- Fix: explicitly qualify with the table name.
-- Does NOT modify any other functions, tables, RLS policies, or RPCs.

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
    WHERE admin_users.user_id = auth.uid() AND admin_users.is_active = true
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
