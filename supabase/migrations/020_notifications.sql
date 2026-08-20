-- =============================================================================
-- XReserve Migration 020 — User & admin notifications with event wiring
-- =============================================================================
--
-- A unified notifications table for both regular users and admins.
-- Notifications are created INSIDE the same server-side transaction that
-- performs the financial operation, so a notification is never created if
-- the underlying operation rolls back.
--
--   USER notifications:
--     deposit_submitted       — submit_deposit()
--     deposit_credited        — admin_credit_verified_deposit()
--     deposit_rejected        — admin_update_deposit_status()
--     sell_order_created      — create_sell_order()
--     sell_order_completed    — admin_complete_sell_order()
--     sell_order_rejected     — admin_reject_sell_order()
--
--   ADMIN notifications:
--     new_user_signup         — handle_new_user() trigger
--     new_deposit             — submit_deposit()
--     deposit_credited        — admin_credit_verified_deposit()
--     deposit_rejected        — admin_update_deposit_status()
--     new_sell_order          — create_sell_order()
--     sell_order_completed    — admin_complete_sell_order()
--     sell_order_rejected     — admin_reject_sell_order()
--
-- Duplicate protection:
--   - reference_id column with partial unique index
--   - create_notification checks for existing (user_id, event_type, reference_id)
--   - All calls are inside the same transaction as the financial operation
--
-- Security:
--   - RLS enabled; users can only SELECT/UPDATE their own notifications
--   - INSERT is done via SECURITY DEFINER RPC (no direct client insert)
--   - No notification content is exposed to other users
-- =============================================================================

-- =============================================================================
-- PART 1 — Notifications table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  metadata    JSONB       DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id
  ON public.notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON public.notifications (user_id) WHERE read_at IS NULL;

-- RLS: enabled, policies below
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Users can only see their own notifications
CREATE POLICY notifications_select_own
  ON public.notifications FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Users can only update (mark read) their own notifications
CREATE POLICY notifications_update_own
  ON public.notifications FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- No INSERT/DELETE policy for clients — inserts go through SECURITY DEFINER RPC
-- Revoke direct access
REVOKE INSERT, DELETE ON public.notifications FROM anon, authenticated, public;
GRANT SELECT, UPDATE (read_at) ON public.notifications TO authenticated;

-- =============================================================================
-- PART 1B — reference_id column for duplicate protection
-- =============================================================================
-- reference_id stores the UUID of the source entity (deposit, sell_order, etc.)
-- The partial unique index ensures at most one notification per (user, event, ref).
-- NULL reference_ids are allowed and not constrained (for events without a source).

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS reference_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup
  ON public.notifications (user_id, event_type, reference_id)
  WHERE reference_id IS NOT NULL;

-- =============================================================================
-- PART 2 — RPC: create_notification (SECURITY DEFINER, with dedup)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_notification(
  p_user_id     UUID,
  p_event_type  TEXT,
  p_title       TEXT,
  p_description TEXT DEFAULT '',
  p_metadata    JSONB DEFAULT '{}'::jsonb,
  p_reference_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'create_notification: user_id is required';
  END IF;
  IF p_event_type IS NULL OR p_event_type = '' THEN
    RAISE EXCEPTION 'create_notification: event_type is required';
  END IF;
  IF p_title IS NULL OR p_title = '' THEN
    RAISE EXCEPTION 'create_notification: title is required';
  END IF;

  -- Dedup: if reference_id is provided, skip when identical notification exists
  IF p_reference_id IS NOT NULL THEN
    SELECT n.id INTO v_id
    FROM public.notifications n
    WHERE n.user_id = p_user_id
      AND n.event_type = p_event_type
      AND n.reference_id = p_reference_id
    LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  INSERT INTO public.notifications (user_id, event_type, title, description, metadata, reference_id)
  VALUES (p_user_id, p_event_type, p_title, p_description, p_metadata, p_reference_id)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_notification(UUID, TEXT, TEXT, TEXT, JSONB, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.create_notification(UUID, TEXT, TEXT, TEXT, JSONB, UUID) TO   authenticated;

-- =============================================================================
-- PART 2B — RPC: notify_admins (SECURITY DEFINER helper)
-- =============================================================================
-- Creates a notification for every active admin user.
-- p_exclude_user_id: skip this user (prevents self-notification on signup).

CREATE OR REPLACE FUNCTION public.notify_admins(
  p_event_type  TEXT,
  p_title       TEXT,
  p_description TEXT DEFAULT '',
  p_metadata    JSONB DEFAULT '{}'::jsonb,
  p_reference_id UUID DEFAULT NULL,
  p_exclude_user_id UUID DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_admin_id UUID;
  v_count INT := 0;
BEGIN
  FOR v_admin_id IN
    SELECT au.user_id FROM public.admin_users au
    WHERE au.is_active = true
      AND (p_exclude_user_id IS NULL OR au.user_id != p_exclude_user_id)
  LOOP
    PERFORM public.create_notification(
      v_admin_id, p_event_type, p_title, p_description, p_metadata, p_reference_id
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.notify_admins(TEXT, TEXT, TEXT, JSONB, UUID, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.notify_admins(TEXT, TEXT, TEXT, JSONB, UUID, UUID) TO   authenticated;

-- =============================================================================
-- PART 3 — RPC: get_user_notifications
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_user_notifications(
  p_limit  INT DEFAULT 20,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  id          UUID,
  event_type  TEXT,
  title       TEXT,
  description TEXT,
  metadata    JSONB,
  reference_id UUID,
  created_at  TIMESTAMPTZ,
  read_at     TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN QUERY
  SELECT n.id, n.event_type, n.title, n.description, n.metadata, n.reference_id, n.created_at, n.read_at
  FROM public.notifications n
  WHERE n.user_id = auth.uid()
  ORDER BY n.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_user_notifications(INT, INT) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.get_user_notifications(INT, INT) TO   authenticated;

-- =============================================================================
-- PART 4 — RPC: mark_notification_read
-- =============================================================================

CREATE OR REPLACE FUNCTION public.mark_notification_read(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE public.notifications
  SET read_at = now()
  WHERE id = p_id AND user_id = auth.uid();

  RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_notification_read(UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.mark_notification_read(UUID) TO   authenticated;

-- =============================================================================
-- PART 5 — RPC: mark_all_notifications_read
-- =============================================================================

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  UPDATE public.notifications
  SET read_at = now()
  WHERE user_id = auth.uid() AND read_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_all_notifications_read() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.mark_all_notifications_read() TO   authenticated;

-- =============================================================================
-- PART 6 — RPC: get_unread_notification_count
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_unread_notification_count()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  RETURN (SELECT count(*) FROM public.notifications
          WHERE user_id = auth.uid() AND read_at IS NULL);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_unread_notification_count() FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.get_unread_notification_count() TO   authenticated;

-- =============================================================================
-- PART 7 — EVENT WIRING: handle_new_user (replaces migration 007 version)
-- =============================================================================
-- Adds admin notification on new user signup.
-- p_exclude_user_id prevents self-notification if the new user is an admin.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _wallet_id UUID;
  _username TEXT;
BEGIN
  -- Extract username from metadata if present (for username/password auth)
  _username := NEW.raw_user_meta_data->>'username';
  
  -- 1. Profile
  INSERT INTO public.profiles (id, full_name, avatar_url, email, username)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'avatar_url',
    NEW.email,
    _username
  );

  -- 2. Wallet
  INSERT INTO public.wallets (user_id)
  VALUES (NEW.id)
  RETURNING id INTO _wallet_id;

  -- 3. Balance row
  INSERT INTO public.wallet_balances (wallet_id)
  VALUES (_wallet_id);

  -- 4. Notify admins about new user signup (exclude the new user themselves)
  PERFORM public.notify_admins(
    'new_user_signup',
    'New user registered',
    COALESCE(
      COALESCE(NEW.raw_user_meta_data->>'username', NEW.raw_user_meta_data->>'full_name'),
      'A new user has registered'
    ),
    jsonb_build_object('user_id', NEW.id, 'email', NEW.email),
    NEW.id,
    NEW.id
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- =============================================================================
-- PART 8 — EVENT WIRING: submit_deposit (replaces migration 011b version)
-- =============================================================================
-- Adds: user notification (deposit_submitted) + admin notification (new_deposit)
-- ALL existing logic preserved verbatim; only notification calls added after audit log.

CREATE OR REPLACE FUNCTION public.submit_deposit(
  p_network         TEXT,
  p_declared_amount NUMERIC,
  p_tx_hash         TEXT,
  p_blockchain_url  TEXT DEFAULT NULL,
  p_verification_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id         UUID := auth.uid();
  v_deposit_id      UUID;
  v_deposit_status TEXT;
  v_method_id       UUID;
  v_dest_address    TEXT;
  v_asset           TEXT;
  v_clean_url       TEXT;
  v_clean_txid      TEXT;
BEGIN
  -- 1. Authentication
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  -- 2. Validate network — derive allowed networks from active deposit methods
  SELECT dm.id, dm.deposit_address, dm.asset
  INTO v_method_id, v_dest_address, v_asset
  FROM public.deposit_methods dm
  WHERE dm.network = p_network
    AND dm.is_active = true
  LIMIT 1;

  IF v_method_id IS NULL THEN
    RAISE EXCEPTION 'No active deposit method available for this network';
  END IF;

  -- 4. Validate declared amount
  IF p_declared_amount IS NULL THEN
    RAISE EXCEPTION 'Please enter a valid USDT amount greater than zero';
  END IF;
  IF p_declared_amount <= 0 THEN
    RAISE EXCEPTION 'Please enter a valid USDT amount greater than zero';
  END IF;
  IF p_declared_amount != ROUND(p_declared_amount, 6) THEN
    RAISE EXCEPTION 'Amount has too many decimal places';
  END IF;
  IF p_declared_amount > 1000000000 THEN
    RAISE EXCEPTION 'Amount exceeds maximum allowed value';
  END IF;
  IF p_declared_amount::TEXT = 'NaN' OR p_declared_amount::TEXT ~ '^[Ii]nf' THEN
    RAISE EXCEPTION 'Invalid amount value';
  END IF;

  -- 5. Validate TXID
  v_clean_txid := NULLIF(trim(p_tx_hash), '');
  IF v_clean_txid IS NULL THEN
    RAISE EXCEPTION 'Please enter the transaction ID';
  END IF;
  IF char_length(v_clean_txid) > 256 THEN
    RAISE EXCEPTION 'Transaction ID is too long';
  END IF;

  -- 6. Validate optional blockchain URL
  v_clean_url := NULLIF(trim(p_blockchain_url), '');
  IF v_clean_url IS NOT NULL THEN
    IF char_length(v_clean_url) > 2048 THEN
      RAISE EXCEPTION 'Blockchain URL is too long';
    END IF;
    IF lower(v_clean_url) NOT LIKE 'https://%' THEN
      RAISE EXCEPTION 'Blockchain URL must use HTTPS';
    END IF;
    IF lower(v_clean_url) LIKE '%javascript:%'
       OR lower(v_clean_url) LIKE '%data:%'
       OR lower(v_clean_url) LIKE '%file:%' THEN
      RAISE EXCEPTION 'Invalid blockchain URL';
    END IF;
  END IF;

  -- 7. Require 2FA verification with user_transaction scope
  PERFORM public._require_2fa_verification(p_verification_id, 'user_transaction');

  -- 8. Insert deposit
  BEGIN
    INSERT INTO public.deposits (
      user_id,
      token,
      network,
      expected_amount,
      declared_amount,
      tx_hash,
      destination_address,
      blockchain_url,
      deposit_method_id,
      status
    )
    VALUES (
      v_user_id,
      v_asset,
      p_network,
      p_declared_amount,
      p_declared_amount,
      v_clean_txid,
      v_dest_address,
      v_clean_url,
      v_method_id,
      'PENDING_VERIFICATION'
    )
    RETURNING id, status INTO v_deposit_id, v_deposit_status;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'This transaction has already been submitted and is currently being processed. Please check Pending Transactions rather than submitting it again.';
  END;

  -- 9. Audit log
  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (
    v_user_id,
    'DEPOSIT_SUBMITTED',
    'deposit',
    v_deposit_id,
    jsonb_build_object(
      'network', p_network,
      'declared_amount', p_declared_amount,
      'asset', v_asset,
      'destination_address', v_dest_address,
      'tx_hash', v_clean_txid,
      'deposit_method_id', v_method_id,
      'status', v_deposit_status,
      'verification_id', p_verification_id,
      'blockchain_url_provided', v_clean_url IS NOT NULL
    )
  );

  -- 10. NOTIFICATIONS (user + admin)
  PERFORM public.create_notification(
    v_user_id,
    'deposit_submitted',
    'Deposit submitted',
    'DEP_ID # ' || upper(substr(v_deposit_id::text, 1, 8)) || ' · ' || p_declared_amount::text || ' ' || v_asset,
    jsonb_build_object('deposit_id', v_deposit_id, 'amount', p_declared_amount, 'asset', v_asset, 'network', p_network),
    v_deposit_id
  );
  PERFORM public.notify_admins(
    'new_deposit',
    'New deposit submitted',
    'DEP_ID # ' || upper(substr(v_deposit_id::text, 1, 8)) || ' · ' || p_declared_amount::text || ' ' || v_asset || ' via ' || p_network,
    jsonb_build_object('deposit_id', v_deposit_id, 'user_id', v_user_id, 'amount', p_declared_amount, 'asset', v_asset, 'network', p_network),
    v_deposit_id
  );

  -- 11. Return deposit info
  RETURN jsonb_build_object(
    'deposit_id', v_deposit_id,
    'status', v_deposit_status,
    'network', p_network,
    'declared_amount', p_declared_amount,
    'asset', v_asset
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_deposit(TEXT, NUMERIC, TEXT, TEXT, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.submit_deposit(TEXT, NUMERIC, TEXT, TEXT, UUID) TO   authenticated;

-- =============================================================================
-- PART 9 — EVENT WIRING: admin_credit_verified_deposit (replaces 019 version)
-- =============================================================================
-- Adds: user notification (deposit_credited) + admin notification (deposit_credited)
-- ALL 20 existing steps preserved verbatim; notification calls added after audit log.

CREATE OR REPLACE FUNCTION public.admin_credit_verified_deposit(
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
  --    manual verification of THIS deposit by THIS admin.
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

  -- 9. Verification source for the verified amount
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

  -- 21. NOTIFICATIONS (user + admin)
  PERFORM public.create_notification(
    v_deposit.user_id,
    'deposit_credited',
    'Deposit completed',
    'DEP_ID # ' || upper(substr(p_deposit_id::text, 1, 8)) || ' · ' || v_credit_amount::text || ' USDT credited to your wallet',
    jsonb_build_object('deposit_id', p_deposit_id, 'amount', v_credit_amount),
    p_deposit_id
  );
  PERFORM public.notify_admins(
    'deposit_credited',
    'Deposit credited',
    'DEP_ID # ' || upper(substr(p_deposit_id::text, 1, 8)) || ' · ' || v_credit_amount::text || ' USDT',
    jsonb_build_object('deposit_id', p_deposit_id, 'user_id', v_deposit.user_id, 'amount', v_credit_amount),
    p_deposit_id
  );

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_credit_verified_deposit(UUID, UUID, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_credit_verified_deposit(UUID, UUID, UUID) TO   authenticated;


-- =============================================================================
-- PART 10 — EVENT WIRING: admin_update_deposit_status (replaces 013 version)
-- =============================================================================
-- Adds: user notification (deposit_rejected) + admin notification (deposit_rejected)
-- ONLY when p_new_status = 'REJECTED'. Other status changes (PENDING, UNDER_REVIEW)
-- do not generate notifications.
-- ALL existing logic preserved verbatim.

CREATE OR REPLACE FUNCTION public.admin_update_deposit_status(
  p_deposit_id      UUID,
  p_new_status      TEXT,
  p_verification_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_current_status TEXT;
  v_deposit_user   UUID;
BEGIN
  -- Authorization: must be admin with admin_financial 2FA
  IF NOT public.is_admin_user() THEN RAISE EXCEPTION 'not authorized'; END IF;
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');

  -- Only non-financial status transitions are allowed through this RPC.
  IF p_new_status NOT IN ('PENDING', 'UNDER_REVIEW', 'REJECTED') THEN
    RAISE EXCEPTION 'admin_update_deposit_status: invalid status %. Use admin_credit_deposit() to credit a deposit.', p_new_status;
  END IF;

  SELECT status, user_id INTO v_current_status, v_deposit_user
  FROM public.deposits WHERE id = p_deposit_id FOR UPDATE;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'admin_update_deposit_status: deposit not found';
  END IF;
  IF v_current_status = 'CREDITED' THEN
    RAISE EXCEPTION 'admin_update_deposit_status: cannot modify credited deposit';
  END IF;
  IF v_current_status = 'REJECTED' AND p_new_status NOT IN ('PENDING', 'UNDER_REVIEW') THEN
    RAISE EXCEPTION 'admin_update_deposit_status: rejected deposit can only be set to PENDING or UNDER_REVIEW';
  END IF;

  -- Defense-in-depth
  IF v_current_status = 'PENDING_VERIFICATION' AND p_new_status = 'CREDITED' THEN
    RAISE EXCEPTION 'admin_update_deposit_status: cannot credit a PENDING_VERIFICATION deposit. Blockchain verification is required before crediting.';
  END IF;

  UPDATE public.deposits
  SET status = p_new_status, updated_at = now()
  WHERE id = p_deposit_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(),
    CASE p_new_status
      WHEN 'UNDER_REVIEW' THEN 'DEPOSIT_UNDER_REVIEW'
      WHEN 'REJECTED'     THEN 'DEPOSIT_REJECTED'
      WHEN 'PENDING'      THEN 'DEPOSIT_REOPENED'
      ELSE 'DEPOSIT_STATUS_CHANGE'
    END,
    'deposit', p_deposit_id,
    jsonb_build_object('previous_status', v_current_status, 'new_status', p_new_status, 'verification_id', p_verification_id));

  -- NOTIFICATIONS (only for REJECTED status)
  IF p_new_status = 'REJECTED' THEN
    PERFORM public.create_notification(
      v_deposit_user,
      'deposit_rejected',
      'Deposit rejected',
      'DEP_ID # ' || upper(substr(p_deposit_id::text, 1, 8)),
      jsonb_build_object('deposit_id', p_deposit_id),
      p_deposit_id
    );
    PERFORM public.notify_admins(
      'deposit_rejected',
      'Deposit rejected',
      'DEP_ID # ' || upper(substr(p_deposit_id::text, 1, 8)),
      jsonb_build_object('deposit_id', p_deposit_id, 'user_id', v_deposit_user),
      p_deposit_id
    );
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_update_deposit_status(UUID, TEXT, UUID) FROM anon, public;

-- =============================================================================
-- PART 11 — EVENT WIRING: create_sell_order (replaces migration 016 version)
-- =============================================================================
-- Adds: user notification (sell_order_created) + admin notification (new_sell_order)
-- ALL existing logic preserved verbatim; notification calls added after audit log.

CREATE OR REPLACE FUNCTION public.create_sell_order(
  p_usdt_amount     NUMERIC(18,8),
  p_bank_account_id UUID,
  p_client_token    UUID,
  p_verification_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user_id        UUID := auth.uid();
  v_bank           RECORD;
  v_wallet_id      UUID;
  v_balance_before NUMERIC(18,8);
  v_rate           NUMERIC(10,4);
  v_inr_amount     NUMERIC(18,2);
  v_order_id       UUID;
  v_existing_id    UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_sell_order: not authenticated';
  END IF;

  IF p_usdt_amount IS NULL OR p_usdt_amount <= 0 THEN
    RAISE EXCEPTION 'create_sell_order: usdt_amount must be greater than zero';
  END IF;
  IF p_client_token IS NULL THEN
    RAISE EXCEPTION 'create_sell_order: client_token is required';
  END IF;

  -- Idempotent replay
  SELECT id INTO v_existing_id
    FROM public.sell_orders
   WHERE user_id = v_user_id AND client_token = p_client_token;
  IF v_existing_id IS NOT NULL THEN
    RETURN v_existing_id;
  END IF;

  -- Consume the scoped 2FA verification token
  PERFORM public._require_2fa_verification(p_verification_id, 'user_transaction');

  -- Bank account ownership check
  SELECT bank_name, account_holder_name, account_number, ifsc_code
    INTO v_bank
    FROM public.bank_accounts
   WHERE id = p_bank_account_id
     AND user_id = v_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_sell_order: bank account not found';
  END IF;

  -- Authoritative rate is read server-side
  SELECT (s.setting_value->>'rate')::NUMERIC(10,4) INTO v_rate
    FROM public.exchange_settings s
   WHERE s.setting_key = 'platform_usdt_inr_rate';
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'create_sell_order: platform rate unavailable';
  END IF;

  v_inr_amount := round(p_usdt_amount * v_rate, 2);

  -- Lock the balance row
  SELECT wb.wallet_id, wb.available_usdt
    INTO v_wallet_id, v_balance_before
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = v_user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'create_sell_order: wallet not found';
  END IF;
  IF v_balance_before < p_usdt_amount THEN
    RAISE EXCEPTION 'create_sell_order: insufficient available balance (have %, need %)', v_balance_before, p_usdt_amount;
  END IF;

  -- Atomic debit + order creation
  UPDATE public.wallet_balances
     SET available_usdt = available_usdt - p_usdt_amount,
         reserved_usdt  = reserved_usdt + p_usdt_amount,
         updated_at     = now()
   WHERE wallet_id = v_wallet_id;

  INSERT INTO public.sell_orders
    (user_id, usdt_amount, inr_amount, exchange_rate, bank_account_id,
     bank_name, account_holder_name, account_number, ifsc_code,
     client_token, status)
  VALUES
    (v_user_id, p_usdt_amount, v_inr_amount, v_rate, p_bank_account_id,
     v_bank.bank_name, v_bank.account_holder_name, v_bank.account_number, v_bank.ifsc_code,
     p_client_token, 'PAYMENT_PENDING')
  RETURNING id INTO v_order_id;

  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'RESERVE', p_usdt_amount, v_balance_before, v_balance_before - p_usdt_amount,
          'sell_order', v_order_id, '{"direction":"available_to_reserved","context":"sell_order_creation"}'::jsonb);

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (v_user_id, 'SELL_ORDER_CREATED', 'sell_order', v_order_id,
    jsonb_build_object('usdt_amount', p_usdt_amount, 'inr_amount', v_inr_amount,
      'exchange_rate', v_rate, 'bank_account_id', p_bank_account_id,
      'client_token', p_client_token, 'verification_id', p_verification_id));

  -- NOTIFICATIONS (user + admin)
  PERFORM public.create_notification(
    v_user_id,
    'sell_order_created',
    'Sell order submitted',
    'SELL_ID # ' || upper(substr(v_order_id::text, 1, 8)) || ' · ' || p_usdt_amount::text || ' USDT',
    jsonb_build_object('order_id', v_order_id, 'usdt_amount', p_usdt_amount, 'inr_amount', v_inr_amount),
    v_order_id
  );
  PERFORM public.notify_admins(
    'new_sell_order',
    'New sell order',
    'SELL_ID # ' || upper(substr(v_order_id::text, 1, 8)) || ' · ' || p_usdt_amount::text || ' USDT',
    jsonb_build_object('order_id', v_order_id, 'user_id', v_user_id, 'usdt_amount', p_usdt_amount, 'inr_amount', v_inr_amount),
    v_order_id
  );

  RETURN v_order_id;

EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'create_sell_order: duplicate submission';
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_sell_order(NUMERIC, UUID, UUID, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.create_sell_order(NUMERIC, UUID, UUID, UUID) TO   authenticated;

-- =============================================================================
-- PART 12 — EVENT WIRING: admin_complete_sell_order (replaces 006 version)
-- =============================================================================
-- Adds: user notification (sell_order_completed) + admin notification (sell_order_completed)
-- ALL existing logic preserved verbatim; notification calls added after audit log.

CREATE OR REPLACE FUNCTION public.admin_complete_sell_order(
  p_order_id        UUID,
  p_verification_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_order     RECORD;
  v_wallet_id UUID;
  v_reserved  NUMERIC(18,8);
BEGIN
  IF NOT public.is_admin_user() THEN RAISE EXCEPTION 'not authorized'; END IF;
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');

  SELECT * INTO v_order FROM public.sell_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'admin_complete_sell_order: order not found';
  END IF;
  IF v_order.status NOT IN ('PAYMENT_PENDING', 'PAYMENT_PROOF_UPLOADED', 'MANUAL_REVIEW') THEN
    RAISE EXCEPTION 'admin_complete_sell_order: invalid status %', v_order.status;
  END IF;

  SELECT wb.wallet_id, wb.reserved_usdt
    INTO v_wallet_id, v_reserved
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = v_order.user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'admin_complete_sell_order: wallet not found';
  END IF;
  IF v_reserved < v_order.usdt_amount THEN
    RAISE EXCEPTION 'admin_complete_sell_order: insufficient reserved balance (have %, need %)', v_reserved, v_order.usdt_amount;
  END IF;

  UPDATE public.wallet_balances
     SET reserved_usdt = reserved_usdt - v_order.usdt_amount, updated_at = now()
   WHERE wallet_id = v_wallet_id;

  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'CONSUME', v_order.usdt_amount, v_reserved, v_reserved - v_order.usdt_amount, 'sell_order', p_order_id, '{"direction":"reserved_subtracted","context":"sell_completed"}'::jsonb);

  UPDATE public.sell_orders SET status = 'COMPLETED', updated_at = now() WHERE id = p_order_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(), 'SELL_COMPLETED', 'sell_order', p_order_id,
    jsonb_build_object('previous_status', v_order.status, 'new_status', 'COMPLETED', 'usdt_amount', v_order.usdt_amount, 'inr_amount', v_order.inr_amount, 'user_id', v_order.user_id, 'verification_id', p_verification_id));

  -- NOTIFICATIONS (user + admin)
  PERFORM public.create_notification(
    v_order.user_id,
    'sell_order_completed',
    'Sell order completed',
    'SELL_ID # ' || upper(substr(p_order_id::text, 1, 8)) || ' · ' || v_order.usdt_amount::text || ' USDT',
    jsonb_build_object('order_id', p_order_id, 'usdt_amount', v_order.usdt_amount, 'inr_amount', v_order.inr_amount),
    p_order_id
  );
  PERFORM public.notify_admins(
    'sell_order_completed',
    'Sell order completed',
    'SELL_ID # ' || upper(substr(p_order_id::text, 1, 8)) || ' · ' || v_order.usdt_amount::text || ' USDT',
    jsonb_build_object('order_id', p_order_id, 'user_id', v_order.user_id, 'usdt_amount', v_order.usdt_amount),
    p_order_id
  );

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_complete_sell_order(UUID, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_complete_sell_order(UUID, UUID) TO   authenticated;

-- =============================================================================
-- PART 13 — EVENT WIRING: admin_reject_sell_order (replaces 006 version)
-- =============================================================================
-- Adds: user notification (sell_order_rejected) + admin notification (sell_order_rejected)
-- ALL existing logic preserved verbatim; notification calls added after audit log.

CREATE OR REPLACE FUNCTION public.admin_reject_sell_order(
  p_order_id        UUID,
  p_status          TEXT DEFAULT 'CANCELLED',
  p_verification_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_order     RECORD;
  v_wallet_id UUID;
  v_reserved  NUMERIC(18,8);
  v_available NUMERIC(18,8);
BEGIN
  IF NOT public.is_admin_user() THEN RAISE EXCEPTION 'not authorized'; END IF;
  PERFORM public._require_admin_2fa(p_verification_id, 'admin_financial');

  IF p_status NOT IN ('CANCELLED', 'REJECTED') THEN
    RAISE EXCEPTION 'admin_reject_sell_order: status must be CANCELLED or REJECTED';
  END IF;

  SELECT * INTO v_order FROM public.sell_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RAISE EXCEPTION 'admin_reject_sell_order: order not found';
  END IF;
  IF v_order.status NOT IN ('PAYMENT_PENDING', 'PAYMENT_PROOF_UPLOADED', 'MANUAL_REVIEW') THEN
    RAISE EXCEPTION 'admin_reject_sell_order: invalid status %', v_order.status;
  END IF;

  SELECT wb.wallet_id, wb.reserved_usdt, wb.available_usdt
    INTO v_wallet_id, v_reserved, v_available
    FROM public.wallets w
    JOIN public.wallet_balances wb ON wb.wallet_id = w.id
   WHERE w.user_id = v_order.user_id
     FOR UPDATE OF wb;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'admin_reject_sell_order: wallet not found';
  END IF;
  IF v_reserved < v_order.usdt_amount THEN
    RAISE EXCEPTION 'admin_reject_sell_order: insufficient reserved balance (have %, need %)', v_reserved, v_order.usdt_amount;
  END IF;

  UPDATE public.wallet_balances
     SET reserved_usdt  = reserved_usdt - v_order.usdt_amount,
         available_usdt = available_usdt + v_order.usdt_amount,
         updated_at = now()
   WHERE wallet_id = v_wallet_id;

  INSERT INTO public.ledger_entries
    (wallet_id, entry_type, amount, balance_before, balance_after, reference_type, reference_id, metadata)
  VALUES (v_wallet_id, 'RELEASE', v_order.usdt_amount, v_available, v_available + v_order.usdt_amount, 'sell_order', p_order_id, ('{"direction":"reserved_to_available","context":"sell_' || lower(p_status) || '"}')::jsonb);

  UPDATE public.sell_orders SET status = p_status, updated_at = now() WHERE id = p_order_id;

  INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, metadata)
  VALUES (auth.uid(),
    CASE p_status WHEN 'CANCELLED' THEN 'SELL_CANCELLED' ELSE 'SELL_REJECTED' END,
    'sell_order', p_order_id,
    jsonb_build_object('previous_status', v_order.status, 'new_status', p_status, 'usdt_amount', v_order.usdt_amount, 'user_id', v_order.user_id, 'verification_id', p_verification_id));

  -- NOTIFICATIONS (user + admin)
  PERFORM public.create_notification(
    v_order.user_id,
    'sell_order_rejected',
    CASE p_status WHEN 'CANCELLED' THEN 'Sell order cancelled' ELSE 'Sell order rejected' END,
    'SELL_ID # ' || upper(substr(p_order_id::text, 1, 8)) || ' · ' || v_order.usdt_amount::text || ' USDT',
    jsonb_build_object('order_id', p_order_id, 'usdt_amount', v_order.usdt_amount, 'status', p_status),
    p_order_id
  );
  PERFORM public.notify_admins(
    'sell_order_rejected',
    CASE p_status WHEN 'CANCELLED' THEN 'Sell order cancelled' ELSE 'Sell order rejected' END,
    'SELL_ID # ' || upper(substr(p_order_id::text, 1, 8)) || ' · ' || v_order.usdt_amount::text || ' USDT',
    jsonb_build_object('order_id', p_order_id, 'user_id', v_order.user_id, 'usdt_amount', v_order.usdt_amount, 'status', p_status),
    p_order_id
  );

  RETURN TRUE;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.admin_reject_sell_order(UUID, TEXT, UUID) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.admin_reject_sell_order(UUID, TEXT, UUID) TO   authenticated;

-- =============================================================================
-- PART 14 — admin_notification_counts (badge counts — unchanged from 019)
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

-- =============================================================================
-- MIGRATION 020 COMPLETE
-- =============================================================================
