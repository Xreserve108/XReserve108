-- Verify remaining policies on bank_accounts
SELECT polname, polcmd FROM pg_policy WHERE polrelid = 'public.bank_accounts'::regclass;
