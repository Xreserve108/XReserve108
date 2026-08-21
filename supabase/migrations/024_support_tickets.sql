-- =============================================================================
-- XReserve Migration 024 — Support Tickets (Phase 2)
-- =============================================================================
--
-- Independent support-ticket system, separate from live chat (Phase 1).
--
-- Tables:
--   support_tickets              — ticket header (status, priority, category)
--   support_ticket_messages      — user ↔ agent conversation
--   support_ticket_internal_notes — admin-only notes (invisible to users)
--
-- Security:
--   RLS enforced; users see only their own tickets/messages.
--   Internal notes accessible only via SECURITY DEFINER admin RPCs.
--   Existing admin_users authorization reused (is_admin_user()).
--
-- Ticket numbers:
--   Sequence-based XR-NNNN format (starting at 1001).
--   Generated at the database level inside the create RPC.
--
-- Notifications:
--   Reuses existing create_notification() / notify_admins() helpers.
-- =============================================================================

-- =============================================================================
-- PART 1 — Tables
-- =============================================================================

-- 1A. Support tickets
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number         TEXT        NOT NULL,
  user_id               UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  assigned_agent_id     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  category              TEXT        NOT NULL CHECK (category IN (
                        'Deposit','Sell Order','Account','2FA / Security','Wallet','Transaction','Other')),
  subject               TEXT        NOT NULL CHECK (char_length(subject) > 0 AND char_length(subject) <= 200),
  description           TEXT        NOT NULL CHECK (char_length(description) > 0 AND char_length(description) <= 5000),
  status                TEXT        NOT NULL DEFAULT 'OPEN'
                        CHECK (status IN (
                          'OPEN','IN_PROGRESS','WAITING_FOR_USER',
                          'WAITING_FOR_SUPPORT','RESOLVED','CLOSED')),
  priority              TEXT        NOT NULL DEFAULT 'NORMAL'
                        CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  related_deposit_id    UUID        REFERENCES public.deposits(id) ON DELETE SET NULL,
  related_sell_order_id UUID        REFERENCES public.sell_orders(id) ON DELETE SET NULL,
  reference_hash        TEXT,
  chat_session_id       UUID        REFERENCES public.support_chat_sessions(id) ON DELETE SET NULL,
  resolved_at           TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_ticket_number
  ON public.support_tickets (ticket_number);

CREATE INDEX IF NOT EXISTS idx_support_tickets_user_id
  ON public.support_tickets (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status
  ON public.support_tickets (status) WHERE status NOT IN ('CLOSED');

CREATE INDEX IF NOT EXISTS idx_support_tickets_assigned
  ON public.support_tickets (assigned_agent_id)
  WHERE status NOT IN ('CLOSED');

CREATE INDEX IF NOT EXISTS idx_support_tickets_admin_list
  ON public.support_tickets (created_at DESC)
  WHERE status NOT IN ('CLOSED');

-- 1B. Ticket messages (user ↔ agent conversation)
CREATE TABLE IF NOT EXISTS public.support_ticket_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID        NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  sender_id   UUID        NOT NULL REFERENCES auth.users(id),
  sender_type TEXT        NOT NULL CHECK (sender_type IN ('user','admin')),
  body        TEXT        NOT NULL CHECK (char_length(body) > 0 AND char_length(body) <= 4000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_id
  ON public.support_ticket_messages (ticket_id, created_at ASC);

-- 1C. Internal notes (admin-only, invisible to users)
CREATE TABLE IF NOT EXISTS public.support_ticket_internal_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID        NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  admin_id    UUID        NOT NULL REFERENCES auth.users(id),
  note        TEXT        NOT NULL CHECK (char_length(note) > 0 AND char_length(note) <= 4000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_internal_notes_ticket_id
  ON public.support_ticket_internal_notes (ticket_id, created_at ASC);

-- =============================================================================
-- PART 2 — RLS
-- =============================================================================

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_ticket_internal_notes ENABLE ROW LEVEL SECURITY;

-- Tickets: users see only their own
CREATE POLICY support_tickets_select_own
  ON public.support_tickets FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Messages: users see only messages belonging to their own tickets
CREATE POLICY support_ticket_messages_select_own
  ON public.support_ticket_messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = support_ticket_messages.ticket_id
        AND t.user_id = auth.uid()
    )
  );

-- Internal notes: NO user access at all (no SELECT policy for authenticated)
-- Access only through SECURITY DEFINER RPCs that check is_admin_user()

-- Revoke direct DML on all three tables
REVOKE INSERT, UPDATE, DELETE ON public.support_tickets FROM anon, authenticated, public;
REVOKE INSERT, UPDATE, DELETE ON public.support_ticket_messages FROM anon, authenticated, public;
REVOKE INSERT, UPDATE, DELETE ON public.support_ticket_internal_notes FROM anon, authenticated, public;

GRANT SELECT ON public.support_tickets TO authenticated;
GRANT SELECT ON public.support_ticket_messages TO authenticated;
-- No GRANT SELECT on internal_notes to authenticated — admin-only via RPC

-- =============================================================================
-- PART 3 — Ticket number generation
-- =============================================================================

CREATE SEQUENCE IF NOT EXISTS public.support_ticket_number_seq
  START WITH 1001
  INCREMENT BY 1
  NO MINVALUE
  NO MAXVALUE
  CACHE 10;

-- =============================================================================
-- PART 4 — USER RPCs
-- =============================================================================

-- 4A. Create ticket
CREATE OR REPLACE FUNCTION public.support_create_ticket(
  p_category           TEXT,
  p_subject            TEXT,
  p_description        TEXT,
  p_related_deposit_id UUID DEFAULT NULL,
  p_related_sell_order_id UUID DEFAULT NULL,
  p_reference_hash     TEXT DEFAULT NULL,
  p_chat_session_id    UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_ticket_id UUID;
  v_ticket_number TEXT;
  v_seq_val BIGINT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Validate category
  IF p_category NOT IN ('Deposit','Sell Order','Account','2FA / Security','Wallet','Transaction','Other') THEN
    RAISE EXCEPTION 'invalid category';
  END IF;

  -- Validate subject
  IF p_subject IS NULL OR char_length(trim(p_subject)) = 0 THEN
    RAISE EXCEPTION 'subject is required';
  END IF;
  IF char_length(p_subject) > 200 THEN
    RAISE EXCEPTION 'subject is too long';
  END IF;

  -- Validate description
  IF p_description IS NULL OR char_length(trim(p_description)) = 0 THEN
    RAISE EXCEPTION 'description is required';
  END IF;
  IF char_length(p_description) > 5000 THEN
    RAISE EXCEPTION 'description is too long';
  END IF;

  -- Validate related deposit ownership
  IF p_related_deposit_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.deposits d WHERE d.id = p_related_deposit_id AND d.user_id = v_user_id
    ) THEN
      RAISE EXCEPTION 'deposit not found';
    END IF;
  END IF;

  -- Validate related sell order ownership
  IF p_related_sell_order_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.sell_orders so WHERE so.id = p_related_sell_order_id AND so.user_id = v_user_id
    ) THEN
      RAISE EXCEPTION 'sell order not found';
    END IF;
  END IF;

  -- Validate chat session ownership
  IF p_chat_session_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.support_chat_sessions cs WHERE cs.id = p_chat_session_id AND cs.user_id = v_user_id
    ) THEN
      RAISE EXCEPTION 'chat session not found';
    END IF;
  END IF;

  -- Generate ticket number
  v_seq_val := nextval('public.support_ticket_number_seq');
  v_ticket_number := 'XR-' || v_seq_val::TEXT;

  -- Insert ticket
  INSERT INTO public.support_tickets (
    ticket_number, user_id, category, subject, description,
    related_deposit_id, related_sell_order_id, reference_hash, chat_session_id
  )
  VALUES (
    v_ticket_number, v_user_id, p_category, trim(p_subject), trim(p_description),
    p_related_deposit_id, p_related_sell_order_id,
    NULLIF(trim(p_reference_hash), ''),
    p_chat_session_id
  )
  RETURNING id INTO v_ticket_id;

  -- Notify admins
  PERFORM public.notify_admins(
    'new_support_ticket',
    '🎫 New Support Ticket',
    COALESCE(
      (SELECT username FROM public.profiles WHERE id = v_user_id),
      'A user'
    ) || ' created ticket ' || v_ticket_number || ': "' || left(p_subject, 60) || '"',
    jsonb_build_object(
      'ticket_id', v_ticket_id,
      'ticket_number', v_ticket_number,
      'user_id', v_user_id,
      'category', p_category
    ),
    v_ticket_id
  );

  RETURN jsonb_build_object(
    'ticket_id', v_ticket_id,
    'ticket_number', v_ticket_number
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_create_ticket(TEXT, TEXT, TEXT, UUID, UUID, TEXT, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_create_ticket(TEXT, TEXT, TEXT, UUID, UUID, TEXT, UUID) TO   authenticated;

-- 4B. List own tickets
CREATE OR REPLACE FUNCTION public.support_get_user_tickets(
  p_status  TEXT DEFAULT NULL,
  p_limit   INT DEFAULT 20,
  p_offset  INT DEFAULT 0
)
RETURNS TABLE (
  id              UUID,
  ticket_number   TEXT,
  category        TEXT,
  subject         TEXT,
  status          TEXT,
  priority        TEXT,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  unread_count    BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN QUERY
  SELECT
    t.id, t.ticket_number, t.category, t.subject, t.status, t.priority,
    t.created_at, t.updated_at, t.resolved_at, t.closed_at,
    (SELECT count(*) FROM public.support_ticket_messages m
       WHERE m.ticket_id = t.id
         AND m.sender_type = 'admin'
         AND (m.read_at IS NULL OR m.read_at < t.updated_at)
    ) AS unread_count
  FROM public.support_tickets t
  WHERE t.user_id = auth.uid()
    AND (p_status IS NULL OR t.status = p_status)
  ORDER BY t.updated_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_get_user_tickets(TEXT, INT, INT) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_get_user_tickets(TEXT, INT, INT) TO   authenticated;

-- 4C. Get own ticket detail
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

-- 4D. Reply to ticket
CREATE OR REPLACE FUNCTION public.support_reply_to_ticket(
  p_ticket_id UUID,
  p_body      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_ticket_status TEXT;
  v_ticket_user UUID;
  v_ticket_number TEXT;
  v_msg_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
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

  -- Get ticket, verify ownership and status
  SELECT status, user_id, ticket_number
  INTO v_ticket_status, v_ticket_user, v_ticket_number
  FROM public.support_tickets
  WHERE id = p_ticket_id;

  IF v_ticket_user IS NULL THEN
    RAISE EXCEPTION 'ticket not found';
  END IF;
  IF v_ticket_user != v_user_id THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF v_ticket_status NOT IN ('OPEN', 'WAITING_FOR_USER', 'WAITING_FOR_SUPPORT', 'IN_PROGRESS') THEN
    RAISE EXCEPTION 'ticket is not accepting replies (status: %)', v_ticket_status;
  END IF;

  -- Insert message
  INSERT INTO public.support_ticket_messages (ticket_id, sender_id, sender_type, body)
  VALUES (p_ticket_id, v_user_id, 'user', trim(p_body))
  RETURNING id INTO v_msg_id;

  -- Update ticket: status → WAITING_FOR_SUPPORT (if it was WAITING_FOR_USER or OPEN)
  IF v_ticket_status IN ('WAITING_FOR_USER', 'OPEN') THEN
    UPDATE public.support_tickets
    SET status = 'WAITING_FOR_SUPPORT', updated_at = now()
    WHERE id = p_ticket_id;
  END IF;

  -- Notify assigned agent or all admins
  DECLARE
    v_assigned UUID;
  BEGIN
    SELECT assigned_agent_id INTO v_assigned
    FROM public.support_tickets WHERE id = p_ticket_id;

    IF v_assigned IS NOT NULL THEN
      PERFORM public.create_notification(
        v_assigned,
        'ticket_user_replied',
        '🎫 User replied to ' || v_ticket_number,
        left(trim(p_body), 100),
        jsonb_build_object('ticket_id', p_ticket_id, 'ticket_number', v_ticket_number, 'user_id', v_user_id),
        p_ticket_id
      );
    ELSE
      PERFORM public.notify_admins(
        'ticket_user_replied',
        '🎫 User replied to ' || v_ticket_number,
        left(trim(p_body), 100),
        jsonb_build_object('ticket_id', p_ticket_id, 'ticket_number', v_ticket_number, 'user_id', v_user_id),
        p_ticket_id
      );
    END IF;
  END;

  RETURN jsonb_build_object('message_id', v_msg_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_reply_to_ticket(UUID, TEXT) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_reply_to_ticket(UUID, TEXT) TO   authenticated;

-- 4E. Mark ticket messages as read
CREATE OR REPLACE FUNCTION public.support_mark_ticket_read(
  p_ticket_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required';
  END IF;

  -- Verify ownership
  IF NOT EXISTS (
    SELECT 1 FROM public.support_tickets t
    WHERE t.id = p_ticket_id AND t.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- Mark all admin messages as read
  UPDATE public.support_ticket_messages
  SET read_at = now()
  WHERE ticket_id = p_ticket_id
    AND sender_type = 'admin'
    AND read_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_mark_ticket_read(UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_mark_ticket_read(UUID) TO   authenticated;

-- 4F. Reopen a resolved ticket
CREATE OR REPLACE FUNCTION public.support_reopen_ticket(
  p_ticket_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_ticket_status TEXT;
  v_ticket_user UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT status, user_id INTO v_ticket_status, v_ticket_user
  FROM public.support_tickets
  WHERE id = p_ticket_id;

  IF v_ticket_user IS NULL THEN
    RAISE EXCEPTION 'ticket not found';
  END IF;
  IF v_ticket_user != auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF v_ticket_status != 'RESOLVED' THEN
    RAISE EXCEPTION 'only resolved tickets can be reopened';
  END IF;

  UPDATE public.support_tickets
  SET status = 'WAITING_FOR_SUPPORT', resolved_at = NULL, updated_at = now()
  WHERE id = p_ticket_id;

  -- Notify assigned agent or admins
  PERFORM public.notify_admins(
    'ticket_reopened',
    '🎫 Ticket reopened',
    'Ticket has been reopened by the user',
    jsonb_build_object('ticket_id', p_ticket_id, 'user_id', auth.uid()),
    p_ticket_id
  );

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_reopen_ticket(UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_reopen_ticket(UUID) TO   authenticated;

-- 4G. Get user ticket summary counts (for Help & Support hub)
CREATE OR REPLACE FUNCTION public.support_get_user_ticket_summary()
RETURNS TABLE (
  open_count    BIGINT,
  waiting_count BIGINT,
  resolved_count BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT count(*) FROM public.support_tickets t
       WHERE t.user_id = auth.uid() AND t.status IN ('OPEN','IN_PROGRESS','WAITING_FOR_USER','WAITING_FOR_SUPPORT'))::BIGINT AS open_count,
    (SELECT count(*) FROM public.support_tickets t
       WHERE t.user_id = auth.uid() AND t.status = 'WAITING_FOR_USER')::BIGINT AS waiting_count,
    (SELECT count(*) FROM public.support_tickets t
       WHERE t.user_id = auth.uid() AND t.status = 'RESOLVED')::BIGINT AS resolved_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_get_user_ticket_summary() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_get_user_ticket_summary() TO   authenticated;

-- =============================================================================
-- PART 5 — ADMIN RPCs
-- =============================================================================

-- 5A. Admin: list tickets (with filters)
CREATE OR REPLACE FUNCTION public.support_admin_get_tickets(
  p_status       TEXT DEFAULT NULL,
  p_category     TEXT DEFAULT NULL,
  p_priority     TEXT DEFAULT NULL,
  p_assigned_to  UUID DEFAULT NULL,
  p_search       TEXT DEFAULT NULL,
  p_sort         TEXT DEFAULT 'newest',
  p_limit        INT DEFAULT 25,
  p_offset       INT DEFAULT 0
)
RETURNS TABLE (
  id              UUID,
  ticket_number   TEXT,
  user_id         UUID,
  username        TEXT,
  category        TEXT,
  subject         TEXT,
  status          TEXT,
  priority        TEXT,
  assigned_agent_id UUID,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ,
  message_count   BIGINT,
  last_message_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    t.id, t.ticket_number, t.user_id,
    (SELECT p.username FROM public.profiles p WHERE p.id = t.user_id),
    t.category, t.subject, t.status, t.priority, t.assigned_agent_id,
    t.created_at, t.updated_at,
    (SELECT count(*) FROM public.support_ticket_messages m WHERE m.ticket_id = t.id) AS message_count,
    (SELECT max(m2.created_at) FROM public.support_ticket_messages m2 WHERE m2.ticket_id = t.id) AS last_message_at
  FROM public.support_tickets t
  WHERE (p_status IS NULL OR t.status = p_status)
    AND (p_category IS NULL OR t.category = p_category)
    AND (p_priority IS NULL OR t.priority = p_priority)
    AND (p_assigned_to IS NULL OR t.assigned_agent_id = p_assigned_to)
    AND (p_search IS NULL
         OR t.ticket_number ILIKE '%' || p_search || '%'
         OR t.subject ILIKE '%' || p_search || '%'
         OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = t.user_id AND p.username ILIKE '%' || p_search || '%'))
  ORDER BY
    CASE WHEN p_sort = 'oldest' THEN t.created_at END ASC,
    CASE WHEN p_sort = 'priority' THEN
      CASE t.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 WHEN 'LOW' THEN 4 END
    END ASC,
    CASE WHEN p_sort = 'updated' THEN t.updated_at END DESC,
    CASE WHEN p_sort = 'newest' OR p_sort IS NULL THEN t.created_at END DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_get_tickets(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, INT, INT) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_admin_get_tickets(TEXT, TEXT, TEXT, UUID, TEXT, TEXT, INT, INT) TO   authenticated;

-- 5B. Admin: get ticket detail (includes messages + internal notes)
CREATE OR REPLACE FUNCTION public.support_admin_get_ticket(
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
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF p_ticket_id IS NULL THEN
    RAISE EXCEPTION 'ticket_id is required';
  END IF;

  SELECT jsonb_build_object(
    'id', t.id,
    'ticket_number', t.ticket_number,
    'user_id', t.user_id,
    'username', (SELECT p.username FROM public.profiles p WHERE p.id = t.user_id),
    'user_email', (SELECT p.email FROM public.profiles p WHERE p.id = t.user_id),
    'category', t.category,
    'subject', t.subject,
    'description', t.description,
    'status', t.status,
    'priority', t.priority,
    'assigned_agent_id', t.assigned_agent_id,
    'assigned_agent_name', (SELECT p.username FROM public.profiles p WHERE p.id = t.assigned_agent_id),
    'created_at', t.created_at,
    'updated_at', t.updated_at,
    'resolved_at', t.resolved_at,
    'closed_at', t.closed_at,
    'related_deposit_id', t.related_deposit_id,
    'related_sell_order_id', t.related_sell_order_id,
    'reference_hash', t.reference_hash,
    'chat_session_id', t.chat_session_id,
    'messages', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', m.id,
        'sender_id', m.sender_id,
        'sender_type', m.sender_type,
        'sender_name', (SELECT p.username FROM public.profiles p WHERE p.id = m.sender_id),
        'body', m.body,
        'created_at', m.created_at,
        'read_at', m.read_at
      ) ORDER BY m.created_at ASC)
      FROM public.support_ticket_messages m
      WHERE m.ticket_id = t.id
    ), '[]'::jsonb),
    'internal_notes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', n.id,
        'admin_id', n.admin_id,
        'admin_name', (SELECT p.username FROM public.profiles p WHERE p.id = n.admin_id),
        'note', n.note,
        'created_at', n.created_at
      ) ORDER BY n.created_at ASC)
      FROM public.support_ticket_internal_notes n
      WHERE n.ticket_id = t.id
    ), '[]'::jsonb)
  )
  INTO v_ticket
  FROM public.support_tickets t
  WHERE t.id = p_ticket_id;

  RETURN v_ticket;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_get_ticket(UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_admin_get_ticket(UUID) TO   authenticated;

-- 5C. Admin: assign/reassign ticket
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

  IF p_agent_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_agent_id) THEN
      RAISE EXCEPTION 'agent not found';
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

-- 5D. Admin: reply to ticket
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

-- 5E. Admin: add internal note
CREATE OR REPLACE FUNCTION public.support_admin_add_note(
  p_ticket_id UUID,
  p_note      TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_admin_id UUID := auth.uid();
  v_note_id UUID;
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
  IF p_note IS NULL OR char_length(trim(p_note)) = 0 THEN
    RAISE EXCEPTION 'note is required';
  END IF;
  IF char_length(p_note) > 4000 THEN
    RAISE EXCEPTION 'note is too long';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.support_tickets WHERE id = p_ticket_id) THEN
    RAISE EXCEPTION 'ticket not found';
  END IF;

  INSERT INTO public.support_ticket_internal_notes (ticket_id, admin_id, note)
  VALUES (p_ticket_id, v_admin_id, trim(p_note))
  RETURNING id INTO v_note_id;

  RETURN jsonb_build_object('note_id', v_note_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_add_note(UUID, TEXT) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_admin_add_note(UUID, TEXT) TO   authenticated;

-- 5F. Admin: change ticket status
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

-- 5G. Admin: change ticket priority
CREATE OR REPLACE FUNCTION public.support_admin_update_ticket_priority(
  p_ticket_id UUID,
  p_priority  TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
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
  IF p_priority NOT IN ('LOW','NORMAL','HIGH','URGENT') THEN
    RAISE EXCEPTION 'invalid priority';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.support_tickets WHERE id = p_ticket_id) THEN
    RAISE EXCEPTION 'ticket not found';
  END IF;

  UPDATE public.support_tickets
  SET priority = p_priority, updated_at = now()
  WHERE id = p_ticket_id;

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_update_ticket_priority(UUID, TEXT) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_admin_update_ticket_priority(UUID, TEXT) TO   authenticated;

-- 5H. Admin: ticket dashboard stats
CREATE OR REPLACE FUNCTION public.support_admin_get_ticket_stats()
RETURNS TABLE (
  open_count           BIGINT,
  in_progress_count    BIGINT,
  waiting_for_user     BIGINT,
  waiting_for_support  BIGINT,
  resolved_count       BIGINT,
  closed_count         BIGINT,
  unassigned_count     BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT count(*) FROM public.support_tickets WHERE status = 'OPEN')::BIGINT,
    (SELECT count(*) FROM public.support_tickets WHERE status = 'IN_PROGRESS')::BIGINT,
    (SELECT count(*) FROM public.support_tickets WHERE status = 'WAITING_FOR_USER')::BIGINT,
    (SELECT count(*) FROM public.support_tickets WHERE status = 'WAITING_FOR_SUPPORT')::BIGINT,
    (SELECT count(*) FROM public.support_tickets WHERE status = 'RESOLVED')::BIGINT,
    (SELECT count(*) FROM public.support_tickets WHERE status = 'CLOSED')::BIGINT,
    (SELECT count(*) FROM public.support_tickets
       WHERE status NOT IN ('CLOSED','RESOLVED') AND assigned_agent_id IS NULL)::BIGINT;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_get_ticket_stats() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_admin_get_ticket_stats() TO   authenticated;

-- 5I. Admin: mark ticket messages as read
CREATE OR REPLACE FUNCTION public.support_admin_mark_ticket_read(
  p_ticket_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count INT;
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

  UPDATE public.support_ticket_messages
  SET read_at = now()
  WHERE ticket_id = p_ticket_id
    AND sender_type = 'user'
    AND read_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_mark_ticket_read(UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.support_admin_mark_ticket_read(UUID) TO   authenticated;

-- =============================================================================
-- PART 6 — Updated at trigger
-- =============================================================================

DROP TRIGGER IF EXISTS trg_support_ticket_updated ON public.support_tickets;

CREATE TRIGGER trg_support_ticket_updated
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- MIGRATION 024 COMPLETE
-- =============================================================================
