-- 031 — Fix two confirmed Live Chat RPC bugs
--
-- Bug A: support_get_chat_history() — "column reference id is ambiguous" (42702)
--   The RETURNS TABLE output column `id` shadows support_chat_sessions.id
--   in the unqualified WHERE clause. Fix: qualify with table name.
--
-- Bug B: support_get_user_active_chat() — "structure of query does not match
--   function result type" (42804). COUNT(*) + 1 returns bigint but
--   queue_position is declared integer. Fix: cast to integer.

-- ---------------------------------------------------------------------------
-- Bug A: qualify ambiguous `id` in support_get_chat_history()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_get_chat_history(
  p_session_id UUID,
  p_limit      INT DEFAULT 50,
  p_offset     INT DEFAULT 0
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
  v_user_id  UUID;
  v_agent_id UUID;
BEGIN
  SELECT user_id, agent_id INTO v_user_id, v_agent_id
  FROM public.support_chat_sessions
  WHERE public.support_chat_sessions.id = p_session_id;

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

-- ---------------------------------------------------------------------------
-- Bug B: cast queue_position to integer in support_get_user_active_chat()
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
           SELECT (COUNT(*) + 1)::integer FROM public.support_chat_sessions s2
           WHERE s2.status = 'WAITING' AND s2.created_at < s.created_at
         ) ELSE NULL END
  FROM public.support_chat_sessions s
  WHERE s.user_id = auth.uid()
    AND s.status IN ('WAITING', 'ACTIVE')
  ORDER BY s.created_at DESC
  LIMIT 1;
END;
$$;
