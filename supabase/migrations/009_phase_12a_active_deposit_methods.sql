-- XReserve Phase 12A — Secure Active Deposit Methods
-- Admin-configurable deposit method registry (TRC20, BEP20).
-- Database-level enforcement of network constraints and one-active-per-network invariant.
-- All admin writes require is_admin_user() + admin_settings 2FA scope.
--
-- QR CODES: Generated deterministically client-side from the deposit address
-- using the existing `qrcode` library (already a project dependency for TOTP
-- enrollment QR codes). This guarantees QR ↔ address consistency at all times
-- and eliminates the need for a storage bucket, file uploads, or service-role
-- key exposure to the browser.

-- =============================================================================
-- 1. DEPOSIT METHODS TABLE
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.deposit_methods (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  network         TEXT NOT NULL,
  asset           TEXT NOT NULL DEFAULT 'USDT',
  deposit_address TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT false,
  created_by      UUID REFERENCES auth.users(id),
  updated_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- 2. CONSTRAINTS
-- =============================================================================

-- Network whitelist: only known networks are accepted
ALTER TABLE public.deposit_methods
ADD CONSTRAINT chk_deposit_method_network
CHECK (network IN ('TRC20', 'BEP20'));

-- Asset must be non-empty
ALTER TABLE public.deposit_methods
ADD CONSTRAINT chk_deposit_method_asset
CHECK (char_length(trim(asset)) > 0);

-- Active method must have a non-empty deposit address
ALTER TABLE public.deposit_methods
ADD CONSTRAINT chk_active_method_has_address
CHECK (NOT is_active OR (deposit_address IS NOT NULL AND char_length(trim(deposit_address)) > 0));

-- =============================================================================
-- 3. ONE ACTIVE METHOD PER NETWORK — database-level invariant
--    Partial unique index: at most 1 row per network where is_active = true.
--    This is a hard database guarantee, not dependent on application logic.
-- =============================================================================

CREATE UNIQUE INDEX idx_deposit_methods_one_active_per_network
  ON public.deposit_methods (network)
  WHERE is_active = true;

-- =============================================================================
-- 4. ROW LEVEL SECURITY
-- =============================================================================

ALTER TABLE public.deposit_methods ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read active methods (for future Deposit UI)
DROP POLICY IF EXISTS "deposit_methods_select_active" ON public.deposit_methods;
CREATE POLICY "deposit_methods_select_active"
  ON public.deposit_methods FOR SELECT
  USING (auth.role() = 'authenticated' AND is_active = true);

-- Admins can read all methods (including inactive) for management
DROP POLICY IF EXISTS "deposit_methods_select_admin" ON public.deposit_methods;
CREATE POLICY "deposit_methods_select_admin"
  ON public.deposit_methods FOR SELECT
  USING (public.is_admin_user());

-- No client INSERT/UPDATE/DELETE policies — all writes go through RPC functions.
-- Revoke DML from client roles (defense in depth)
REVOKE INSERT ON public.deposit_methods FROM authenticated, anon, public;
REVOKE UPDATE ON public.deposit_methods FROM authenticated, anon, public;
REVOKE DELETE ON public.deposit_methods FROM authenticated, anon, public;

-- =============================================================================
-- 5. UPDATED_AT TRIGGER
-- =============================================================================

DROP TRIGGER IF EXISTS trg_deposit_methods_updated_at ON public.deposit_methods;
CREATE TRIGGER trg_deposit_methods_updated_at
  BEFORE UPDATE ON public.deposit_methods
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- 6. ADMIN RPC FUNCTIONS
--    All require: is_admin_user() + _require_admin_2fa(scope => 'admin_settings')
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 6a. List all deposit methods (admin only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_deposit_methods()
RETURNS TABLE (
  id              UUID,
  network         TEXT,
  asset           TEXT,
  deposit_address TEXT,
  is_active       BOOLEAN,
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT dm.id, dm.network, dm.asset, dm.deposit_address,
         dm.is_active, dm.created_by, dm.updated_by, dm.created_at, dm.updated_at
  FROM public.deposit_methods dm
  ORDER BY dm.network ASC;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6b. Get active deposit methods (authenticated users — for future Deposit UI)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_active_deposit_methods()
RETURNS TABLE (
  network         TEXT,
  asset           TEXT,
  deposit_address TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN QUERY
  SELECT dm.network, dm.asset, dm.deposit_address
  FROM public.deposit_methods dm
  WHERE dm.is_active = true
  ORDER BY dm.network ASC;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6c. Upsert deposit method (admin — creates or updates a method)
--     Uses INSERT ... ON CONFLICT to handle both create and update atomically.
--     The one-active-per-network index prevents duplicate active methods.
--     The CHECK constraint prevents activating without an address.
--
--     QR codes are generated client-side from deposit_address using the
--     existing `qrcode` library. No QR storage or upload is involved.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_upsert_deposit_method(
  p_network         TEXT,
  p_deposit_address TEXT,
  p_is_active       BOOLEAN DEFAULT false,
  p_verification_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_method_id UUID;
  v_is_new    BOOLEAN;
  v_old_addr  TEXT;
BEGIN
  -- Authorization
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_settings');

  -- Validate network
  IF p_network NOT IN ('TRC20', 'BEP20') THEN
    RAISE EXCEPTION 'Unsupported network: %', p_network;
  END IF;

  -- Validate address: must be non-empty and trimmed
  IF p_deposit_address IS NULL OR char_length(trim(p_deposit_address)) = 0 THEN
    RAISE EXCEPTION 'Deposit address must not be empty';
  END IF;

  -- Trim the address
  p_deposit_address := trim(p_deposit_address);

  -- Check if method already exists for this network
  SELECT id, deposit_address INTO v_method_id, v_old_addr
  FROM public.deposit_methods
  WHERE network = p_network;

  IF v_method_id IS NOT NULL THEN
    -- UPDATE existing method
    UPDATE public.deposit_methods
    SET deposit_address = p_deposit_address,
        is_active       = p_is_active,
        updated_by      = auth.uid()
    WHERE id = v_method_id;

    -- Audit log
    INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (
      auth.uid(),
      'DEPOSIT_METHOD_UPDATED',
      'deposit_method',
      v_method_id,
      jsonb_build_object(
        'network', p_network,
        'is_active', p_is_active,
        'address_changed', v_old_addr IS DISTINCT FROM p_deposit_address,
        'verification_id', p_verification_id
      )
    );

    RETURN v_method_id;
  ELSE
    -- INSERT new method
    INSERT INTO public.deposit_methods (network, asset, deposit_address, is_active, created_by, updated_by)
    VALUES (p_network, 'USDT', p_deposit_address, p_is_active, auth.uid(), auth.uid())
    RETURNING id INTO v_method_id;

    -- Audit log
    INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
    VALUES (
      auth.uid(),
      'DEPOSIT_METHOD_CREATED',
      'deposit_method',
      v_method_id,
      jsonb_build_object(
        'network', p_network,
        'is_active', p_is_active,
        'verification_id', p_verification_id
      )
    );

    RETURN v_method_id;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6d. Toggle deposit method active/inactive (admin)
--     The partial unique index prevents activating if another method for
--     the same network is already active.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_toggle_deposit_method(
  p_method_id       UUID,
  p_is_active       BOOLEAN,
  p_verification_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_network TEXT;
  v_was_active BOOLEAN;
BEGIN
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_settings');

  SELECT network, is_active INTO v_network, v_was_active
  FROM public.deposit_methods
  WHERE id = p_method_id
  FOR UPDATE;

  IF v_network IS NULL THEN
    RAISE EXCEPTION 'Deposit method not found';
  END IF;

  -- If activating, the CHECK constraint ensures address is set.
  -- The partial unique index ensures no duplicate active methods per network.
  UPDATE public.deposit_methods
  SET is_active  = p_is_active,
      updated_by = auth.uid()
  WHERE id = p_method_id;

  -- Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (
    auth.uid(),
    CASE WHEN p_is_active THEN 'DEPOSIT_METHOD_ACTIVATED' ELSE 'DEPOSIT_METHOD_DEACTIVATED' END,
    'deposit_method',
    p_method_id,
    jsonb_build_object(
      'network', v_network,
      'previous_active', v_was_active,
      'new_active', p_is_active,
      'verification_id', p_verification_id
    )
  );

  RETURN TRUE;
END;
$$;

-- =============================================================================
-- 7. SECURITY — REVOKE CLIENT ACCESS
-- =============================================================================

-- Admin RPCs: revoke from anon/public
REVOKE EXECUTE ON FUNCTION public.admin_list_deposit_methods() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_upsert_deposit_method(TEXT, TEXT, BOOLEAN, UUID) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.admin_toggle_deposit_method(UUID, BOOLEAN, UUID) FROM anon, public;

-- Public read RPC: revoke from anon (must be authenticated)
REVOKE EXECUTE ON FUNCTION public.get_active_deposit_methods() FROM anon, public;

-- =============================================================================
-- 8. MIGRATION COMPLETE
-- =============================================================================
-- Phase 12A: Secure Active Deposit Methods
-- - deposit_methods table with network whitelist (TRC20, BEP20)
-- - One-active-per-network enforced by partial unique index
-- - Active method requires non-empty address (CHECK constraint)
-- - All admin writes require is_admin_user() + admin_settings 2FA scope
-- - QR codes generated client-side from deposit_address (deterministic)
-- - No storage bucket, no file uploads, no service-role key exposure
-- - Audit logging for all admin operations
-- =============================================================================
