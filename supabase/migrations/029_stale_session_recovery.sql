-- =============================================================================
-- XReserve Migration 029 — Stale Session Recovery
-- =============================================================================
--
-- ROOT CAUSE (proven against live DB 2026-08-21):
--   A live chat session that becomes ACTIVE stays ACTIVE forever unless
--   someone explicitly clicks "End Chat". If both parties close their
--   browsers, the session is orphaned indefinitely:
--     - The user cannot start a new chat (support_start_live_chat finds the
--       old ACTIVE session and returns it).
--     - The admin sees the stale session in the Active Chats list but
--       loading its history may fail or show stale data.
--     - The floating chat icon remains visible.
--     - Agent capacity is consumed (max_chats check counts the orphan).
--
--   Evidence: session 3fc6f431 was ACTIVE for 40+ minutes with no activity,
--   blocking both user and admin while consuming an agent slot.
--
-- FIX:
--   1. Internal helper _purge_stale_chat_sessions() hard-deletes sessions
--      with status ACTIVE/WAITING whose updated_at is older than 15 minutes
--      (no messages, no mark-read, no status change for 15 min = abandoned).
--   2. support_start_live_chat() checks if an existing ACTIVE/WAITING session
--      is stale before returning it. If stale, it purges it and proceeds to
--      create a fresh session.
--   3. Admin list/stats RPCs call the purge helper before querying, so the
--      dashboard never shows stale sessions.
--
-- SAFETY:
--   - 15-minute threshold is conservative (heartbeat is 60s, typical pauses
--     are seconds, not minutes).
--   - updated_at is set by the trg_support_chat_updated trigger on every
--     message send and mark-read, so it reliably reflects real activity.
--   - Purge uses the same hard-delete approach as migration 028 (messages
--     cascade, tickets SET NULL, notifications have no FK).
--   - No schema changes, no RLS changes, no new tables.
-- =============================================================================

-- =============================================================================
-- PART 1 — Internal purge helper
-- =============================================================================

CREATE OR REPLACE FUNCTION public._purge_stale_chat_sessions()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Delete messages belonging to stale sessions first (belt-and-suspenders;
  -- the FK cascade would handle this, but explicit is clearer).
  DELETE FROM public.support_chat_messages
  WHERE session_id IN (
    SELECT id FROM public.support_chat_sessions
    WHERE status IN ('ACTIVE', 'WAITING')
      AND updated_at < now() - INTERVAL '15 minutes'
  );

  -- Delete the stale sessions themselves.
  DELETE FROM public.support_chat_sessions
  WHERE status IN ('ACTIVE', 'WAITING')
    AND updated_at < now() - INTERVAL '15 minutes';
END;
$$;

-- =============================================================================
-- PART 2 — support_start_live_chat: detect and purge stale sessions
-- =============================================================================

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
  v_session_id  UUID;
  v_agent_id    UUID;
  v_status      TEXT;
  v_position    INT;
  v_updated_at  TIMESTAMPTZ;
BEGIN
  -- Check for existing ACTIVE session → return it (if not stale)
  SELECT s.id, s.status, s.updated_at
  INTO v_session_id, v_status, v_updated_at
  FROM public.support_chat_sessions s
  WHERE s.user_id = auth.uid() AND s.status = 'ACTIVE'
  LIMIT 1;

  IF v_session_id IS NOT NULL THEN
    IF v_updated_at < now() - INTERVAL '15 minutes' THEN
      -- Stale session — purge it and fall through to create a new one
      DELETE FROM public.support_chat_messages WHERE session_id = v_session_id;
      DELETE FROM public.support_chat_sessions WHERE id = v_session_id;
      v_session_id := NULL;
    ELSE
      -- Valid session — return it
      session_id := v_session_id;
      status := v_status;
      agent_assigned := TRUE;
      queue_position := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- Check for existing WAITING session → return it (if not stale)
  SELECT s.id, s.status, s.updated_at
  INTO v_session_id, v_status, v_updated_at
  FROM public.support_chat_sessions s
  WHERE s.user_id = auth.uid() AND s.status = 'WAITING'
  LIMIT 1;

  IF v_session_id IS NOT NULL THEN
    IF v_updated_at < now() - INTERVAL '15 minutes' THEN
      -- Stale WAITING session — purge and fall through
      DELETE FROM public.support_chat_messages WHERE session_id = v_session_id;
      DELETE FROM public.support_chat_sessions WHERE id = v_session_id;
      v_session_id := NULL;
    ELSE
      -- Still try auto-assign (only fresh-heartbeat agents)
      SELECT sas.agent_id INTO v_agent_id
      FROM public.support_agent_status sas
      WHERE sas.status = 'AVAILABLE'
        AND sas.last_heartbeat_at > now() - INTERVAL '3 minutes'
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
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- No existing session (or stale one was purged) — try to find available agent
  SELECT sas.agent_id INTO v_agent_id
  FROM public.support_agent_status sas
  WHERE sas.status = 'AVAILABLE'
    AND sas.last_heartbeat_at > now() - INTERVAL '3 minutes'
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
  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_start_live_chat() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_start_live_chat() TO authenticated;

-- =============================================================================
-- PART 3 — Admin RPCs: purge stale sessions before querying
-- =============================================================================

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

  -- Purge stale sessions before returning the list
  PERFORM public._purge_stale_chat_sessions();

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

  -- Purge stale sessions before returning the list
  PERFORM public._purge_stale_chat_sessions();

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

CREATE OR REPLACE FUNCTION public.support_admin_get_chat_stats()
RETURNS TABLE (
  active_count     INT,
  waiting_count    INT,
  available_agents INT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Purge stale sessions before counting
  PERFORM public._purge_stale_chat_sessions();

  SELECT COUNT(*) INTO active_count
  FROM public.support_chat_sessions WHERE status = 'ACTIVE';

  SELECT COUNT(*) INTO waiting_count
  FROM public.support_chat_sessions WHERE status = 'WAITING';

  -- Only count agents with fresh heartbeat
  SELECT COUNT(*) INTO available_agents
  FROM public.support_agent_status
  WHERE status = 'AVAILABLE'
    AND last_heartbeat_at > now() - INTERVAL '3 minutes';
  RETURN NEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_admin_get_chat_stats() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_admin_get_chat_stats() TO authenticated;
