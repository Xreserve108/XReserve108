-- XReserve Phase 17 — Remove legacy sell RPC overloads
--
-- Background:
--   Migration 006 was historically applied manually and its function
--   replacements did not fully land, leaving three legacy overloads from
--   migrations 002/003 alive alongside the hardened 006-era versions.
--   Migration 016's DROP targeted the 8-argument create_sell_order that 006
--   assumed as predecessor, so the 7-argument 002-era original survived.
--
-- Legacy overloads removed here (verified unused before authoring):
--   1. create_sell_order(NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT)
--      Migration 002 original: no 2FA, trusts client-supplied rate/INR/bank
--      text, EXECUTE granted to authenticated. Live security vulnerability.
--      Fully superseded by create_sell_order(NUMERIC, UUID, UUID, UUID) (016),
--      which performs the same atomic reserve flow plus server-side 2FA,
--      bank-account ownership, server-side rate, and client_token idempotency.
--   2. admin_complete_sell_order(UUID)
--      Migration 003 original: admin-gated but no admin 2FA.
--      Fully superseded by admin_complete_sell_order(UUID, UUID) (006).
--   3. admin_reject_sell_order(UUID, TEXT)
--      Migration 003 original: admin-gated but no admin 2FA.
--      Fully superseded by admin_reject_sell_order(UUID, TEXT, UUID) (006).
--
-- Pre-authoring verification (read-only):
--   - No frontend caller uses any of the three legacy signatures
--     (src/pages/sell.js -> 4-arg create; src/admin/sell-orders.js -> 2-arg
--     complete and 3-arg reject).
--   - No Edge Function references them.
--   - No SQL function body or trigger references them (pg_proc/pg_trigger scan).
--   - Dropping them removes only the functions and their grants; nothing else.

DROP FUNCTION IF EXISTS public.create_sell_order(NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.admin_complete_sell_order(UUID);
DROP FUNCTION IF EXISTS public.admin_reject_sell_order(UUID, TEXT);
