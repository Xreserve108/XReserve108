# Database Schema

All database objects live in PostgreSQL via Supabase. The schema is managed through 20 sequential migration files in `supabase/migrations/`.

---

## Tables

### `profiles`
User profiles, auto-created on signup via trigger.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | References `auth.users(id)` ON DELETE CASCADE |
| `full_name` | TEXT | From Google OAuth metadata |
| `avatar_url` | TEXT | From Google OAuth metadata |
| `email` | TEXT | User email |
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
| `role` | TEXT | `admin` or `super_admin` |
| `is_active` | BOOLEAN | Default `true` |
| `created_by` | UUID FK | References `auth.users(id)` |
| `created_at` | TIMESTAMPTZ | Auto |
| `updated_at` | TIMESTAMPTZ | Auto |

**RLS**: Active admin can SELECT own row. Only `super_admin` can UPDATE.

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
Single-use verification tokens issued after TOTP verification.

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID FK | References `auth.users(id)` |
| `verified_at` | TIMESTAMPTZ | Auto |
| `expires_at` | TIMESTAMPTZ | Typically 5 minutes after creation |
| `used` | BOOLEAN | Default `false` |
| `operation_scope` | TEXT | e.g., `user_transaction`, `admin_financial` |
| `used_at` | TIMESTAMPTZ | When consumed (Phase 12A fix) |

**Access**: All client roles revoked.

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
| `_require_2fa_verification(verification_id, scope)` | Validate and consume a verification token |
| `_require_2fa_enabled()` | Check 2FA is enabled (no token needed) |
| `_require_admin_2fa(verification_id, scope)` | Admin check + 2FA token validation |
| `handle_new_user()` | Trigger: auto-create profile + wallet + balance + notify admins on signup |
| `set_updated_at()` | Trigger: auto-update `updated_at` column |
| `block_ledger_mutation()` | Trigger: prevent UPDATE/DELETE on ledger_entries |
| `request_blockchain_verification(deposit_id)` | Enqueue deposit for blockchain verification (Phase 14) |
| `create_notification(user_id, event_type, title, description, metadata, reference_id)` | Create notification with dedup protection |
| `notify_admins(event_type, title, description, metadata, reference_id, exclude_user_id)` | Create notification for all active admins |

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

---

## Auto-Provision Flow

When a new user signs up (via Google OAuth), the `handle_new_user()` trigger fires:

```
auth.users INSERT
  → profiles (id, full_name, avatar_url, email, username)
  → wallets (user_id)
  → wallet_balances (wallet_id, available_usdt=0, reserved_usdt=0)
  → notifications (admin notification: new_user_signup)
```

This ensures every user immediately has a profile and an empty wallet. Admin users receive a notification about the new signup (excluding the new user themselves if they are also an admin).
