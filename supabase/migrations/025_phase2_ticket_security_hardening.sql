-- =============================================================================
-- XReserve Migration 025 — Phase 2 Ticket Security Hardening
-- =============================================================================
--
-- Two fixes from the Phase 2 read-only audit:
--
-- FIX 1: support_admin_assign_ticket — validate agent is active admin
--   Previously only checked profiles existence. Now requires the agent
--   to exist in admin_users with role='super_admin' AND is_active=true.
--
-- FIX 2: support_admin_update_ticket_status — enforce transition matrix
--   Previously accepted any status from any state. Now enforces:
--     OPEN → IN_PROGRESS, WAITING_FOR_USER, WAITING_FOR_SUPPORT, RESOLVED, CLOSED
--     IN_PROGRESS → WAITING_FOR_USER, WAITING_FOR_SUPPORT, RESOLVED, CLOSED
--     WAITING_FOR_USER → WAITING_FOR_SUPPORT, RESOLVED, CLOSED
--     WAITING_FOR_SUPPORT → WAITING_FOR_USER, RESOLVED, CLOSED
--     RESOLVED → CLOSED, WAITING_FOR_SUPPORT
--     CLOSED → (terminal — no transitions allowed)
--
-- CONSISTENCY FIX: support_admin_reply_to_ticket — reject CLOSED tickets
--   Previously allowed replies on closed tickets. Now explicitly rejects
--   them to stay consistent with CLOSED being terminal.
--
-- No tables created. No financial tables modified. No Live Chat modified.
-- =============================================================================

-- =============================================================================
-- FIX 1: Admin assignment — require active admin
-- =============================================================================

CREATE OR REPLACE FUNCTION public.support_admin_assign_ticket(
  p_ticket_id UUID,
  p_agent_id  UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ticket_number TEXT;
  v_ticket_user UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required';
  END IF;

  SELECT ticket_number, user_id
  INTO v_ticket_number, v_ticket_user
  FROM public.support_tickets
  WHERE id = p_ticket_id;

  IF v_ticket_user IS NULL THEN
    RAISE EXCEPTION 'ticket not found';
  END IF;

  -- Validate agent is an active admin (not just any profile)
  IF p_agent_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.admin_users
      WHERE user_id = p_agent_id
        AND role = 'super_admin'
        AND is_active = true
    ) THEN
      RAISE EXCEPTION 'agent is not an active admin';
    END IF;
  END IF;

  UPDATE public.support_tickets
  SET assigned_agent_id = p_agent_id,
      status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END,
      updated_at = now()
  WHERE id = p_ticket_id;

  IF p_agent_id IS NOT NULL THEN
    PERFORM public.create_notification(
      v_ticket_user,
      'ticket_assigned',
      '🎫 Ticket ' || v_ticket_number || ' assigned',
      'A support agent has been assigned to your ticket',
      jsonb_build_object('ticket_id', p_ticket_id, 'ticket_number', v_ticket_number),
      p_ticket_id
    );
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_assign_ticket(UUID, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_admin_assign_ticket(UUID, UUID) TO   authenticated;

-- =============================================================================
-- FIX 2: Status transition matrix enforcement
-- =============================================================================

CREATE OR REPLACE FUNCTION public.support_admin_update_ticket_status(
  p_ticket_id UUID,
  p_status    TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ticket_number TEXT;
  v_ticket_user UUID;
  v_current_status TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required';
  END IF;
  IF p_status NOT IN ('OPEN','IN_PROGRESS','WAITING_FOR_USER','WAITING_FOR_SUPPORT','RESOLVED','CLOSED') THEN
    RAISE EXCEPTION 'invalid status';
  END IF;

  SELECT ticket_number, user_id, status
  INTO v_ticket_number, v_ticket_user, v_current_status
  FROM public.support_tickets
  WHERE id = p_ticket_id;

  IF v_ticket_user IS NULL THEN
    RAISE EXCEPTION 'ticket not found';
  END IF;

  -- Enforce transition matrix
  IF v_current_status = p_status THEN
    -- Same status: no-op, skip validation and notification
    RETURN TRUE;
  END IF;

  IF v_current_status = 'CLOSED' THEN
    RAISE EXCEPTION 'cannot change status of a closed ticket';
  END IF;

  IF v_current_status = 'RESOLVED' AND p_status NOT IN ('CLOSED', 'WAITING_FOR_SUPPORT') THEN
    RAISE EXCEPTION 'invalid status transition from resolved';
  END IF;

  IF v_current_status IN ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_SUPPORT')
     AND p_status NOT IN ('IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_SUPPORT', 'RESOLVED', 'CLOSED') THEN
    RAISE EXCEPTION 'invalid status transition';
  END IF;

  UPDATE public.support_tickets
  SET status = p_status,
      resolved_at = CASE WHEN p_status = 'RESOLVED' THEN now() ELSE resolved_at END,
      closed_at = CASE WHEN p_status = 'CLOSED' THEN now() ELSE closed_at END,
      updated_at = now()
  WHERE id = p_ticket_id;

  IF p_status = 'RESOLVED' THEN
    PERFORM public.create_notification(
      v_ticket_user,
      'ticket_resolved',
      '🎫 Ticket ' || v_ticket_number || ' resolved',
      'Support believes your issue has been resolved',
      jsonb_build_object('ticket_id', p_ticket_id, 'ticket_number', v_ticket_number),
      p_ticket_id
    );
  ELSIF p_status = 'CLOSED' AND v_current_status != 'CLOSED' THEN
    PERFORM public.create_notification(
      v_ticket_user,
      'ticket_closed',
      '🎫 Ticket ' || v_ticket_number || ' closed',
      'Your support ticket has been closed',
      jsonb_build_object('ticket_id', p_ticket_id, 'ticket_number', v_ticket_number),
      p_ticket_id
    );
  ELSIF p_status IN ('IN_PROGRESS', 'WAITING_FOR_USER') AND v_current_status != p_status THEN
    PERFORM public.create_notification(
      v_ticket_user,
      'ticket_status_changed',
      '🎫 Ticket ' || v_ticket_number || ' updated',
      'Status: ' || replace(p_status, '_', ' '),
      jsonb_build_object('ticket_id', p_ticket_id, 'ticket_number', v_ticket_number),
      p_ticket_id
    );
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_update_ticket_status(UUID, TEXT) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_admin_update_ticket_status(UUID, TEXT) TO   authenticated;

-- =============================================================================
-- CONSISTENCY FIX: Reject admin replies on CLOSED tickets
-- =============================================================================
-- Ensures support_admin_reply_to_ticket stays consistent with the CLOSED-is-
-- terminal rule enforced by support_admin_update_ticket_status.

CREATE OR REPLACE FUNCTION public.support_admin_reply_to_ticket(
  p_ticket_id UUID,
  p_body      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_msg_id UUID;
  v_ticket_number TEXT;
  v_ticket_user UUID;
  v_ticket_status TEXT;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required';
  END IF;
  IF p_body IS NULL OR char_length(trim(p_body)) = 0 THEN
    RAISE EXCEPTION 'message is required';
  END IF;
  IF char_length(p_body) > 4000 THEN
    RAISE EXCEPTION 'message is too long';
  END IF;

  SELECT ticket_number, user_id, status
  INTO v_ticket_number, v_ticket_user, v_ticket_status
  FROM public.support_tickets
  WHERE id = p_ticket_id;

  IF v_ticket_user IS NULL THEN
    RAISE EXCEPTION 'ticket not found';
  END IF;
  IF v_ticket_status = 'CLOSED' THEN
    RAISE EXCEPTION 'cannot reply to a closed ticket';
  END IF;

  INSERT INTO public.support_ticket_messages (ticket_id, sender_id, sender_type, body)
  VALUES (p_ticket_id, v_admin_id, 'admin', trim(p_body))
  RETURNING id INTO v_msg_id;

  IF v_ticket_status IN ('OPEN', 'WAITING_FOR_SUPPORT') THEN
    UPDATE public.support_tickets
    SET status = 'WAITING_FOR_USER',
        assigned_agent_id = COALESCE(assigned_agent_id, v_admin_id),
        updated_at = now()
    WHERE id = p_ticket_id;
  ELSE
    UPDATE public.support_tickets
    SET updated_at = now()
    WHERE id = p_ticket_id;
  END IF;

  PERFORM public.create_notification(
    v_ticket_user,
    'ticket_support_replied',
    '🎫 Support replied to ' || v_ticket_number,
    left(trim(p_body), 100),
    jsonb_build_object('ticket_id', p_ticket_id, 'ticket_number', v_ticket_number),
    p_ticket_id
  );

  RETURN jsonb_build_object('message_id', v_msg_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_reply_to_ticket(UUID, TEXT) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_admin_reply_to_ticket(UUID, TEXT) TO   authenticated;

-- =============================================================================
-- MIGRATION 025 COMPLETE
-- =============================================================================
