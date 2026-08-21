-- =============================================================================
-- XReserve Migration 028 — End Chat Purge: no history after session ends
-- =============================================================================
--
-- Requirement: when a live chat session ends, NO chat history is maintained —
-- everything related to that chat is cleared.
--
-- support_end_chat is rewritten so that ending a live session:
--   1. Marks it ENDED first — this UPDATE is emitted via Realtime BEFORE the
--      deletes below commit, so both participants' clients observe the
--      terminal status and clear their local conversation state.
--   2. Notifies the other party (notifications.reference_id has no FK, so it
--      survives the purge).
--   3. Hard-deletes all messages and the session row itself.
--
-- FK safety:
--   - support_chat_messages.session_id  → ON DELETE CASCADE (deleted anyway)
--   - support_tickets.chat_session_id   → ON DELETE SET NULL (ticket survives)
--   - notifications.reference_id        → plain UUID, no FK
--
-- Side effects accepted by the requirement:
--   - support_get_user_chat_history returns no ended sessions (Chat History
--     page shows its empty state).
--   - support_get_chat_availability loses its ENDED-based average duration
--     input and uses the existing constant fallback estimates.
--
-- A one-time cleanup also purges all sessions already ENDED/ABANDONED before
-- this migration, so no historical chat data remains.
-- =============================================================================

-- =============================================================================
-- PART 1 — Rewrite support_end_chat to purge on end
-- =============================================================================

CREATE OR REPLACE FUNCTION public.support_end_chat(
  p_session_id UUID
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user   UUID;
  v_agent  UUID;
  v_status TEXT;
BEGIN
  SELECT user_id, agent_id, status
  INTO v_user, v_agent, v_status
  FROM public.support_chat_sessions
  WHERE id = p_session_id;

  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Chat session not found';
  END IF;

  -- Authorization: must be the user or an admin
  IF auth.uid() != v_user AND NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  -- Only live sessions can be ended; already-terminal sessions are no-ops
  IF v_status NOT IN ('WAITING', 'ACTIVE') THEN
    RETURN;
  END IF;

  -- 1) Terminal status first — Realtime emits this UPDATE before the
  --    deletes below commit, letting connected clients tear down cleanly.
  UPDATE public.support_chat_sessions
  SET status = 'ENDED',
      ended_at = now(),
      updated_at = now()
  WHERE id = p_session_id;

  -- 2) Notify the other party before purging
  IF auth.uid() = v_user AND v_agent IS NOT NULL THEN
    PERFORM public.create_notification(
      v_agent,
      'chat_ended',
      'Chat Ended',
      'The user has ended the chat session.',
      '{}'::jsonb,
      p_session_id
    );
  ELSIF auth.uid() != v_user THEN
    PERFORM public.create_notification(
      v_user,
      'chat_ended',
      'Chat Ended',
      'The support agent has ended the chat session.',
      '{}'::jsonb,
      p_session_id
    );
  END IF;

  -- 3) No history is maintained — purge messages, then the session itself
  DELETE FROM public.support_chat_messages
  WHERE session_id = p_session_id;

  DELETE FROM public.support_chat_sessions
  WHERE id = p_session_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.support_end_chat(UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.support_end_chat(UUID) TO authenticated;

-- =============================================================================
-- PART 2 — One-time cleanup of already-ended sessions
-- =============================================================================
-- Messages cascade with the session; tickets referencing them are SET NULL.

DELETE FROM public.support_chat_sessions
WHERE status IN ('ENDED', 'ABANDONED');
