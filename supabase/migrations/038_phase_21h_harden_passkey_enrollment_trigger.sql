-- Migration 038: Harden Passkey Enrollment Authorization Trigger
-- Recreates only the existing trigger function as SECURITY DEFINER so it can
-- enforce the authorization gate while the underlying table remains protected
-- by RLS with no client policies.

CREATE OR REPLACE FUNCTION public._check_passkey_enrollment_auth()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auth_id UUID;
BEGIN
  -- Find and atomically consume exactly one valid authorization for NEW.user_id.
  -- FOR UPDATE SKIP LOCKED ensures safe concurrent registration attempts.
  SELECT a.id
  INTO v_auth_id
  FROM public.passkey_enrollment_authorizations AS a
  WHERE a.user_id = NEW.user_id
    AND a.consumed_at IS NULL
    AND a.expires_at > NOW()
  ORDER BY a.created_at DESC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION 'Passkey enrollment not authorized. Complete 2FA verification before adding a passkey.';
  END IF;

  -- Mark authorization as consumed (single-use).
  UPDATE public.passkey_enrollment_authorizations
  SET consumed_at = NOW()
  WHERE id = v_auth_id;

  RETURN NEW;
END;
$$;

-- Clients cannot invoke the trigger function directly. GoTrue's database role
-- retains explicit execution permission for the existing credential trigger.
REVOKE ALL ON FUNCTION public._check_passkey_enrollment_auth() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._check_passkey_enrollment_auth() FROM anon;
REVOKE ALL ON FUNCTION public._check_passkey_enrollment_auth() FROM authenticated;
GRANT EXECUTE ON FUNCTION public._check_passkey_enrollment_auth() TO supabase_auth_admin;
