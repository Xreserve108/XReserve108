-- Verify policies on bank_accounts and DELETE privilege
SELECT 
  polname AS policy_name,
  polcmd AS command,
  pg_get_expr(polqual, polrelid) AS using_expr
FROM pg_policy
WHERE polrelid = 'public.bank_accounts'::regclass;

SELECT 
  r.rolname AS role_name,
  has_table_privilege(r.rolname, 'public.bank_accounts', 'DELETE') AS can_delete
FROM pg_roles r
WHERE r.rolname IN ('anon', 'authenticated', 'public');
