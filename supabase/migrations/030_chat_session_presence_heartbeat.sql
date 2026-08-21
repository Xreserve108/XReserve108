-- =============================================================================
-- XReserve Migration 030 — Chat Session Presence Heartbeat
-- =============================================================================
--
-- PROBLEM (migration 029 is UNSAFE):
--   Migration 029 purges ACTIVE/WAITING sessions whose updated_at is older
--   than 15 minutes. But updated_at only changes on MESSAGE SEND or
--   MARK-READ — NOT when a participant is merely viewing the chat.
--
--   Scenario:
--     User: "I need help with my deposit."
--     Admin: "Let me check that for you."
--     Admin investigates for 20 minutes (no new message sent).
--     Migration 029 purges the session at the 15-minute mark.
--     Both browser sessions are still open — the conversation is destroyed.
--
--   There is NO session-level presence detection:
--     - Agent heartbeat (support_agent_status.last_heartbeat_at) proves the
--       admin browser is open, but is NOT linked to the chat session.
--     - The user has NO heartbeat at all.
--     - Realtime is one-way (DB → client); it does NOT signal presence.
--
-- FIX:
--   1. Add user_last_seen_at and admin_last_seen_at to sessions.
--   2. New RPC support_chat_heartbeat() — called every 60s by both parties
--      while the chat page is open.
--   3. Purge logic changed from updated_at to:
--        ACTIVE:  BOTH user AND admin stale (> 15 min) → abandoned
--        WAITING: user stale (> 15 min) → abandoned
--   4. Frontend heartbeat added to user live-chat.js and admin live-chat.js.
--
-- SAFETY:
--   - No schema removal, no RLS changes, no new tables.
--   - Existing columns untouched; two nullable columns added.
--   - Backward compatible: nullable columns default to NULL; existing code
--     that reads specific columns is unaffected.
--   - The trigger trg_support_chat_updated continues to manage updated_at
--     for message/mark-read activity (unchanged).
-- =============================================================================

-- =============================================================================
-- PART 1 — Presence columns
-- =============================================================================

ALTER TABLE public.support_chat_sessions
  ADD COLUMN IF NOT EXISTS user_last_seen_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_last_seen_at TIMESTAMPTZ;

-- =============================================================================
-- PART 2 — Chat heartbeat RPC
-- =============================================================================
-- Called by both user and admin every 60 seconds while the chat page is open.
-- Updates the appropriate last_seen_at column for ACTIVE sessions.

CREATE OR REPLACE FUNCTION public.support_chat_heartbeat()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- User heartbeat: update user_last_seen_at for sessions where caller is user
  UPDATE public.support_chat_sessions
  SET user_last_seen_at = now()
  WHERE user_id = auth.uid()
    AND status IN ('ACTIVE', 'WAITING');

  -- Admin heartbeat: update admin_last_seen_at for sessions where caller is agent
  UPDATE public.support_chat_sessions
  SET admin_last_seen_at = now()
  WHERE agent_id = auth.uid()
    AND status = 'ACTIVE';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_chat_heartbeat() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_chat_heartbeat() TO authenticated;

-- =============================================================================
-- PART 3 — Rewrite _purge_stale_chat_sessions with presence-aware logic
-- =============================================================================
-- ACTIVE:  purge only when BOTH user AND admin are stale (> 15 min).
--          If no admin assigned, purge when user is stale.
-- WAITING: purge when user is stale (no admin involved yet).

CREATE OR REPLACE FUNCTION public._purge_stale_chat_sessions()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_threshold TIMESTAMPTZ := now() - INTERVAL '15 minutes';
BEGIN
  -- Delete messages belonging to stale sessions first (belt-and-suspenders;
  -- the FK cascade would handle this, but explicit is clearer).
  DELETE FROM public.support_chat_messages
  WHERE session_id IN (
    SELECT id FROM public.support_chat_sessions
    WHERE status = 'ACTIVE'
      AND user_last_seen_at < v_threshold
      AND (agent_id IS NULL OR admin_last_seen_at < v_threshold)

    UNION ALL

    SELECT id FROM public.support_chat_sessions
    WHERE status = 'WAITING'
      AND user_last_seen_at < v_threshold
  );

  -- Delete the stale sessions themselves.
  DELETE FROM public.support_chat_sessions
  WHERE status = 'ACTIVE'
    AND user_last_seen_at < v_threshold
    AND (agent_id IS NULL OR admin_last_seen_at < v_threshold);

  DELETE FROM public.support_chat_sessions
  WHERE status = 'WAITING'
    AND user_last_seen_at < v_threshold;
END;
$$;

-- =============================================================================
-- PART 4 — support_start_live_chat: presence-aware stale check
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
  v_session_id         UUID;
  v_agent_id           UUID;
  v_status             TEXT;
  v_position           INT;
  v_user_last_seen     TIMESTAMPTZ;
  v_admin_last_seen    TIMESTAMPTZ;
  v_threshold          TIMESTAMPTZ := now() - INTERVAL '15 minutes';
  v_is_stale           BOOLEAN;
BEGIN
  -- Check for existing ACTIVE session → return it (if not stale)
  SELECT s.id, s.status, s.user_last_seen_at, s.admin_last_seen_at
  INTO v_session_id, v_status, v_user_last_seen, v_admin_last_seen
  FROM public.support_chat_sessions s
  WHERE s.user_id = auth.uid() AND s.status = 'ACTIVE'
  LIMIT 1;

  IF v_session_id IS NOT NULL THEN
    -- Stale only when BOTH user AND admin are absent (or no admin assigned)
    v_is_stale := v_user_last_seen < v_threshold
                  AND (v_admin_last_seen IS NULL OR v_admin_last_seen < v_threshold);

    IF v_is_stale THEN
      DELETE FROM public.support_chat_messages WHERE session_id = v_session_id;
      DELETE FROM public.support_chat_sessions WHERE id = v_session_id;
      v_session_id := NULL;
    ELSE
      session_id := v_session_id;
      status := v_status;
      agent_assigned := TRUE;
      queue_position := NULL;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  -- Check for existing WAITING session → return it (if not stale)
  SELECT s.id, s.status, s.user_last_seen_at
  INTO v_session_id, v_status, v_user_last_seen
  FROM public.support_chat_sessions s
  WHERE s.user_id = auth.uid() AND s.status = 'WAITING'
  LIMIT 1;

  IF v_session_id IS NOT NULL THEN
    IF v_user_last_seen < v_threshold THEN
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
            admin_last_seen_at = now()
        WHERE id = v_session_id;

        UPDATE public.support_agent_status
        SET updated_at = now()
        WHERE agent_id = v_agent_id;

        session_id := v_session_id;
        status := 'ACTIVE';
        agent_assigned := TRUE;
        queue_position := NULL;
      ELSE
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
    INSERT INTO public.support_chat_sessions
      (user_id, agent_id, status, connected_at,
       user_last_seen_at, admin_last_seen_at,
       last_user_read_at, last_admin_read_at)
    VALUES (auth.uid(), v_agent_id, 'ACTIVE', now(),
            now(), now(),
            now(), now())
    RETURNING id INTO v_session_id;

    session_id := v_session_id;
    status := 'ACTIVE';
    agent_assigned := TRUE;
    queue_position := NULL;
  ELSE
    INSERT INTO public.support_chat_sessions
      (user_id, status, user_last_seen_at, last_user_read_at)
    VALUES (auth.uid(), 'WAITING', now(), now())
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
-- PART 5 — support_accept_chat: set admin_last_seen_at on accept
-- =============================================================================

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
      admin_last_seen_at = now(),
      last_admin_read_at = now()
  WHERE id = v_session_id;

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

-- =============================================================================
-- PART 6 — Admin RPCs: unchanged structure, purge logic updated via PART 3
-- =============================================================================
-- support_admin_get_active_chats(), support_admin_get_waiting_chats(), and
-- support_admin_get_chat_stats() already call _purge_stale_chat_sessions().
-- The purge helper was rewritten in PART 3 with presence-aware logic, so
-- these RPCs automatically benefit. No changes needed here.
-- =============================================================================
