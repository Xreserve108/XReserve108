# Database Schema

All database objects live in PostgreSQL via Supabase. The schema is managed through sequential migration files in `supabase/migrations/`, currently through migration 043.

---

## Tables

### `profiles`
User profiles, auto-created on signup via trigger.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | References `auth.users(id)` ON DELETE CASCADE |
| `full_name` | TEXT | From username signup metadata; user-editable profile name |
| `avatar_url` | TEXT | Optional profile avatar |
| `email` | TEXT | Internal Supabase Auth identity; username accounts use a synthetic address |
| `username` | TEXT | UNIQUE, case-insensitive login identifier (Phase 10A) |
| `created_at` | TIMESTAMPTZ | Auto |
| `updated_at` | TIMESTAMPTZ | Auto-updated via trigger |

**RLS**: Users can SELECT and UPDATE only their own row (`auth.uid() = id`).

---

### `wallets`
One wallet per user, auto-created on signup.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID UNIQUE FK | References `profiles(id)` ON DELETE CASCADE |
| `created_at` | TIMESTAMPTZ | Auto |

**RLS**: Users can SELECT only their own wallet.

---

### `wallet_balances`
Tracks available and reserved USDT per wallet.

| Column | Type | Notes |
|---|---|---|
| `wallet_id` | UUID PK FK | References `wallets(id)` ON DELETE CASCADE |
| `available_usdt` | NUMERIC(18,8) | CHECK >= 0, default 0 |
| `reserved_usdt` | NUMERIC(18,8) | CHECK >= 0, default 0 |
| `updated_at` | TIMESTAMPTZ | Auto |

**RLS**: Users can SELECT only their own wallet balance (via join to `wallets.user_id`).

---

### `ledger_entries`
Immutable double-entry ledger. Append-only.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `wallet_id` | UUID FK | References `wallets(id)` |
| `entry_type` | TEXT | `RESERVE`, `CREDIT`, `RELEASE`, `CONSUME` |
| `amount` | NUMERIC(18,8) | CHECK > 0 |
| `balance_before` | NUMERIC(18,8) | Snapshot before operation |
| `balance_after` | NUMERIC(18,8) | Snapshot after operation |
| `reference_type` | TEXT | e.g., `sell_order`, `deposit` |
| `reference_id` | UUID | FK to related entity |
| `metadata` | JSONB | Additional context |
| `created_at` | TIMESTAMPTZ | Auto, indexed DESC |

**Protection**: A `BEFORE UPDATE OR DELETE` trigger (`trg_block_ledger_mutation`) raises an exception on any mutation attempt. Ledger is append-only.

**RLS**: Users can SELECT only their own entries. No INSERT/UPDATE/DELETE policies — all writes are server-side via `SECURITY DEFINER` functions.

---

### `deposits`
Tracks user deposit requests with blockchain verification support.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID FK | References `profiles(id)` |
| `network` | TEXT | e.g., `TRC20`, `BEP20` |
| `token` | TEXT | Default `USDT` |
| `expected_amount` | NUMERIC(18,8) | CHECK > 0 |
| `actual_amount` | NUMERIC(18,8) | Set when credited |
| `tx_hash` | TEXT | Blockchain transaction hash |
| `status` | TEXT | `PENDING`, `PENDING_VERIFICATION`, `UNDER_REVIEW`, `CREDITED`, `REJECTED` |
| `metadata` | JSONB | Default `{}` |
| `destination_address` | TEXT | Server-resolved deposit address (Phase 12C) |
| `blockchain_url` | TEXT | Optional HTTPS blockchain explorer URL (Phase 12C) |
| `declared_amount` | NUMERIC(18,6) | User-declared amount — declarative only (Phase 12C) |
| `verified_amount` | NUMERIC(18,6) | On-chain verified amount — NULL until verified (Phase 12C) |
| `deposit_method_id` | UUID | FK to `deposit_methods` at time of submission (Phase 12C) |
| `created_at` | TIMESTAMPTZ | Auto |
| `updated_at` | TIMESTAMPTZ | Auto-updated |

**Indexes**:
- `user_id` — user lookup
- `status` — status filter
- `idx_deposits_tx_hash_per_network` — partial unique index on `(network, tx_hash)` WHERE tx_hash IS NOT NULL AND non-empty (Phase 12C, replaces global unique index)
- `idx_deposits_user_status_pending` — partial index on `(user_id, status)` WHERE status IN ('PENDING', 'PENDING_VERIFICATION')

**Constraints**:
- `deposits_status_check` — CHECK status IN allowed values
- `chk_declared_amount_positive` — CHECK declared_amount IS NULL OR > 0
- `chk_blockchain_url_scheme` — CHECK blockchain_url IS NULL OR empty OR starts with `https://`
- `chk_verified_amount_positive` — CHECK verified_amount IS NULL OR > 0 (Phase 14)

**RLS**: Users can SELECT only their own deposits.

---

### `deposit_methods`
Admin-configurable deposit method registry (Phase 12A).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `network` | TEXT | CHECK IN ('TRC20', 'BEP20') |
| `asset` | TEXT | Default `USDT` |
| `deposit_address` | TEXT | The address users send to |
| `is_active` | BOOLEAN | Default `false` |
| `created_by` | UUID FK | References `auth.users(id)` |
| `updated_by` | UUID FK | References `auth.users(id)` |
| `created_at` | TIMESTAMPTZ | Auto |
| `updated_at` | TIMESTAMPTZ | Auto-updated via trigger |

**Indexes**:
- `idx_deposit_methods_one_active_per_network` — partial unique index on `(network)` WHERE `is_active = true` (at most 1 active method per network)

**Constraints**:
- `chk_deposit_method_network` — network whitelist
- `chk_deposit_method_asset` — asset must be non-empty
- `chk_active_method_has_address` — active method must have a non-empty deposit address

**RLS**: Authenticated users can SELECT active methods. Admins can SELECT all methods. All client INSERT/UPDATE/DELETE revoked — writes go through admin RPC functions.

---

### `sell_orders`
Tracks user sell orders (USDT → INR).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID FK | References `profiles(id)` |
| `usdt_amount` | NUMERIC(18,8) | CHECK > 0 |
| `inr_amount` | NUMERIC(18,2) | CHECK > 0 |
| `exchange_rate` | NUMERIC(10,4) | CHECK > 0 |
| `bank_name` | TEXT | User's bank |
| `account_holder_name` | TEXT | Account name |
| `account_number` | TEXT | Bank account number |
| `ifsc_code` | TEXT | IFSC code |
| `status` | TEXT | `PAYMENT_PENDING`, `PAYMENT_PROOF_UPLOADED`, `COMPLETED`, `CANCELLED`, `REJECTED`, `MANUAL_REVIEW` |
| `created_at` | TIMESTAMPTZ | Auto |
| `updated_at` | TIMESTAMPTZ | Auto-updated |

**Indexes**: `user_id`, `status`.

**RLS**: Users can SELECT only their own orders.

---

### `exchange_settings`
Key-value store for platform configuration.

| Column | Type | Notes |
|---|---|---|
| `setting_key` | TEXT PK | e.g., `platform_usdt_inr_rate`, `sell_limits` |
| `setting_value` | JSONB | Configuration value |
| `updated_at` | TIMESTAMPTZ | Auto |

**Seeded defaults**:
- `platform_usdt_inr_rate`: `{"rate": 92.00}`
- `sell_limits`: `{"min_usdt": 100, "max_usdt": 50000}`

**Access**: All client roles revoked. Server-side only.

---

### `admin_users`
Tracks which users have admin privileges (hardened in Phase 11).

| Column | Type | Notes |
|---|---|---|
| `user_id` | UUID PK FK | References `auth.users(id)` |
| `role` | TEXT | `super_admin` (only valid value; CHECK constraint since Migration 008) |
| `is_active` | BOOLEAN | Default `true` |
| `created_by` | UUID FK | References `auth.users(id)` |
| `created_at` | TIMESTAMPTZ | Auto |
| `updated_at` | TIMESTAMPTZ | Auto |

**RLS**: Active admin can SELECT own row. No UPDATE policy (original policy dropped in Migrations 008/021; admin management via `add_admin` RPC only).

---

### `audit_logs`
Immutable log of all significant actions.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `actor_id` | UUID FK | References `auth.users(id)` ON DELETE SET NULL |
| `action` | TEXT | e.g., `DEPOSIT_SUBMITTED`, `DEPOSIT_CREDITED`, `SELL_COMPLETED` |
| `target_type` | TEXT | e.g., `deposit`, `sell_order`, `user_2fa`, `deposit_method` |
| `target_id` | UUID | Related entity |
| `metadata` | JSONB | Action details |
| `created_at` | TIMESTAMPTZ | Auto, indexed DESC |

**Access**: All client roles revoked. Written by `SECURITY DEFINER` functions only.

---

### `notifications`
User and admin notification system (Phase 20).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID FK | References `profiles(id)` ON DELETE CASCADE |
| `event_type` | TEXT | Notification type (see below) |
| `title` | TEXT | Short notification title |
| `description` | TEXT | Detailed notification message |
| `metadata` | JSONB | Additional context (default `{}`) |
| `reference_id` | UUID | Source entity UUID (deposit_id, sell_order_id, etc.) for deduplication |
| `created_at` | TIMESTAMPTZ | Auto |
| `read_at` | TIMESTAMPTZ | When user marked as read |

**Event Types**:

| User Events | Admin Events |
|---|---|
| `deposit_submitted` | `new_user_signup` |
| `deposit_credited` | `new_deposit` |
| `deposit_rejected` | `deposit_credited` |
| `sell_order_created` | `deposit_rejected` |
| `sell_order_completed` | `new_sell_order` |
| `sell_order_rejected` | `sell_order_completed` |
| | `sell_order_rejected` |

**Indexes**:
- `idx_notifications_user_id` — `(user_id, created_at DESC)` for user notification lists
- `idx_notifications_unread` — partial index on `(user_id)` WHERE `read_at IS NULL`
- `idx_notifications_dedup` — partial unique index on `(user_id, event_type, reference_id)` WHERE `reference_id IS NOT NULL` (prevents duplicate notifications)

**RLS**: Users can SELECT and UPDATE (mark read) only their own notifications. INSERT/DELETE revoked from all client roles — notifications created via `SECURITY DEFINER` RPC functions only.

**Duplicate Protection**: The partial unique index ensures at most one notification per `(user_id, event_type, reference_id)`. NULL `reference_id` values are not constrained (for events without a source entity).

---

### `user_2fa`
TOTP two-factor authentication records.

| Column | Type | Notes |
|---|---|---|
| `user_id` | UUID PK FK | References `auth.users(id)` |
| `encrypted_secret` | TEXT | AES-256-GCM encrypted TOTP secret |
| `enabled` | BOOLEAN | Default `false` |
| `key_version` | INTEGER | Default `1` |
| `failed_attempts` | INTEGER | Default `0` |
| `locked_until` | TIMESTAMPTZ | Lockout timestamp |
| `last_verified_at` | TIMESTAMPTZ | Last successful verification |
| `last_code_hash` | TEXT | SHA-256 of last code (replay prevention) |
| `created_at` | TIMESTAMPTZ | Auto |
| `updated_at` | TIMESTAMPTZ | Auto |

**Access**: All client roles revoked. Managed by Edge Functions via service-role client.

---

### `recovery_codes`
One-time recovery codes for 2FA fallback.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID FK | References `auth.users(id)` |
| `code_hash` | TEXT | SHA-256 hash of the recovery code |
| `used` | BOOLEAN | Default `false` |
| `used_at` | TIMESTAMPTZ | When consumed |
| `created_at` | TIMESTAMPTZ | Auto |

**Access**: All client roles revoked.

---

### `user_2fa_verifications`
Single-use verification tokens issued after successful Authenticator or Passkey action verification.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID FK | References `auth.users(id)` |
| `verified_at` | TIMESTAMPTZ | Auto |
| `expires_at` | TIMESTAMPTZ | Typically 5 minutes after creation |
| `used` | BOOLEAN | Default `false` |
| `operation_scope` | TEXT | `user_transaction`, `admin_financial`, `admin_settings`, or `passkey_enrollment` |
| `used_at` | TIMESTAMPTZ | When atomically consumed |
| `source_challenge_id` | UUID | Passkey challenge identifier; nullable for TOTP, uniquely indexed when present |

**Consumption rules**: `_consume_verification_token(p_token_id, p_required_scope)` locks the row, requires `auth.uid()` ownership, rejects expired/used tokens, enforces exact scope matching, and marks the token used in the same transaction. An internal variant `_consume_verification_token_internal(p_token_id, p_required_scope, p_user_id)` accepts an explicit user ID for Edge Functions that call via `serviceClient()` (Migration 043); it preserves all security semantics (ownership, expiry, replay, scope) without requiring `auth.uid()` context.

**Access**: Client access is revoked; tokens are created by security Edge Functions and consumed by internal database helpers.

---

### `passkey_enrollment_authorizations`
Short-lived server-side authorization for inserts into `auth.webauthn_credentials`.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID FK | References `auth.users(id)` ON DELETE CASCADE |
| `created_at` | TIMESTAMPTZ | Auto |
| `expires_at` | TIMESTAMPTZ | Two-minute signup or five-minute existing/legacy window |
| `consumed_at` | TIMESTAMPTZ | Set atomically by the credential insert trigger |
| `verification_method` | TEXT | `totp`, `passkey`, or `signup` |
| `is_signup` | BOOLEAN | Marks signup/mandatory first-factor authorization |

**Access**: RLS enabled with no client policies. `service_role` may insert; `supabase_auth_admin` may select and update only `consumed_at` for trigger execution.

---

### `factor_removal_receipts` (Phase 28)
Short-lived receipts bridging cross-system factor removal (PostgreSQL TOTP + GoTrue passkeys). Used by `_authorize_factor_removal` to enforce the 2FA invariant under concurrent requests.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID FK | References `auth.users(id)` ON DELETE CASCADE |
| `factor_type` | TEXT | `passkey` or `totp` (CHECK constraint) |
| `passkeys_remaining` | INTEGER NULL | For passkey deletion: count after deletion; NULL for TOTP |
| `completed` | BOOLEAN | Default false; set true after GoTrue operation |
| `created_at` | TIMESTAMPTZ | Auto; 10-minute TTL for expiration |

**Access**: RLS enabled. All client roles (`anon`, `authenticated`, `public`) explicitly revoked. Only `postgres` and `service_role` retain grants. All access is through `SECURITY DEFINER` RPCs (`_authorize_factor_removal`, `_cleanup_factor_removal_receipt`).

---

### `login_assurance`
Session-bound records proving 2FA completion for a specific browser session (Phase 22/23).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID FK | References `auth.users(id)` ON DELETE CASCADE |
| `session_id` | TEXT | Supabase JWT `session_id` claim |
| `created_at` | TIMESTAMPTZ | Auto |

**Indexes**: Unique on `(user_id, session_id)` — at most one assurance per user per session.

**Access**: All client roles revoked from INSERT/UPDATE/DELETE. Authenticated users can SELECT via `check_login_assurance` RPC (SECURITY DEFINER). Written by `establish_login_assurance` and `establish_login_assurance_direct` (SECURITY DEFINER).

### `auth.webauthn_credentials`
Supabase Auth owns the Passkey credential table. XReserve does not redefine its schema. Migration 036 adds an `AFTER INSERT` trigger requiring an active enrollment authorization for `NEW.user_id`.

---

### `support_agent_status`
Agent availability for live support chat (Phase 22, hardened Phase 23).

| Column | Type | Notes |
|---|---|---|
| `agent_id` | UUID PK FK | References `auth.users(id)` ON DELETE CASCADE |
| `status` | TEXT | `AVAILABLE`, `BUSY`, `OFFLINE` (default `OFFLINE`) |
| `max_chats` | INT | Default `3`, CHECK > 0 AND <= 10 |
| `last_heartbeat_at` | TIMESTAMPTZ | Default `now()`, updated by heartbeat RPC (Phase 23) |
| `updated_at` | TIMESTAMPTZ | Auto |

**RLS**: Agents can SELECT only their own row (`agent_id = auth.uid()`). All writes through `SECURITY DEFINER` RPCs.

---

### `support_chat_sessions`
Chat sessions between users and admin agents (Phase 22).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID FK | References `auth.users(id)` ON DELETE CASCADE |
| `agent_id` | UUID FK | References `auth.users(id)` ON DELETE SET NULL |
| `status` | TEXT | `WAITING`, `ACTIVE`, `ENDED`, `ABANDONED` (default `WAITING`) |
| `queue_position` | INT | Position in queue (computed) |
| `connected_at` | TIMESTAMPTZ | When agent connected |
| `ended_at` | TIMESTAMPTZ | When chat ended |
| `created_at` | TIMESTAMPTZ | Auto |
| `updated_at` | TIMESTAMPTZ | Auto-updated via trigger |
| `user_unread_count` | INT | Default `0` |
| `admin_unread_count` | INT | Default `0` |
| `last_user_read_at` | TIMESTAMPTZ | Last user read timestamp |
| `last_admin_read_at` | TIMESTAMPTZ | Last admin read timestamp |

**Indexes**:
- `idx_chat_sessions_user_id` — `(user_id, created_at DESC)`
- `idx_chat_sessions_agent_id` — `(agent_id)` WHERE `status = 'ACTIVE'`
- `idx_chat_sessions_waiting` — `(created_at ASC)` WHERE `status = 'WAITING'`
- `idx_chat_sessions_status` — `(status)`
- `uq_chat_sessions_one_active_per_user` — partial unique index on `(user_id)` WHERE `status IN ('WAITING', 'ACTIVE')` (Phase 23)

**RLS**: Authenticated users can SELECT sessions where they are the user or the agent. All writes through `SECURITY DEFINER` RPCs.

---

### `support_chat_messages`
Individual messages within chat sessions (Phase 22).

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `session_id` | UUID FK | References `support_chat_sessions(id)` ON DELETE CASCADE |
| `sender_id` | UUID FK | References `auth.users(id)` |
| `sender_type` | TEXT | `user` or `admin` |
| `body` | TEXT | CHECK length > 0 AND <= 4000 |
| `created_at` | TIMESTAMPTZ | Auto |
| `read_at` | TIMESTAMPTZ | When message was read |

**Indexes**:
- `idx_chat_messages_session_id` — `(session_id, created_at ASC)`

**Realtime**: Added to `supabase_realtime` publication for live message delivery.

**RLS**: Authenticated users can SELECT messages belonging to sessions they participate in (user or agent). All inserts through `SECURITY DEFINER` RPCs.

---

## RPC Functions

### User-Facing (authenticated users can call)

| Function | Purpose | 2FA Required |
|---|---|---|
| `get_2fa_status()` | Check if 2FA is enabled | No |
| `is_admin_user()` | Check if current user is admin | No |
| `submit_deposit(network, declared_amount, tx_hash, blockchain_url, verification_id)` | Submit deposit claim (Phase 12C) | Yes (`user_transaction` verification token) |
| `get_user_pending_deposits()` | List user's pending verification deposits (Phase 12C) | No (auth required) |
| `create_sell_order(..., verification_id)` | Create sell order with reserved USDT | Yes (`user_transaction` verification token) |
| `get_active_deposit_methods()` | List active deposit methods (Phase 12A) | No (auth required) |
| `get_user_notifications(limit, offset)` | List user's notifications (paginated) | No (auth required) |
| `mark_notification_read(id)` | Mark a notification as read | No (auth required) |
| `mark_all_notifications_read()` | Mark all user notifications as read | No (auth required) |
| `get_unread_notification_count()` | Get count of unread notifications | No (auth required) |

### Login Assurance

| Function | Purpose | Auth |
|---|---|---|
| `establish_login_assurance(p_session_id, p_verification_token DEFAULT NULL, p_user_id DEFAULT NULL)` | Consume verification token and create session-bound assurance record. Single signature (Migration 041 resolved overloads). `p_user_id` required from service-role Edge Functions; defaults to `auth.uid()` when NULL. | SECURITY DEFINER |
| `establish_login_assurance_direct(p_session_id, p_user_id DEFAULT NULL)` | Create assurance without token consumption (enrollment/Passkey paths). Single signature (Migration 041 resolved overloads). `p_user_id` required from service-role Edge Functions; defaults to `auth.uid()` when NULL. | SECURITY DEFINER |
| `check_login_assurance(p_session_id)` | Verify valid assurance exists for the session | Authenticated (called from frontend) |
| `revoke_login_assurance()` | Remove current user's assurance records | Authenticated |

### Live Support Chat (authenticated users)

| Function | Purpose | Admin Only |
|---|---|---|
| `support_get_chat_availability()` | Agent count, queue size, wait estimate (excludes stale agents) | No |
| `support_start_live_chat()` | Start or resume a chat session (auto-assigns fresh-heartbeat agents) | No |
| `support_get_user_active_chat()` | Get user's current ACTIVE/WAITING chat | No |
| `support_get_user_queue_position(session_id)` | Get user's position in the queue | No |
| `support_get_chat_history(session_id, limit, offset)` | Get messages for a chat session (participant or admin) | No |
| `support_get_user_chat_history()` | List user's ended/abandoned chat sessions | No |
| `support_send_chat_message(session_id, body)` | Send a message in an active chat | No |
| `support_mark_chat_read(session_id)` | Mark all messages in a chat as read for the caller | No |
| `support_end_chat(session_id)` | End a chat session (user or admin) | No |

### Live Support Chat (admin agents only)

| Function | Purpose | Scope |
|---|---|---|
| `support_set_agent_status(status)` | Set agent availability (AVAILABLE/BUSY/OFFLINE), refreshes heartbeat | `is_admin_user()` |
| `support_get_agent_status()` | Get agent's current status | `is_admin_user()` |
| `support_agent_heartbeat()` | Update heartbeat timestamp (keeps agent from going stale) | `is_admin_user()` |
| `support_accept_chat()` | Accept oldest WAITING chat (FIFO) | `is_admin_user()` |
| `support_admin_get_waiting_chats()` | List all WAITING sessions with user info | `is_admin_user()` |
| `support_admin_get_active_chats()` | List all ACTIVE sessions with agent info | `is_admin_user()` |
| `support_admin_get_chat_stats()` | Dashboard counts (active, waiting, available agents with fresh heartbeat) | `is_admin_user()` |

### Admin-Only (require `is_admin_user()` + admin 2FA)

| Function | Purpose | Scope |
|---|---|---|
| `admin_list_deposits(status)` | List all deposits with optional filter | — |
| `admin_list_sell_orders(status)` | List all sell orders with optional filter | — |
| `admin_dashboard_stats()` | Aggregate stats for dashboard | — |
| `admin_update_deposit_status(deposit_id, status, verification_id)` | Change deposit status (cannot set CREDITED) | `admin_financial` |
| `admin_credit_verified_deposit(deposit_id, verification_id, continuation_id)` | Credit wallet for verified deposit | `admin_financial` |
| `admin_complete_sell_order(order_id, verification_id)` | Complete sell, consume reserved USDT | `admin_financial` |
| `admin_reject_sell_order(order_id, status, verification_id)` | Reject/cancel sell, release reserved USDT | `admin_financial` |
| `admin_update_exchange_rate(rate, verification_id)` | Update platform rate | `admin_settings` |
| `admin_list_deposit_methods()` | List all deposit methods (Phase 12A) | — |
| `admin_upsert_deposit_method(network, address, is_active, verification_id)` | Create or update deposit method (Phase 12A) | `admin_settings` |
| `admin_toggle_deposit_method(method_id, is_active, verification_id)` | Activate/deactivate deposit method (Phase 12A) | `admin_settings` |
| `get_deposit_verification_details(deposit_id)` | View blockchain verification details (Phase 14) | — (admin only) |
| `admin_manually_verify_deposit(deposit_id, verification_id, checklist)` | Manual verification + credit (Phase 14) | `admin_financial` |
| `admin_notification_counts(users_since)` | Get pending deposit/order/new user counts for badge | — (admin only) |

### Internal Helpers (revoked from all client roles)

| Function | Purpose |
|---|---|
| `_create_verification_token(user_id, scope, expires, source_challenge_id)` | Create a scoped token; Passkey challenges are recorded for replay prevention |
| `_consume_verification_token(token_id, required_scope)` | Atomically validate ownership, expiry, single-use state, and exact scope, then consume the token. Revoked from `authenticated`, `anon`, `public` (Migration 006). |
| `_consume_verification_token_internal(token_id, required_scope, user_id)` | Internal variant accepting explicit `p_user_id` for Edge Functions calling via `serviceClient()`. Same security semantics. Revoked from all client roles (Migration 043). |
| `_require_2fa_verification(verification_id, scope)` | Validate and consume a token produced by either Authenticator or Passkey verification |
| `_require_2fa_enabled()` | Check whether the Authenticator is enabled (no token needed) |
| `_require_admin_2fa(verification_id, scope)` | Admin check plus scoped token validation |
| `_authorize_factor_removal(factor_type, current_passkey_count)` | Atomic 2FA invariant check with advisory lock; creates receipt for passkey deletion (Phase 28) |
| `_cleanup_factor_removal_receipt(factor_type)` | Delete most recent uncompleted receipt after successful GoTrue operation (Phase 28) |
| `_check_passkey_enrollment_auth()` | Trigger helper that atomically consumes a valid enrollment authorization |
| `handle_new_user()` | Trigger: auto-create profile + wallet + balance + notify admins on signup |
| `set_updated_at()` | Trigger: auto-update `updated_at` column |
| `block_ledger_mutation()` | Trigger: prevent UPDATE/DELETE on ledger_entries |
| `request_blockchain_verification(deposit_id)` | Enqueue deposit for blockchain verification (Phase 14) |
| `create_notification(user_id, event_type, title, description, metadata, reference_id)` | Create notification with dedup protection |
| `notify_admins(event_type, title, description, metadata, reference_id, exclude_user_id)` | Create notification for all active admins |

### Live Support Chat Internal Helpers

| Function | Purpose |
|---|---|
| `_support_chat_updated_trigger()` | Trigger: auto-update `updated_at` on `support_chat_sessions` |

---

## Triggers

| Trigger | Table | Event | Function |
|---|---|---|---|
| `on_auth_user_created` | `auth.users` | AFTER INSERT | `handle_new_user()` — creates profile, wallet, balance |
| `trg_profiles_updated_at` | `profiles` | BEFORE UPDATE | `set_updated_at()` |
| `trg_deposits_updated_at` | `deposits` | BEFORE UPDATE | `set_updated_at()` |
| `trg_sell_orders_updated_at` | `sell_orders` | BEFORE UPDATE | `set_updated_at()` |
| `trg_exchange_settings_updated_at` | `exchange_settings` | BEFORE UPDATE | `set_updated_at()` |
| `trg_admin_users_updated_at` | `admin_users` | BEFORE UPDATE | `set_updated_at()` |
| `trg_deposit_methods_updated_at` | `deposit_methods` | BEFORE UPDATE | `set_updated_at()` |
| `trg_block_ledger_mutation` | `ledger_entries` | BEFORE UPDATE OR DELETE | `block_ledger_mutation()` — raises exception |
| `trg_support_chat_updated` | `support_chat_sessions` | BEFORE UPDATE | `_support_chat_updated_trigger()` — auto-updates `updated_at` |
| `trg_support_ticket_updated` | `support_tickets` | BEFORE UPDATE | `set_updated_at()` |
| `check_passkey_enrollment_auth` | `auth.webauthn_credentials` | AFTER INSERT | `_check_passkey_enrollment_auth()` — requires and consumes server enrollment authorization |

---

## Support Tickets (Migration 024)

### `support_tickets`
Asynchronous support ticket headers.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `ticket_number` | TEXT UNIQUE | Sequence-based `XR-NNNN` (starts at 1001) |
| `user_id` | UUID FK | References `auth.users(id)` |
| `assigned_agent_id` | UUID FK | Nullable, references `auth.users(id)` |
| `category` | TEXT | CHECK: Deposit, Sell Order, Account, 2FA / Security, Wallet, Transaction, Other |
| `subject` | TEXT | 1–200 chars |
| `description` | TEXT | 1–5000 chars |
| `status` | TEXT | CHECK: OPEN, IN_PROGRESS, WAITING_FOR_USER, WAITING_FOR_SUPPORT, RESOLVED, CLOSED |
| `priority` | TEXT | CHECK: LOW, NORMAL, HIGH, URGENT (default NORMAL) |
| `related_deposit_id` | UUID FK | Nullable, references `deposits(id)` |
| `related_sell_order_id` | UUID FK | Nullable, references `sell_orders(id)` |
| `reference_hash` | TEXT | Optional TX hash reference |
| `chat_session_id` | UUID FK | Nullable, references `support_chat_sessions(id)` |
| `resolved_at` | TIMESTAMPTZ | Set when status → RESOLVED |
| `closed_at` | TIMESTAMPTZ | Set when status → CLOSED |
| `created_at` | TIMESTAMPTZ | Auto |
| `updated_at` | TIMESTAMPTZ | Auto-updated via trigger |

**RLS**: Enabled. Users SELECT only their own tickets (`user_id = auth.uid()`).

### `support_ticket_messages`
Conversation messages between users and support agents.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `ticket_id` | UUID FK | References `support_tickets(id)` ON DELETE CASCADE |
| `sender_id` | UUID FK | References `auth.users(id)` |
| `body` | TEXT | 1–10000 chars |
| `read_at` | TIMESTAMPTZ | Nullable, set when read by the other party |
| `created_at` | TIMESTAMPTZ | Auto |

**RLS**: Enabled. Users SELECT only messages on their own tickets (via EXISTS subquery).

### `support_ticket_internal_notes`
Admin-only notes invisible to users.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `ticket_id` | UUID FK | References `support_tickets(id)` ON DELETE CASCADE |
| `author_id` | UUID FK | References `auth.users(id)` |
| `note` | TEXT | 1–5000 chars |
| `created_at` | TIMESTAMPTZ | Auto |

**RLS**: Enabled. No user-facing SELECT policy — accessible only via SECURITY DEFINER admin RPCs.

### Support Ticket RPCs

**User RPCs** (7):
| Function | Returns | Description |
|---|---|---|
| `support_create_ticket(...)` | `{ticket_id, ticket_number}` | Create a new ticket, notifies admins |
| `support_get_user_tickets(...)` | SETOF JSONB | Paginated list with optional status filter |
| `support_get_user_ticket(p_ticket_id)` | JSONB | Full ticket with messages (ownership-checked) |
| `support_reply_to_ticket(p_ticket_id, p_body)` | JSONB | User reply, notifies assigned agent or admins |
| `support_mark_ticket_read(p_ticket_id)` | INT | Mark messages read, returns count |
| `support_reopen_ticket(p_ticket_id)` | BOOLEAN | Reopen a RESOLVED ticket |
| `support_get_user_ticket_summary()` | JSONB | Counts of open/waiting/resolved tickets |

**Admin RPCs** (9):
| Function | Returns | Description |
|---|---|---|
| `support_admin_get_tickets(...)` | SETOF JSONB | Paginated, filterable, searchable ticket list |
| `support_admin_get_ticket(p_ticket_id)` | JSONB | Full ticket with messages, notes, user info |
| `support_admin_assign_ticket(p_ticket_id, p_agent_id)` | BOOLEAN | Assign/reassign ticket to agent |
| `support_admin_reply_to_ticket(p_ticket_id, p_body)` | JSONB | Agent reply, notifies user |
| `support_admin_add_note(p_ticket_id, p_note)` | JSONB | Add internal note (invisible to users) |
| `support_admin_update_ticket_status(p_ticket_id, p_status)` | BOOLEAN | Change status with notifications |
| `support_admin_update_ticket_priority(p_ticket_id, p_priority)` | BOOLEAN | Change priority |
| `support_admin_get_ticket_stats()` | TABLE | Dashboard statistics (counts by status) |
| `support_admin_mark_ticket_read(p_ticket_id)` | INT | Mark messages read as agent |

---

## Auto-Provision Flow

When a new user signs up through username/password authentication, the `handle_new_user()` trigger fires:

```
auth.users INSERT
  → profiles (id, full_name, synthetic email, immutable display username)
  → wallets (user_id)
  → wallet_balances (wallet_id, available_usdt=0, reserved_usdt=0)
  → notifications (admin notification: new_user_signup)
```

This ensures every user immediately has a profile and an empty wallet. Admin users receive a notification about the new signup (excluding the new user themselves if they are also an admin).
