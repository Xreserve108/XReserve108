-- =============================================================================
-- XReserve Migration 018 — Independent manual verification path for deposits
-- =============================================================================
--
-- BACKGROUND:
--   admin_manually_verify_deposit (014b) hard-requires
--   blockchain_verified_at IS NOT NULL and verified_amount IS NOT NULL,
--   so a PENDING_VERIFICATION deposit with 0 blockchain verification
--   attempts could never be manually verified by an admin — the only
--   available action was rejection.
--
--   Blockchain verification and manual admin verification must be
--   INDEPENDENT paths. An authorized admin must be able to manually
--   verify a pending deposit even when blockchain verification has not
--   run or has failed.
--
-- SECURITY CHANGES (net strengthening, nothing weakened):
--   1. Manual verification now REQUIRES admin_financial 2FA
--      (_require_admin_2fa, single-use verification token) — the old
--      version intentionally had no 2FA; making manual verification an
--      independent override path requires this gate.
--   2. The blockchain_verified_at / verified_amount preconditions are
--      removed so the manual path is independent of blockchain state.
--   3. MANUAL OVERRIDE AMOUNT: when blockchain verification has NOT
--      established verified_amount, the admin may establish it as part
--      of manual verification (p_manual_verified_amount). The value is
--      validated server-side (> 0), written to the locked deposit row,
--      and marked metadata verified_amount_source = 'manual_override'.
--      A manual amount is NEVER accepted when blockchain verification
--      already established verified_amount (blockchain truth wins).
--   4. admin_credit_verified_deposit precondition change (ONLY change):
--      the hard blockchain_verified_at requirement becomes
--      "blockchain_verified_at IS NOT NULL
--       OR metadata->>'verified_amount_source' = 'manual_override'".
--      Every other check is preserved — the credit amount ALWAYS comes
--      from the locked DB verified_amount; no client-supplied credit
--      amount is accepted.
--
-- PRESERVED UNCHANGED FROM 014b:
--   - is_admin_user() authorization
--   - Mandatory 8-item checklist (all keys must be TRUE)
--   - Deposit row locking (SELECT ... FOR UPDATE)
--   - PENDING_VERIFICATION status requirement
--   - Phase 14 marker requirement (deposit_method_id IS NOT NULL)
--   - Idempotency guard (already manually verified → reject)
--   - Already-credited guard
--   - Audit log entry DEPOSIT_MANUALLY_VERIFIED
--   - No wallet write: this RPC never moves money. The financial credit
--     path (admin_credit_verified_deposit, admin_financial 2FA,
--     DB-derived verified_amount, FOR UPDATE locking, atomic wallet +
--     ledger + status update, CREDITED idempotency) is preserved.
--
-- NOTE: signature changes (p_verification_id + p_manual_verified_amount
--       added), therefore the old overload is dropped and recreated.
--       The only caller is the admin deposits UI (src/admin/deposits.js),
--       updated accordingly. admin_credit_verified_deposit keeps its
--       signature, so CREATE OR REPLACE is sufficient and its grants are
--       preserved.
-- =============================================================================

DROP FUNCTION IF EXISTS public.admin_manually_verify_deposit(UUID, JSONB, TEXT);

CREATE OR REPLACE FUNCTION public.admin_manually_verify_deposit(
  p_deposit_id             UUID,
  p_checklist              JSONB,
  p_notes                  TEXT    DEFAULT NULL,
  p_verification_id        UUID    DEFAULT NULL,
  p_manual_verified_amount NUMERIC DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_deposit  RECORD;
  v_admin_id UUID := auth.uid();
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
  -- This function only operates on Phase 14 deposits.
  IF v_deposit.deposit_method_id IS NULL THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit has no deposit method (not a Phase 14 deposit)';
  END IF;

  -- NOTE: no blockchain_verified_at / verified_amount precondition here.
  -- Manual verification is independent of blockchain verification state.

  -- Idempotency: if already manually verified, reject
  IF v_deposit.manually_verified_at IS NOT NULL THEN
    RAISE EXCEPTION 'admin_manually_verify_deposit: deposit has already been manually verified';
  END IF;

  -- MANUAL OVERRIDE AMOUNT validation (server-side, client value is never
  -- trusted): only allowed when blockchain verification has NOT already
  -- established verified_amount. The blockchain-derived amount is the
  -- authoritative value and can never be overwritten by this RPC.
  IF p_manual_verified_amount IS NOT NULL THEN
    IF v_deposit.blockchain_verified_at IS NOT NULL OR v_deposit.verified_amount IS NOT NULL THEN
      RAISE EXCEPTION 'admin_manually_verify_deposit: manual amount is not allowed — blockchain verification has already established the verified amount';
    END IF;
    IF p_manual_verified_amount <= 0 THEN
      RAISE EXCEPTION 'admin_manually_verify_deposit: manual verified amount must be greater than 0';
    END IF;
  END IF;

  -- Record manual verification. When a manual override amount is provided,
  -- it is written to verified_amount here (on the locked row) and marked
  -- with provenance so the credit RPC can admit it. The subsequent credit
  -- reads ONLY this DB-stored value under FOR UPDATE.
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
      'checklist', p_checklist
    )
  );

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_manually_verify_deposit(UUID, JSONB, TEXT, UUID, NUMERIC) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_manually_verify_deposit(UUID, JSONB, TEXT, UUID, NUMERIC) TO   authenticated;

-- =============================================================================
-- 2. admin_credit_verified_deposit — minimal precondition change.
--
--    014b step 9 hard-required blockchain_verified_at IS NOT NULL, which
--    made a manually-overridden deposit uncreditable. The requirement is
--    now: blockchain verification completed OR a 2FA-gated manual override
--    established the amount (metadata verified_amount_source =
--    'manual_override').
--
--    EVERYTHING ELSE IS UNCHANGED:
--    - is_admin_user() + admin_financial 2FA (_require_admin_2fa)
--    - PENDING_VERIFICATION + Phase 14 marker requirements
--    - manual verification + full 8-item checklist re-validation
--    - verified_amount > 0 requirement
--    - credit amount derived EXCLUSIVELY from locked DB verified_amount;
--      no client-supplied credit amount is accepted
--    - SELECT FOR UPDATE on deposit + wallet balance
--    - atomic wallet credit + CREDIT ledger entry + status CREDITED
--    - CREDITED idempotency protection
--    - audit entry DEPOSIT_CREDITED
--
--    Signature is unchanged (UUID, UUID), so CREATE OR REPLACE preserves
--    the existing grants and the sole caller (admin deposits UI).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_credit_verified_deposit(
  p_deposit_id      UUID,
  p_verification_id UUID
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
BEGIN
  -- 1. Authentication
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- 2. Authorization: must be admin
  IF NOT public.is_admin_user() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- 3. admin_financial 2FA verification
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');

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
  -- This function only operates on Phase 14 deposits.
  IF v_deposit.deposit_method_id IS NULL THEN
    RAISE EXCEPTION 'admin_credit_verified_deposit: deposit has no deposit method (not a Phase 14 deposit)';
  END IF;

  -- 9. Verification source for the verified amount: blockchain
  --    verification completed, OR an admin_financial-2FA-gated manual
  --    override established the amount. (Only precondition changed.)
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
  --     No client-supplied amount is accepted. This is the authoritative value.
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
            'verification_id', p_verification_id
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
           'credit_function', 'admin_credit_verified_deposit'
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
      'credit_function', 'admin_credit_verified_deposit',
      'blockchain_verified_at', v_deposit.blockchain_verified_at,
      'manually_verified_at', v_deposit.manually_verified_at
    ));

  RETURN TRUE;
END;
$$;

-- Signature unchanged; re-assert explicit privilege posture.
REVOKE EXECUTE ON FUNCTION public.admin_credit_verified_deposit(UUID, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_credit_verified_deposit(UUID, UUID) TO   authenticated;
