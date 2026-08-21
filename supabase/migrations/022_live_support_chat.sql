-- =============================================================================
-- XReserve Migration 022 — Live Support Chat (Phase 1)
-- =============================================================================
--
-- Internal real-time support chat between users and admin agents.
--
-- Tables:
--   support_agent_status    — agent availability (AVAILABLE/BUSY/OFFLINE)
--   support_chat_sessions   — chat sessions (WAITING/ACTIVE/ENDED/ABANDONED)
--   support_chat_messages   — individual messages within sessions
--
-- Security:
--   RLS enforced; users see only their own sessions/messages.
--   All write operations go through SECURITY DEFINER RPCs.
--   Existing admin_users authorization reused (is_admin_user()).
--
-- Realtime:
--   support_chat_messages added to supabase_realtime publication
--   for live message delivery to subscribed clients.
-- =============================================================================

-- =============================================================================
-- PART 1 — Tables
-- =============================================================================

-- 1A. Agent availability status
CREATE TABLE IF NOT EXISTS public.support_agent_status (
  agent_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'OFFLINE'
                CHECK (status IN ('AVAILABLE','BUSY','OFFLINE')),
  max_chats   INT NOT NULL DEFAULT 3
                CHECK (max_chats > 0 AND max_chats <= 10),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1B. Chat sessions
CREATE TABLE IF NOT EXISTS public.support_chat_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id          UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  status            TEXT        NOT NULL DEFAULT 'WAITING'
                      CHECK (status IN ('WAITING','ACTIVE','ENDED','ABANDONED')),
  queue_position    INT,
  connected_at      TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_unread_count   INT NOT NULL DEFAULT 0,
  admin_unread_count  INT NOT NULL DEFAULT 0,
  last_user_read_at   TIMESTAMPTZ,
  last_admin_read_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id
  ON public.support_chat_sessions (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent_id
  ON public.support_chat_sessions (agent_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_chat_sessions_waiting
  ON public.support_chat_sessions (created_at ASC)
  WHERE status = 'WAITING';

CREATE INDEX IF NOT EXISTS idx_chat_sessions_status
  ON public.support_chat_sessions (status);

-- 1C. Chat messages
CREATE TABLE IF NOT EXISTS public.support_chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID        NOT NULL REFERENCES public.support_chat_sessions(id) ON DELETE CASCADE,
  sender_id   UUID        NOT NULL REFERENCES auth.users(id),
  sender_type TEXT        NOT NULL CHECK (sender_type IN ('user','admin')),
  body        TEXT        NOT NULL CHECK (char_length(body) > 0 AND char_length(body) <= 4000),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id
  ON public.support_chat_messages (session_id, created_at ASC);

-- =============================================================================
-- PART 2 — RLS Policies
-- =============================================================================

-- 2A. support_agent_status
ALTER TABLE public.support_agent_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY agent_status_select_own
  ON public.support_agent_status FOR SELECT
  TO authenticated
  USING (agent_id = auth.uid());

-- Inserts/updates go through SECURITY DEFINER RPCs only
REVOKE INSERT, UPDATE, DELETE ON public.support_agent_status FROM anon, authenticated, public;
GRANT SELECT ON public.support_agent_status TO authenticated;

-- 2B. support_chat_sessions
ALTER TABLE public.support_chat_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_sessions_select_own
  ON public.support_chat_sessions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR agent_id = auth.uid());

-- All writes through RPCs
REVOKE INSERT, UPDATE, DELETE ON public.support_chat_sessions FROM anon, authenticated, public;
GRANT SELECT ON public.support_chat_sessions TO authenticated;

-- 2C. support_chat_messages
ALTER TABLE public.support_chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_messages_select_participant
  ON public.support_chat_messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.support_chat_sessions s
      WHERE s.id = session_id
        AND (s.user_id = auth.uid() OR s.agent_id = auth.uid())
    )
  );

-- All inserts through RPC
REVOKE INSERT, UPDATE, DELETE ON public.support_chat_messages FROM anon, authenticated, public;
-- Allow UPDATE on read_at for marking messages read (used by mark_chat_read RPC)
GRANT SELECT ON public.support_chat_messages TO authenticated;

-- =============================================================================
-- PART 3 — Realtime Publication
-- =============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE public.support_chat_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_chat_sessions;

-- =============================================================================
-- PART 4 — RPC Functions
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 4A. set_agent_status — Admin sets their own availability
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_set_agent_status(
  p_status TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('AVAILABLE','BUSY','OFFLINE') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  INSERT INTO public.support_agent_status (agent_id, status, updated_at)
  VALUES (auth.uid(), p_status, now())
  ON CONFLICT (agent_id) DO UPDATE
    SET status = EXCLUDED.status, updated_at = now();
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_set_agent_status(TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_set_agent_status(TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4B. get_chat_availability — Public: agent count + wait estimate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_get_chat_availability()
RETURNS TABLE (
  available_agents INT,
  queue_size       INT,
  estimated_wait_seconds INT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_available INT;
  v_queue     INT;
  v_avg_dur   INTERVAL;
  v_wait      INT;
BEGIN
  -- Count AVAILABLE agents who haven't hit their max chat limit
  SELECT COUNT(*) INTO v_available
  FROM public.support_agent_status sas
  WHERE sas.status = 'AVAILABLE'
    AND (
      SELECT COUNT(*) FROM public.support_chat_sessions s
      WHERE s.agent_id = sas.agent_id AND s.status = 'ACTIVE'
    ) < sas.max_chats;

  -- Count WAITING sessions
  SELECT COUNT(*) INTO v_queue
  FROM public.support_chat_sessions
  WHERE status = 'WAITING';

  -- Average chat duration from last 24h completed chats
  SELECT AVG(s.ended_at - s.connected_at) INTO v_avg_dur
  FROM public.support_chat_sessions s
  WHERE s.status = 'ENDED'
    AND s.ended_at IS NOT NULL
    AND s.connected_at IS NOT NULL
    AND s.ended_at > now() - INTERVAL '24 hours';

  -- Calculate wait estimate
  IF v_available = 0 AND v_queue = 0 THEN
    v_wait := 0;
  ELSIF v_available = 0 THEN
    -- No agents: rough estimate based on avg handling time
    IF v_avg_dur IS NOT NULL THEN
      v_wait := EXTRACT(EPOCH FROM v_avg_dur) * LEAST(v_queue, 10);
    ELSE
      v_wait := 300 * v_queue; -- fallback: 5 min per queued user
    END IF;
  ELSIF v_queue = 0 THEN
    v_wait := 0;
  ELSE
    -- Agents available: estimate based on queue / capacity
    IF v_avg_dur IS NOT NULL THEN
      v_wait := CEIL(EXTRACT(EPOCH FROM v_avg_dur) * v_queue::NUMERIC / v_available);
    ELSE
      v_wait := 120 * CEIL(v_queue::NUMERIC / v_available); -- fallback: 2 min per slot
    END IF;
  END IF;

  available_agents := v_available;
  queue_size := v_queue;
  estimated_wait_seconds := GREATEST(v_wait, 0);
END;
$$;

-- Public: any authenticated user can check availability
REVOKE EXECUTE ON FUNCTION public.support_get_chat_availability() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_get_chat_availability() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4C. start_live_chat — User starts or resumes a chat
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_start_live_chat()
RETURNS TABLE (
  session_id     UUID,
  status         TEXT,
  agent_assigned BOOLEAN,
  queue_position INT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_session_id UUID;
  v_agent_id   UUID;
  v_status     TEXT;
  v_position   INT;
BEGIN
  -- Check for existing ACTIVE session → return it
  SELECT s.id, s.status INTO v_session_id, v_status
  FROM public.support_chat_sessions s
  WHERE s.user_id = auth.uid() AND s.status = 'ACTIVE'
  LIMIT 1;

  IF v_session_id IS NOT NULL THEN
    session_id := v_session_id;
    status := v_status;
    agent_assigned := TRUE;
    queue_position := NULL;
    RETURN;
  END IF;

  -- Check for existing WAITING session → return it
  SELECT s.id, s.status INTO v_session_id, v_status
  FROM public.support_chat_sessions s
  WHERE s.user_id = auth.uid() AND s.status = 'WAITING'
  LIMIT 1;

  IF v_session_id IS NOT NULL THEN
    -- Still try auto-assign
    SELECT sas.agent_id INTO v_agent_id
    FROM public.support_agent_status sas
    WHERE sas.status = 'AVAILABLE'
      AND (
        SELECT COUNT(*) FROM public.support_chat_sessions cs
        WHERE cs.agent_id = sas.agent_id AND cs.status = 'ACTIVE'
      ) < sas.max_chats
    ORDER BY sas.updated_at ASC
    LIMIT 1;

    IF v_agent_id IS NOT NULL THEN
      UPDATE public.support_chat_sessions
      SET agent_id = v_agent_id,
          status = 'ACTIVE',
          connected_at = now(),
          queue_position = NULL,
          updated_at = now()
      WHERE id = v_session_id;

      UPDATE public.support_agent_status
      SET updated_at = now()
      WHERE agent_id = v_agent_id;

      session_id := v_session_id;
      status := 'ACTIVE';
      agent_assigned := TRUE;
      queue_position := NULL;
    ELSE
      -- Calculate queue position
      SELECT COUNT(*) + 1 INTO v_position
      FROM public.support_chat_sessions
      WHERE status = 'WAITING'
        AND created_at < (SELECT created_at FROM public.support_chat_sessions WHERE id = v_session_id);

      session_id := v_session_id;
      status := 'WAITING';
      agent_assigned := FALSE;
      queue_position := v_position;
    END IF;
    RETURN;
  END IF;

  -- No existing session — try to find available agent
  SELECT sas.agent_id INTO v_agent_id
  FROM public.support_agent_status sas
  WHERE sas.status = 'AVAILABLE'
    AND (
      SELECT COUNT(*) FROM public.support_chat_sessions cs
      WHERE cs.agent_id = sas.agent_id AND cs.status = 'ACTIVE'
    ) < sas.max_chats
  ORDER BY sas.updated_at ASC
  LIMIT 1;

  IF v_agent_id IS NOT NULL THEN
    -- Immediate assignment
    INSERT INTO public.support_chat_sessions
      (user_id, agent_id, status, connected_at, last_user_read_at, last_admin_read_at)
    VALUES (auth.uid(), v_agent_id, 'ACTIVE', now(), now(), now())
    RETURNING id INTO v_session_id;

    session_id := v_session_id;
    status := 'ACTIVE';
    agent_assigned := TRUE;
    queue_position := NULL;
  ELSE
    -- No agent available → queue
    INSERT INTO public.support_chat_sessions
      (user_id, status, last_user_read_at)
    VALUES (auth.uid(), 'WAITING', now())
    RETURNING id INTO v_session_id;

    SELECT COUNT(*) INTO v_position
    FROM public.support_chat_sessions
    WHERE status = 'WAITING'
      AND id <= v_session_id;

    session_id := v_session_id;
    status := 'WAITING';
    agent_assigned := FALSE;
    queue_position := v_position;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_start_live_chat() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_start_live_chat() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4D. get_user_queue_position
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_get_user_queue_position(
  p_session_id UUID
)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_pos INT;
  v_uid UUID;
BEGIN
  SELECT user_id INTO v_uid
  FROM public.support_chat_sessions
  WHERE id = p_session_id;

  IF v_uid IS NULL OR v_uid != auth.uid() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COUNT(*) + 1 INTO v_pos
  FROM public.support_chat_sessions
  WHERE status = 'WAITING'
    AND created_at < (SELECT created_at FROM public.support_chat_sessions WHERE id = p_session_id);

  RETURN v_pos;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_get_user_queue_position(UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_get_user_queue_position(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4E. accept_chat — Admin accepts a waiting chat (FIFO)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_accept_chat()
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_session_id UUID;
  v_agent_id UUID;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  v_agent_id := auth.uid();

  -- Find oldest WAITING session (FIFO)
  SELECT s.id INTO v_session_id
  FROM public.support_chat_sessions s
  WHERE s.status = 'WAITING'
  ORDER BY s.created_at ASC
  LIMIT 1;

  IF v_session_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.support_chat_sessions
  SET agent_id = v_agent_id,
      status = 'ACTIVE',
      connected_at = now(),
      queue_position = NULL,
      last_admin_read_at = now(),
      updated_at = now()
  WHERE id = v_session_id;

  -- Notify the user
  PERFORM public.create_notification(
    (SELECT user_id FROM public.support_chat_sessions WHERE id = v_session_id),
    'chat_assigned',
    'Support Connected',
    'A support agent has joined your chat.',
    '{}'::jsonb,
    v_session_id
  );

  RETURN v_session_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_accept_chat() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_accept_chat() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4F. end_chat — User or admin ends a chat session
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_end_chat(
  p_session_id UUID
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid UUID;
  v_agent UUID;
  v_user UUID;
BEGIN
  SELECT user_id, agent_id INTO v_user, v_agent
  FROM public.support_chat_sessions
  WHERE id = p_session_id;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Chat session not found';
  END IF;

  -- Authorization: must be the user or an admin
  IF auth.uid() != v_user AND NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE public.support_chat_sessions
  SET status = 'ENDED',
      ended_at = now(),
      updated_at = now()
  WHERE id = p_session_id AND status = 'ACTIVE';

  -- Notify the other party
  IF auth.uid() = v_user AND v_agent IS NOT NULL THEN
    -- User ended → notify admin (via admin notification)
    PERFORM public.create_notification(
      v_agent,
      'chat_ended',
      'Chat Ended',
      'The user has ended the chat session.',
      '{}'::jsonb,
      p_session_id
    );
  ELSIF auth.uid() != v_user THEN
    -- Admin ended → notify user
    PERFORM public.create_notification(
      v_user,
      'chat_ended',
      'Chat Ended',
      'The support agent has ended the chat session.',
      '{}'::jsonb,
      p_session_id
    );
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_end_chat(UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_end_chat(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4G. send_chat_message — Send a message in an active chat
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_send_chat_message(
  p_session_id UUID,
  p_body       TEXT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_msg_id     UUID;
  v_user_id    UUID;
  v_agent_id   UUID;
  v_status     TEXT;
  v_sender_type TEXT;
BEGIN
  SELECT user_id, agent_id, status
  INTO v_user_id, v_agent_id, v_status
  FROM public.support_chat_sessions
  WHERE id = p_session_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Chat session not found';
  END IF;

  IF v_status != 'ACTIVE' THEN
    RAISE EXCEPTION 'Chat is not active';
  END IF;

  -- Must be a participant
  IF auth.uid() != v_user_id AND auth.uid() != v_agent_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Determine sender type
  IF auth.uid() = v_user_id THEN
    v_sender_type := 'user';
  ELSE
    v_sender_type := 'admin';
  END IF;

  INSERT INTO public.support_chat_messages (session_id, sender_id, sender_type, body)
  VALUES (p_session_id, auth.uid(), v_sender_type, p_body)
  RETURNING id INTO v_msg_id;

  -- Update unread counts
  IF v_sender_type = 'user' THEN
    UPDATE public.support_chat_sessions
    SET admin_unread_count = admin_unread_count + 1,
        updated_at = now()
    WHERE id = p_session_id;
  ELSE
    UPDATE public.support_chat_sessions
    SET user_unread_count = user_unread_count + 1,
        updated_at = now()
    WHERE id = p_session_id;
  END IF;

  -- Notify the other party
  IF v_sender_type = 'user' AND v_agent_id IS NOT NULL THEN
    PERFORM public.create_notification(
      v_agent_id,
      'chat_message',
      'New Chat Message',
      'You have a new message in your support chat.',
      jsonb_build_object('session_id', p_session_id),
      p_session_id
    );
  ELSIF v_sender_type = 'admin' THEN
    PERFORM public.create_notification(
      v_user_id,
      'chat_message',
      'Support Reply',
      'A support agent has replied to your chat.',
      jsonb_build_object('session_id', p_session_id),
      p_session_id
    );
  END IF;

  RETURN v_msg_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_send_chat_message(UUID, TEXT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_send_chat_message(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4H. mark_chat_read — Mark all messages in a chat as read
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_mark_chat_read(
  p_session_id UUID
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_agent_id UUID;
BEGIN
  SELECT user_id, agent_id INTO v_user_id, v_agent_id
  FROM public.support_chat_sessions
  WHERE id = p_session_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Chat session not found';
  END IF;

  -- Must be a participant
  IF auth.uid() != v_user_id AND auth.uid() != v_agent_id THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF auth.uid() = v_user_id THEN
    UPDATE public.support_chat_sessions
    SET user_unread_count = 0,
        last_user_read_at = now(),
        updated_at = now()
    WHERE id = p_session_id;
  ELSE
    UPDATE public.support_chat_sessions
    SET admin_unread_count = 0,
        last_admin_read_at = now(),
        updated_at = now()
    WHERE id = p_session_id;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_mark_chat_read(UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_mark_chat_read(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4I. get_chat_history — Get messages for a chat session
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_get_chat_history(
  p_session_id UUID,
  p_limit  INT DEFAULT 50,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  id          UUID,
  session_id  UUID,
  sender_id   UUID,
  sender_type TEXT,
  body        TEXT,
  created_at  TIMESTAMPTZ,
  read_at     TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_agent_id UUID;
BEGIN
  SELECT user_id, agent_id INTO v_user_id, v_agent_id
  FROM public.support_chat_sessions
  WHERE id = p_session_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Chat session not found';
  END IF;

  IF auth.uid() != v_user_id AND auth.uid() != v_agent_id AND NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT m.id, m.session_id, m.sender_id, m.sender_type, m.body, m.created_at, m.read_at
  FROM public.support_chat_messages m
  WHERE m.session_id = p_session_id
  ORDER BY m.created_at ASC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_get_chat_history(UUID, INT, INT) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_get_chat_history(UUID, INT, INT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4J. get_user_active_chat — Get user's current active/waiting chat
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_get_user_active_chat()
RETURNS TABLE (
  session_id     UUID,
  status         TEXT,
  agent_id       UUID,
  created_at     TIMESTAMPTZ,
  connected_at   TIMESTAMPTZ,
  unread_count   INT,
  queue_position INT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.status, s.agent_id, s.created_at, s.connected_at,
         s.user_unread_count,
         CASE WHEN s.status = 'WAITING' THEN (
           SELECT COUNT(*) + 1 FROM public.support_chat_sessions s2
           WHERE s2.status = 'WAITING' AND s2.created_at < s.created_at
         ) ELSE NULL END
  FROM public.support_chat_sessions s
  WHERE s.user_id = auth.uid()
    AND s.status IN ('WAITING', 'ACTIVE')
  ORDER BY s.created_at DESC
  LIMIT 1;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_get_user_active_chat() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_get_user_active_chat() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4K. get_user_chat_history — List user's ended chat sessions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_get_user_chat_history()
RETURNS TABLE (
  session_id   UUID,
  status       TEXT,
  agent_id     UUID,
  created_at   TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  ended_at     TIMESTAMPTZ,
  message_count BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT s.id, s.status, s.agent_id, s.created_at, s.connected_at, s.ended_at,
         (SELECT COUNT(*) FROM public.support_chat_messages m WHERE m.session_id = s.id)
  FROM public.support_chat_sessions s
  WHERE s.user_id = auth.uid()
  ORDER BY s.created_at DESC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_get_user_chat_history() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_get_user_chat_history() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4L. admin_get_waiting_chats — Admin: list all WAITING sessions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_admin_get_waiting_chats()
RETURNS TABLE (
  session_id   UUID,
  user_id      UUID,
  username     TEXT,
  created_at   TIMESTAMPTZ,
  wait_seconds INT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT s.id, s.user_id,
         COALESCE(p.full_name, au.email),
         s.created_at,
         EXTRACT(EPOCH FROM (now() - s.created_at))::INT
  FROM public.support_chat_sessions s
  JOIN public.profiles p ON p.id = s.user_id
  JOIN auth.users au ON au.id = s.user_id
  WHERE s.status = 'WAITING'
  ORDER BY s.created_at ASC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_get_waiting_chats() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_admin_get_waiting_chats() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4M. admin_get_active_chats — Admin: list all ACTIVE sessions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_admin_get_active_chats()
RETURNS TABLE (
  session_id   UUID,
  user_id      UUID,
  username     TEXT,
  agent_id     UUID,
  connected_at TIMESTAMPTZ,
  unread_count INT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  RETURN QUERY
  SELECT s.id, s.user_id,
         COALESCE(p.full_name, au.email),
         s.agent_id,
         s.connected_at,
         s.admin_unread_count
  FROM public.support_chat_sessions s
  JOIN public.profiles p ON p.id = s.user_id
  JOIN auth.users au ON au.id = s.user_id
  WHERE s.status = 'ACTIVE'
  ORDER BY s.connected_at ASC;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_get_active_chats() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_admin_get_active_chats() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4N. admin_get_chat_stats — Admin: dashboard counts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_admin_get_chat_stats()
RETURNS TABLE (
  active_count   INT,
  waiting_count  INT,
  available_agents INT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT COUNT(*) INTO active_count
  FROM public.support_chat_sessions WHERE status = 'ACTIVE';

  SELECT COUNT(*) INTO waiting_count
  FROM public.support_chat_sessions WHERE status = 'WAITING';

  SELECT COUNT(*) INTO available_agents
  FROM public.support_agent_status WHERE status = 'AVAILABLE';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_get_chat_stats() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_admin_get_chat_stats() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4O. get_agent_status — Admin checks their own status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_get_agent_status()
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT status INTO v_status
  FROM public.support_agent_status
  WHERE agent_id = auth.uid();

  RETURN COALESCE(v_status, 'OFFLINE');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_get_agent_status() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_get_agent_status() TO authenticated;

-- ---------------------------------------------------------------------------
-- 4P. updated_at trigger for chat sessions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._support_chat_updated_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_support_chat_updated
  BEFORE UPDATE ON public.support_chat_sessions
  FOR EACH ROW EXECUTE FUNCTION public._support_chat_updated_trigger();

-- =============================================================================
-- PART 5 — Notification event types (documentation)
-- =============================================================================
-- New notification event types used by this migration:
--   chat_assigned  — agent accepted the chat (→ user)
--   chat_message   — new message in active chat (→ user or admin)
--   chat_ended     — chat was ended (→ user or admin)
-- These flow through the existing create_notification / notify_admins system.
