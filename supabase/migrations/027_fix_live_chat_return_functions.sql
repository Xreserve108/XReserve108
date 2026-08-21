-- ============================================================================
-- Migration 027 — Fix missing RETURN NEXT in support set-returning functions
-- ============================================================================
-- ROOT CAUSE
--   Three support RPCs are declared RETURNS TABLE and assign their output
--   columns, but never emit a row:
--     * support_get_chat_availability  -> assigns columns, no RETURN NEXT
--     * support_start_live_chat        -> bare RETURN; (= 0 rows) on two
--                                         paths, no return at all on the
--                                         new-session path
--     * support_admin_get_chat_stats   -> assigns columns, no RETURN NEXT
--   In PL/pgSQL a set-returning function without RETURN NEXT / RETURN QUERY
--   returns an EMPTY result set. Consequences observed in production:
--     * Users ALWAYS see "No support agents currently available" because
--       the frontend falls back to { available_agents: 0 } on empty data —
--       regardless of agent status or heartbeat freshness.
--     * support_start_live_chat never returns the created/existing session,
--       so the user client treats every start attempt as a failure.
--     * Admin chat stats always render 0 / 0 / 0.
--
-- FIX
--   Redefine the three functions adding RETURN NEXT on every exit path.
--   Bodies are otherwise identical to the live definitions (including the
--   migration 023 fresh-heartbeat filters). CREATE OR REPLACE preserves
--   ownership and existing grants; no schema or RLS changes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. support_get_chat_availability — must emit exactly one summary row
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_get_chat_availability()
RETURNS TABLE (
  available_agents       INT,
  queue_size             INT,
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
  -- Count AVAILABLE agents with fresh heartbeat who haven't hit their max chat limit.
  -- Stale agents (no heartbeat for > 3 minutes) are excluded.
  SELECT COUNT(*) INTO v_available
  FROM public.support_agent_status sas
  WHERE sas.status = 'AVAILABLE'
    AND sas.last_heartbeat_at > now() - INTERVAL '3 minutes'
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
  RETURN NEXT;
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. support_start_live_chat — must emit the session row on every path
-- ----------------------------------------------------------------------------
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
  -- Check for existing ACTIVE session -> return it
  SELECT s.id, s.status INTO v_session_id, v_status
  FROM public.support_chat_sessions s
  WHERE s.user_id = auth.uid() AND s.status = 'ACTIVE'
  LIMIT 1;

  IF v_session_id IS NOT NULL THEN
    session_id := v_session_id;
    status := v_status;
    agent_assigned := TRUE;
    queue_position := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Check for existing WAITING session -> return it
  SELECT s.id, s.status INTO v_session_id, v_status
  FROM public.support_chat_sessions s
  WHERE s.user_id = auth.uid() AND s.status = 'WAITING'
  LIMIT 1;

  IF v_session_id IS NOT NULL THEN
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

  -- No existing session — try to find available agent (fresh heartbeat only)
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
    -- No agent available -> queue
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

-- ----------------------------------------------------------------------------
-- 3. support_admin_get_chat_stats — must emit exactly one stats row
-- ----------------------------------------------------------------------------
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
