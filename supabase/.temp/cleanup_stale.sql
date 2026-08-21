-- Clean stale test session
DELETE FROM public.support_chat_messages WHERE session_id = '3fc6f431-9e56-4a36-bd76-ce130db106e4';
DELETE FROM public.support_chat_sessions WHERE id = '3fc6f431-9e56-4a36-bd76-ce130db106e4';

-- Verify
SELECT COUNT(*) AS remaining_sessions FROM public.support_chat_sessions WHERE status IN ('ACTIVE','WAITING');
SELECT COUNT(*) AS remaining_messages FROM public.support_chat_messages;
