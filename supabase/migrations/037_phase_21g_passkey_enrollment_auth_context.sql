-- Migration 037: Passkey Enrollment Auth Context
-- Phase 21G — Consume enrollment verification in the authenticated user's context.
--
-- The public RPC is intentionally narrow: callers provide only a verification
-- token. User identity is always derived from auth.uid(), and the existing
-- authoritative token consumer enforces ownership, expiry, single use, and the
-- passkey_enrollment scope.

CREATE OR REPLACE FUNCTION public.authorize_passkey_enrollment(
  p_token_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_authorization_id UUID;
  v_verification_method TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- Serialize enrollment authorization creation per user so there is never
  -- more than one active authorization competing for the credential trigger.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_user_id::TEXT, 0));

  -- Authoritative atomic validation and consumption. This enforces user
  -- ownership, expiry, single use, and the exact enrollment scope.
  PERFORM public._consume_verification_token(
    p_token_id,
    'passkey_enrollment'
  );

  -- Passkey verification tokens carry a source challenge; TOTP/recovery-code
  -- verification tokens do not. Ownership has already been established above.
  SELECT CASE
    WHEN v.source_challenge_id IS NULL THEN 'totp'
    ELSE 'passkey'
  END
  INTO v_verification_method
  FROM public.user_2fa_verifications AS v
  WHERE v.id = p_token_id
    AND v.user_id = v_user_id;

  IF v_verification_method IS NULL THEN
    RAISE EXCEPTION 'Invalid verification token';
  END IF;

  -- Supersede any older unconsumed authorization before creating the new gate.
  UPDATE public.passkey_enrollment_authorizations
  SET consumed_at = NOW()
  WHERE user_id = v_user_id
    AND consumed_at IS NULL;

  INSERT INTO public.passkey_enrollment_authorizations (
    user_id,
    expires_at,
    verification_method,
    is_signup
  )
  VALUES (
    v_user_id,
    NOW() + INTERVAL '5 minutes',
    v_verification_method,
    false
  )
  RETURNING id INTO v_authorization_id;

  INSERT INTO public.audit_logs (
    actor_id,
    action,
    target_type,
    target_id,
    metadata
  )
  VALUES (
    v_user_id,
    'PASSKEY_ENROLLMENT_AUTHORIZED',
    'passkey_enrollment_authorization',
    v_authorization_id,
    jsonb_build_object('method', v_verification_method)
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_passkey_enrollment(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_passkey_enrollment(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.authorize_passkey_enrollment(UUID) TO authenticated;

COMMENT ON FUNCTION public.authorize_passkey_enrollment(UUID) IS
  'Atomically consumes a user-bound passkey_enrollment verification token and creates a short-lived enrollment authorization.';
