-- =============================================================================
-- XReserve Migration 026 — Ticket UX Fixes
-- =============================================================================
--
-- Addresses issues found during end-to-end testing:
--
--   1. New RPC: support_get_user_recent_transactions()
--      Returns the authenticated user's recent deposits and sell orders
--      for the ticket-creation transaction selector.
--      Ownership enforced via auth.uid().
--
--   2. Enhanced RPC: support_get_user_ticket()
--      Now includes linked transaction details (amount, status, network,
--      reference) so the ticket popup can display transaction context
--      without a separate query.
--
-- No changes to wallet logic, deposit processing, sell order processing,
-- 2FA, or financial RPCs.
-- =============================================================================

-- =============================================================================
-- PART 1 — New RPC: Recent transactions for ticket selector
-- =============================================================================

CREATE OR REPLACE FUNCTION public.support_get_user_recent_transactions()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_deposits JSONB;
  v_sell_orders JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Recent deposits (up to 15)
  SELECT COALESCE(jsonb_agg(d ORDER BY d.created_at DESC), '[]'::jsonb)
  INTO v_deposits
  FROM (
    SELECT
      d.id,
      'deposit'                          AS type,
      d.expected_amount                  AS amount,
      d.token                            AS asset,
      d.network,
      d.status,
      d.tx_hash,
      d.created_at
    FROM public.deposits d
    WHERE d.user_id = v_user_id
    ORDER BY d.created_at DESC
    LIMIT 15
  ) d;

  -- Recent sell orders (up to 15)
  SELECT COALESCE(jsonb_agg(s ORDER BY s.created_at DESC), '[]'::jsonb)
  INTO v_sell_orders
  FROM (
    SELECT
      s.id,
      'sell_order'                       AS type,
      s.usdt_amount                      AS amount,
      'USDT'                             AS asset,
      s.inr_amount,
      s.status,
      s.created_at
    FROM public.sell_orders s
    WHERE s.user_id = v_user_id
    ORDER BY s.created_at DESC
    LIMIT 15
  ) s;

  RETURN jsonb_build_object(
    'deposits',    v_deposits,
    'sell_orders', v_sell_orders
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_get_user_recent_transactions() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_get_user_recent_transactions() TO   authenticated;

-- =============================================================================
-- PART 2 — Enhanced RPC: User ticket detail with linked transaction info
-- =============================================================================

CREATE OR REPLACE FUNCTION public.support_get_user_ticket(
  p_ticket_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ticket JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required';
  END IF;

  SELECT jsonb_build_object(
    'id', t.id,
    'ticket_number', t.ticket_number,
    'category', t.category,
    'subject', t.subject,
    'description', t.description,
    'status', t.status,
    'priority', t.priority,
    'created_at', t.created_at,
    'updated_at', t.updated_at,
    'resolved_at', t.resolved_at,
    'closed_at', t.closed_at,
    'related_deposit_id', t.related_deposit_id,
    'related_sell_order_id', t.related_sell_order_id,
    'reference_hash', t.reference_hash,
    -- Linked deposit details (NULL if not a deposit ticket)
    'deposit_info', (
      SELECT jsonb_build_object(
        'id', d.id,
        'amount', d.expected_amount,
        'asset', d.token,
        'network', d.network,
        'status', d.status,
        'tx_hash', d.tx_hash,
        'created_at', d.created_at
      )
      FROM public.deposits d
      WHERE d.id = t.related_deposit_id
        AND d.user_id = auth.uid()
    ),
    -- Linked sell-order details (NULL if not a sell-order ticket)
    'sell_order_info', (
      SELECT jsonb_build_object(
        'id', s.id,
        'usdt_amount', s.usdt_amount,
        'inr_amount', s.inr_amount,
        'status', s.status,
        'created_at', s.created_at
      )
      FROM public.sell_orders s
      WHERE s.id = t.related_sell_order_id
        AND s.user_id = auth.uid()
    ),
    -- Messages (conversation thread — excludes internal notes)
    'messages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id,
        'sender_type', m.sender_type,
        'body', m.body,
        'created_at', m.created_at,
        'read_at', m.read_at
      ) ORDER BY m.created_at ASC)
      FROM public.support_ticket_messages m
      WHERE m.ticket_id = t.id
    ), '[]'::jsonb)
  )
  INTO v_ticket
  FROM public.support_tickets t
  WHERE t.id = p_ticket_id AND t.user_id = auth.uid();

  IF v_ticket IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN v_ticket;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_get_user_ticket(UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_get_user_ticket(UUID) TO   authenticated;

-- =============================================================================
-- MIGRATION COMPLETE
-- =============================================================================
-- Phase 2 Ticket UX Fixes:
-- - support_get_user_recent_transactions() for transaction selector
-- - support_get_user_ticket() enhanced with deposit_info / sell_order_info
-- - Internal notes remain inaccessible to users (only via admin RPCs)
-- - All financial logic untouched
-- =============================================================================
