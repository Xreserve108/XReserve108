-- Verify function permissions
SELECT 
  r.rolname AS role_name,
  has_function_privilege(r.rolname, 'public.delete_bank_account(uuid, uuid)', 'EXECUTE') AS can_execute
FROM pg_roles r
WHERE r.rolname IN ('anon', 'authenticated', 'public', 'service_role', 'postgres');
