-- XReserve Phase 11 — Admin Privilege Security Hardening
-- Single admin role (super_admin), maximum 2 active administrators,
-- no direct client modification of admin authorization records.

-- =============================================================================
-- 1. ROLE CONSTRAINT — only 'super_admin' is a valid admin role
-- =============================================================================

ALTER TABLE public.admin_users
DROP CONSTRAINT IF EXISTS chk_admin_role;

ALTER TABLE public.admin_users
ADD CONSTRAINT chk_admin_role
CHECK (role = 'super_admin');

-- =============================================================================
-- 2. HARDEN is_admin_user() — require role = 'super_admin'
-- =============================================================================

CREATE OR REPLACE FUNCTION public.is_admin_user()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE user_id = auth.uid()
      AND role = 'super_admin'
      AND is_active = true
  );
END;
$$;

-- =============================================================================
-- 3. REMOVE DIRECT CLIENT MODIFICATION OF admin_users
--    Drop the UPDATE policy that allowed admins to modify their own rows.
--    All admin record changes must go through controlled functions.
-- =============================================================================

DROP POLICY IF EXISTS "admin_users_update_own" ON public.admin_users;

-- Revoke all DML from authenticated/anon/public (defense in depth)
REVOKE INSERT ON public.admin_users FROM authenticated, anon, public;
REVOKE UPDATE ON public.admin_users FROM authenticated, anon, public;
REVOKE DELETE ON public.admin_users FROM authenticated, anon, public;

-- =============================================================================
-- 3b. DATABASE-LEVEL ENFORCEMENT: Maximum 2 active administrators
--     BEFORE INSERT OR UPDATE trigger — fires for ALL write paths
--     (add_admin, future RPCs, SECURITY DEFINER, service_role, direct SQL).
--     Acquires the SAME advisory transaction lock as add_admin() to
--     serialize concurrent writes and prevent race conditions.
--     PostgreSQL transaction-level advisory locks are re-entrant: if
--     add_admin() already holds the lock, the trigger re-acquires it
--     instantly within the same transaction — no deadlock.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_max_admins()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_count INTEGER;
BEGIN
  -- Only enforce when the new row is (or becomes) an active super_admin
  IF NEW.is_active = true AND NEW.role = 'super_admin' THEN

    -- Acquire the SAME advisory transaction lock used by add_admin().
    -- Re-entrant: if the calling transaction already holds this lock
    -- (e.g., via add_admin()), this succeeds immediately.
    PERFORM pg_advisory_xact_lock(hashtext('xreserve_admin_creation'));

    -- Count OTHER active super_admins (exclude the row being modified).
    -- For INSERT: NEW.user_id doesn't exist yet, so exclusion is a no-op.
    -- For UPDATE: excludes the current row so unrelated column updates
    --   on an existing active admin don't falsely trigger the limit.
    SELECT COUNT(*) INTO v_active_count
    FROM public.admin_users
    WHERE role = 'super_admin'
      AND is_active = true
      AND user_id != NEW.user_id;

    IF v_active_count >= 2 THEN
      RAISE EXCEPTION 'Maximum number of administrators reached';
    END IF;

  END IF;

  RETURN NEW;
END;
$$;

-- Trigger function: revoke all client EXECUTE (defense in depth —
-- trigger functions are invoked by the trigger mechanism, not by clients)
REVOKE EXECUTE ON FUNCTION public.enforce_max_admins() FROM authenticated, anon, public;

DROP TRIGGER IF EXISTS trg_enforce_max_admins ON public.admin_users;

CREATE TRIGGER trg_enforce_max_admins
  BEFORE INSERT OR UPDATE ON public.admin_users
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_max_admins();

-- =============================================================================
-- 4. CONTROLLED ADMIN CREATION FUNCTION
--    - Maximum 2 active administrators enforced atomically
--    - Race condition safe via pg_advisory_xact_lock
--    - created_by derived server-side from auth.uid()
--    - Only callable by existing super_admin
-- =============================================================================

CREATE OR REPLACE FUNCTION public.add_admin(
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_active_count INTEGER;
BEGIN
  -- Caller must be authenticated
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Caller must be an existing super_admin
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized — super_admin required';
  END IF;

  -- Target user must exist in profiles
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'user not found';
  END IF;

  -- Acquire session-level advisory lock (released automatically at transaction end)
  -- Prevents concurrent admin creation from exceeding the limit
  PERFORM pg_advisory_xact_lock(hashtext('xreserve_admin_creation'));

  -- Count current active administrators (under lock)
  SELECT COUNT(*) INTO v_active_count
  FROM public.admin_users
  WHERE role = 'super_admin' AND is_active = true;

  -- Enforce maximum 2 active administrators
  IF v_active_count >= 2 THEN
    RAISE EXCEPTION 'Maximum number of administrators reached';
  END IF;

  -- Insert or reactivate admin record
  INSERT INTO public.admin_users (user_id, role, is_active, created_by)
  VALUES (p_user_id, 'super_admin', true, auth.uid())
  ON CONFLICT (user_id) DO UPDATE
    SET role       = 'super_admin',
        is_active  = true,
        created_by = auth.uid(),
        updated_at = now();

  -- Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    'ADMIN_CREATED',
    'admin_users',
    p_user_id,
    jsonb_build_object('created_by', auth.uid()::TEXT)
  );

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.add_admin(UUID) FROM anon, public;

-- =============================================================================
-- 5. MIGRATION COMPLETE
-- =============================================================================
