-- =============================================================================
-- XReserve Migration 019 — Credit continuation + admin notification counts
-- =============================================================================
--
-- PART A — SINGLE-2FA MANUAL VERIFY → CREDIT CONTINUATION
--
--   Current UX requires TWO admin_financial 2FA challenges for one logical
--   workflow: Manual Verify (2FA) → reopen deposit → Credit (2FA again).
--
--   This migration adds a short-lived, server-side CONTINUATION
--   authorization issued at successful manual verification:
--
--     Manual Verify (ONE admin_financial 2FA, consumed as today)
--       → server issues admin_credit_continuations row
--         (bound to THIS admin + THIS deposit, single-use, 5-minute expiry)
--       → immediate Credit may present the continuation INSTEAD of a fresh
--         2FA token; the credit RPC atomically validates + consumes it.
--
--   SECURITY PROPERTIES (nothing weakened):
--     - admin_credit_verified_deposit is NOT stripped of 2FA: with no
--       continuation, the existing admin_financial 2FA path is mandatory.
--     - Continuations are single-use (consumed_at set atomically), expire
--       after 5 minutes, are bound to the issuing admin AND the specific
--       deposit, and can never authorize any other deposit.
--     - The credit RPC keeps EVERY existing check: is_admin_user,
--       PENDING_VERIFICATION + Phase 14 marker, verification source,
--       manual verification + full 8-item checklist re-validation,
--       verified_amount > 0, DB-derived credit amount only, FOR UPDATE
--       locking, atomic wallet + ledger + status update, idempotency,
--       audit log.
--     - Table is RLS-enabled with no policies and direct access revoked;
--       it is only ever touched inside SECURITY DEFINER functions.
--
-- PART B — ADMIN NAVIGATION NOTIFICATION COUNTS
--
--   Small admin-only RPC returning real pending-action counts for the
--   admin UI badges:
--     pending_deposits : PENDING_VERIFICATION deposits awaiting admin action
--     pending_orders   : sell orders awaiting admin action
--                        (PAYMENT_PENDING, PAYMENT_PROOF_UPLOADED,
--                        MANUAL_REVIEW — the exact set accepted by
--                        admin_complete_sell_order / admin_reject_sell_order)
--     new_users        : profiles registered within the last 7 days AND
--                        (when p_users_since is supplied) after that
--                        client-held "last seen" marker — this enables the
--                        Users badge open-to-clear semantics without any
--                        extra table. Deposits/Orders counts are purely
--                        status-driven and never reset on open.
-- =============================================================================

-- =============================================================================
-- PART A.1 — Continuation store
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.admin_credit_continuations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id   UUID        NOT NULL REFERENCES public.deposits(id),
  admin_id     UUID        NOT NULL DEFAULT auth.uid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes'),
  consumed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_credit_continuations_deposit
  ON public.admin_credit_continuations (deposit_id);

ALTER TABLE public.admin_credit_continuations ENABLE ROW LEVEL SECURITY;
-- No policies: the table is never accessed directly by clients.

REVOKE ALL ON public.admin_credit_continuations FROM anon, authenticated, public;

-- =============================================================================
-- PART A.2 — admin_manually_verify_deposit now issues a continuation
--
--   Body is identical to migration 018 EXCEPT:
--     - RETURNS UUID instead of BOOLEAN
--     - on success, inserts a continuation row and returns its id
--   Signature changed → drop + recreate; grants re-asserted below.
-- =============================================================================

DROP FUNCTION IF EXISTS public.admin_manually_verify_deposit(UUID, JSONB, TEXT, UUID, NUMERIC);

CREATE FUNCTION public.admin_manually_verify_deposit(
  p_deposit_id             UUID,
  p_checklist              JSONB,
  p_notes                  TEXT    DEFAULT NULL,
  p_verification_id        UUID    DEFAULT NULL,
  p_manual_verified_amount NUMERIC DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_deposit        RECORD;
  v_admin_id       UUID := auth.uid();
  v_continuation_id UUID;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- Manual verification is an independent override path; it is gated by
  -- the existing admin_financial 2FA architecture (single-use token).
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');

  IF p_deposit_id IS NULL THEN
    RAISE EXCEPTION 'deposit_id is required';
  END IF;

  -- Validate checklist structure: must be JSONB object with all 8 keys TRUE
  IF p_checklist IS NULL OR jsonb_typeof(p_checklist) <> 'object' THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: checklist is required (JSONB object)';
  END IF;
  IF NOT (
    (p_checklist ? 'txid')        AND (p_checklist->>'txid')::boolean = true AND
    (p_checklist ? 'network')     AND (p_checklist->>'network')::boolean = true AND
    (p_checklist ? 'token')       AND (p_checklist->>'token')::boolean = true AND
    (p_checklist ? 'sender')      AND (p_checklist->>'sender')::boolean = true AND
    (p_checklist ? 'recipient')   AND (p_checklist->>'recipient')::boolean = true AND
    (p_checklist ? 'amount')      AND (p_checklist->>'amount')::boolean = true AND
    (p_checklist ? 'finality')    AND (p_checklist->>'finality')::boolean = true AND
    (p_checklist ? 'wallet_info') AND (p_checklist->>'wallet_info')::boolean = true
  ) THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: all 8 checklist items must be explicitly confirmed (txid, network, token, sender, recipient, amount, finality, wallet_info)';
  END IF;

  -- Lock the deposit row
  SELECT * INTO v_deposit
  FROM public.deposits
  WHERE id = p_deposit_id
  FOR UPDATE;

  IF v_deposit.id IS NULL THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit not found';
  END IF;

  IF v_deposit.status = 'CREDITED' THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit is already credited';
  END IF;

  IF v_deposit.status <> 'PENDING_VERIFICATION' THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit must be in PENDING_VERIFICATION status (current: %)', v_deposit.status;
  END IF;

  -- Phase 14 marker: deposit_method_id must be set.
  IF v_deposit.deposit_method_id IS NULL THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit has no deposit method (not a Phase 14 deposit)';
  END IF;

  -- Idempotency: if already manually verified, reject
  IF v_deposit.manually_verified_at IS NOT NULL THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit has already been manually verified';
  END IF;

  -- MANUAL OVERRIDE AMOUNT validation (server-side, client value is never
  -- trusted): only allowed when blockchain verification has NOT already
  -- established verified_amount.
  IF p_manual_verified_amount IS NOT NULL THEN
    IF v_deposit.blockchain_verified_at IS NOT NULL OR v_deposit.verified_amount IS NOT NULL THEN
      RAISE EXCEPTION 'admin_manually_verify_deposit: manual amount is not allowed — blockchain verification has already established the verified amount';
    END IF;
    IF p_manual_verified_amount <= 0 THEN
      RAISE EXCEPTION 'admin_manually_verify_deposit: manual verified amount must be greater than 0';
    END IF;
  END IF;

  -- Record manual verification (unchanged from 018).
  UPDATE public.deposits
     SET manually_verified_at         = now(),
         manually_verified_by         = v_admin_id,
         manual_verification_notes    = NULLIF(trim(p_notes), ''),
         manual_verification_checklist = p_checklist,
         verified_amount = CASE
                             WHEN p_manual_verified_amount IS NOT NULL
                               THEN p_manual_verified_amount
                             ELSE verified_amount
                           END,
         metadata = CASE
                      WHEN p_manual_verified_amount IS NOT NULL
                        THEN COALESCE(metadata, '{}'::jsonb) ||
                             jsonb_build_object('verified_amount_source', 'manual_override')
                      ELSE metadata
                    END,
         updated_at                   = now()
   WHERE id = p_deposit_id;

  -- Issue a short-lived single-use credit continuation bound to THIS
  -- admin + THIS deposit. Lets the immediate Credit action proceed
  -- without a second 2FA prompt; the credit RPC re-validates everything.
  INSERT INTO public.admin_credit_continuations (deposit_id, admin_id)
  VALUES (p_deposit_id, v_admin_id)
  RETURNING id INTO v_continuation_id;

  -- Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (
    v_admin_id,
    'DEPOSIT_MANUALLY_VERIFIED',
    'deposit',
    p_deposit_id,
    jsonb_build_object(
      'deposit_id', p_deposit_id,
      'user_id', v_deposit.user_id,
      'verified_amount', CASE
                           WHEN p_manual_verified_amount IS NOT NULL
                             THEN p_manual_verified_amount
                           ELSE v_deposit.verified_amount
                         END,
      'verified_amount_source', CASE
                                  WHEN p_manual_verified_amount IS NOT NULL
                                    THEN 'manual_override'
                                  ELSE 'blockchain'
                                END,
      'manual_verified_amount', p_manual_verified_amount,
      'declared_amount', v_deposit.declared_amount,
      'tx_hash', v_deposit.tx_hash,
      'blockchain_verified', v_deposit.blockchain_verified_at IS NOT NULL,
      'notes_provided', p_notes IS NOT NULL,
      'checklist', p_checklist,
      'credit_continuation_issued', true
    )
  );

  RETURN v_continuation_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_manually_verify_deposit(UUID, JSONB, TEXT, UUID, NUMERIC) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_manually_verify_deposit(UUID, JSONB, TEXT, UUID, NUMERIC) TO   authenticated;

-- =============================================================================
-- PART A.3 — admin_credit_verified_deposit accepts an OPTIONAL continuation
--
--   ONLY change vs 018: step 3 authorization becomes
--     "fresh admin_financial 2FA token  OR  valid continuation",
--   where a continuation is atomically validated + consumed and is bound
--   to the calling admin, this exact deposit, unexpired, and unused.
--   All 20 other steps are preserved verbatim.
--   Signature changed (new defaulted param) → drop + recreate.
-- =============================================================================

DROP FUNCTION IF EXISTS public.admin_credit_verified_deposit(UUID, UUID);

CREATE FUNCTION public.admin_credit_verified_deposit(
  p_deposit_id      UUID,
  p_verification_id UUID    DEFAULT NULL,
  p_continuation_id UUID    DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_deposit          RECORD;
  v_wallet_id        UUID;
  v_balance_before   NUMERIC(18,8);
  v_credit_amount    NUMERIC(18,6);
  v_admin_id         UUID := auth.uid();
  v_consumed_rows    INT;
  v_auth_method      TEXT;
BEGIN
  -- 1. Authentication
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- 2. Authorization: must be admin
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 3. Authorization token: fresh admin_financial 2FA verification
  --    (existing path) OR a valid continuation issued by a successful
  --    manual verification of THIS deposit by THIS admin. The
  --    continuation is single-use, short-lived, and consumed atomically.
  IF p_verification_id IS NOT NULL THEN
    PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');
    v_auth_method := '2fa';
  ELSIF p_continuation_id IS NOT NULL THEN
    IF p_deposit_id IS NULL THEN
      RAISE EXCEPTION 'admin_credit_verified_deposit: deposit_id is required';
    END IF;
    UPDATE public.admin_credit_continuations c
       SET consumed_at = now()
     WHERE c.id = p_continuation_id
       AND c.deposit_id = p_deposit_id
       AND c.admin_id = v_admin_id
       AND c.consumed_at IS NULL
       AND c.expires_at > now()
     RETURNING 1 INTO v_consumed_rows;
    IF v_consumed_rows IS NULL THEN
      RAISE EXCEPTION 'admin_credit_verified_deposit: continuation is invalid, expired, or already used';
    END IF;
    v_auth_method := 'continuation';
  ELSE
    RAISE EXCEPTION 'admin_credit_verified_deposit: a 2FA verification id or a valid continuation id is required';
  END IF;

  -- 4. Parameter validation
  IF p_deposit_id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit_id is required';
  END IF;

  -- 5. Lock the deposit row
  SELECT * INTO v_deposit
  FROM public.deposits
  WHERE id = p_deposit_id
  FOR UPDATE;

  -- 6. Deposit must exist
  IF v_deposit.id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit not found';
  END IF;

  -- 7. Reject already-credited deposits (idempotency)
  IF v_deposit.status = 'CREDITED' THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit already credited';
  END IF;

  -- 8. Status must be exactly PENDING_VERIFICATION
  IF v_deposit.status <> 'PENDING_VERIFICATION' THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit must be in PENDING_VERIFICATION status (current: %)', v_deposit.status;
  END IF;

  -- Phase 14 marker: deposit_method_id must be set.
  IF v_deposit.deposit_method_id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit has no deposit method (not a Phase 14 deposit)';
  END IF;

  -- 9. Verification source for the verified amount: blockchain
  --    verification completed, OR an admin_financial-2FA-gated manual
  --    override established the amount.
  IF v_deposit.blockchain_verified_at IS NULL
     AND COALESCE(v_deposit.metadata->>'verified_amount_source', '') <> 'manual_override' THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: no valid verification source for the verified amount (blockchain verification not completed and no manual override recorded)';
  END IF;

  -- 10. Manual admin verification must have completed
  IF v_deposit.manually_verified_at IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: manual admin verification has not completed';
  END IF;

  -- 11. Manual verification checklist must be present
  IF v_deposit.manual_verification_checklist IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: manual verification checklist is missing';
  END IF;

  -- 12. Validate all 8 checklist items are present and TRUE
  IF NOT (
    (v_deposit.manual_verification_checklist ? 'txid')        AND (v_deposit.manual_verification_checklist->>'txid')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'network')     AND (v_deposit.manual_verification_checklist->>'network')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'token')       AND (v_deposit.manual_verification_checklist->>'token')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'sender')      AND (v_deposit.manual_verification_checklist->>'sender')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'recipient')   AND (v_deposit.manual_verification_checklist->>'recipient')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'amount')      AND (v_deposit.manual_verification_checklist->>'amount')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'finality')    AND (v_deposit.manual_verification_checklist->>'finality')::boolean = true AND
    (v_deposit.manual_verification_checklist ? 'wallet_info') AND (v_deposit.manual_verification_checklist->>'wallet_info')::boolean = true
  ) THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: manual verification checklist is incomplete';
  END IF;

  -- 13. verified_amount must be set and positive
  IF v_deposit.verified_amount IS NULL OR v_deposit.verified_amount <= 0 THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit has no valid verified amount';
  END IF;

  -- 14. DERIVE the credit amount exclusively from the database.
  v_credit_amount := v_deposit.verified_amount;

  -- 15. Lock the user's wallet balance
  SELECT wb.wallet_id, wb.available_usdt
    INTO v_wallet_id, v_balance_before
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = v_deposit.user_id
     FOR UPDATE OF wb;

  -- 16. Wallet must exist
  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: wallet not found';
  END IF;

  -- 17. Credit the wallet using verified_amount
  UPDATE public.wallet_balances
     SET available_usdt = available_usdt + v_credit_amount,
         updated_at     = now()
   WHERE wallet_id = v_wallet_id;

  -- 18. Insert ledger entry
  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after,
     reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'CREDIT', v_credit_amount, v_balance_before,
          v_balance_before + v_credit_amount, 'deposit', p_deposit_id,
          jsonb_build_object(
            'direction', 'credit',
            'context', 'admin_verified_deposit_credit',
            'verified_amount', v_deposit.verified_amount,
            'verified_amount_source', COALESCE(v_deposit.metadata->>'verified_amount_source', 'blockchain'),
            'declared_amount', v_deposit.declared_amount,
            'blockchain_verified_at', v_deposit.blockchain_verified_at,
            'manually_verified_at', v_deposit.manually_verified_at,
            'verification_id', p_verification_id,
            'auth_method', v_auth_method
          ));

  -- 19. Mark deposit as CREDITED
  UPDATE public.deposits
     SET status = 'CREDITED',
         actual_amount = v_credit_amount,
         metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'credited_at', now(),
           'credited_by', v_admin_id,
           'verified_amount', v_deposit.verified_amount,
           'declared_amount', v_deposit.declared_amount,
           'credit_function', 'admin_credit_verified_deposit',
           'credit_auth_method', v_auth_method
         ),
         updated_at = now()
   WHERE id = p_deposit_id;

  -- 20. Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (v_admin_id, 'DEPOSIT_CREDITED', 'deposit', p_deposit_id,
    jsonb_build_object(
      'amount', v_credit_amount,
      'verified_amount', v_deposit.verified_amount,
      'verified_amount_source', COALESCE(v_deposit.metadata->>'verified_amount_source', 'blockchain'),
      'declared_amount', v_deposit.declared_amount,
      'previous_status', 'PENDING_VERIFICATION',
      'new_status', 'CREDITED',
      'user_id', v_deposit.user_id,
      'verification_id', p_verification_id,
      'continuation_id', p_continuation_id,
      'auth_method', v_auth_method,
      'credit_function', 'admin_credit_verified_deposit',
      'blockchain_verified_at', v_deposit.blockchain_verified_at,
      'manually_verified_at', v_deposit.manually_verified_at
    ));

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_credit_verified_deposit(UUID, UUID, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_credit_verified_deposit(UUID, UUID, UUID) TO   authenticated;

-- =============================================================================
-- PART B — admin_notification_counts (admin-only badge counts)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_notification_counts(
  p_users_since TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  pending_deposits BIGINT,
  pending_orders   BIGINT,
  new_users        BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  RETURN QUERY
  SELECT
    (SELECT count(*) FROM public.deposits
      WHERE status = 'PENDING_VERIFICATION')::BIGINT,
    (SELECT count(*) FROM public.sell_orders
      WHERE status IN ('PAYMENT_PENDING', 'PAYMENT_PROOF_UPLOADED', 'MANUAL_REVIEW'))::BIGINT,
    (SELECT count(*) FROM public.profiles
      WHERE created_at >= now() - interval '7 days'
        AND (p_users_since IS NULL OR created_at > p_users_since))::BIGINT;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_notification_counts(TIMESTAMPTZ) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_notification_counts(TIMESTAMPTZ) TO   authenticated;
