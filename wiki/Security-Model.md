
XReserve employs a defense-in-depth security model spanning authentication, authorization, row-level security, server-side business logic, and two-factor verification.

---

## Authentication

### Google OAuth
- Users sign in exclusively via Google OAuth through Supabase Auth
- Supabase handles the OAuth flow, JWT issuance, and session management
- Auth flow type: `implicit` (configured in Supabase client)
- Session persistence: enabled with auto-refresh

### Session Management
- `persistSession: true` — sessions survive page reloads
- `autoRefreshToken: true` — tokens are refreshed automatically
- `detectSessionInUrl: true` — handles OAuth callback tokens in URL

### Frontend Auth State
- `src/core/auth.js` maintains `currentUser` (null when signed out)
- `initAuth()` waits for the Supabase `INITIAL_SESSION` event before resolving — ensures session is fully restored
- `openAuthGate()` is async — populates `currentUser` from the Supabase session after the gate opens
- The router (`initRouter()`) is initialized **after** auth is ready, preventing initial render with null auth state
- `onAuthStateChange()` propagates events to subscribers
- Admin status is cached and reset on every auth state change

### Login-Time 2FA Enforcement (Pending-Auth Flow)
- After Google OAuth completes, the app enters a **pending authentication state**
- An **auth gate** prevents `currentUser` from being set until 2FA verification completes
- No protected content is rendered, no auth callbacks fire, no RPC calls are possible
- If 2FA verification fails or is cancelled, the user is **immediately signed out**
- If the 2FA status check itself fails, the user is signed out (strict enforcement)
- The auth gate is opened via `await openAuthGate()` only after successful 2FA verification
- `openAuthGate()` is async — it retrieves the session and sets `currentUser` before resolving
- This prevents any window where a valid JWT exists but 2FA has not been verified
- The router is initialized after the gate opens, ensuring the initial render has correct auth state

---

## Authorization

### Admin Detection
- The `admin_users` table maps `user_id` → admin role
- Roles: `admin`, `super_admin`
- `is_admin_user()` RPC function checks if the current user is an active admin
- Result is cached in `adminStatus` (frontend) and invalidated on auth changes
- Admins are automatically redirected from user pages to the admin panel

### Route Guards
- **Protected routes**: Require `isAuthenticated() === true` (which requires 2FA gate to be open)
- **Admin routes**: Require `isAdmin() === true` AND 2FA enabled — **no fallback** if check fails
- Admin 2FA is enforced both client-side (router) and server-side (RPC functions)
- The router's admin 2FA check has **no try/catch** — if the check fails, access is denied

### Mandatory Admin 2FA
- Admin accounts **must** have 2FA enabled at all times
- All admin routes (`#admin`, `#admin/*`) are blocked until 2FA enrollment is complete
- Admins without 2FA are redirected to the security settings page to enroll
- All admin RPC operations require a valid verification token — server-side enforced
- Admin 2FA is enforced at three layers: router, RPC functions, and Edge Functions

---

## Row-Level Security (RLS)

All user-facing tables have RLS enabled. Policies ensure users can only access their own data.

| Table | SELECT Policy | UPDATE Policy |
|---|---|---|
| `profiles` | `auth.uid() = id` | `auth.uid() = id` |
| `wallets` | `auth.uid() = user_id` | None |
| `wallet_balances` | Via join to `wallets.user_id` | None |
| `ledger_entries` | Via join to `wallets.user_id` | None (immutable) |
| `deposits` | `auth.uid() = user_id` | None |
| `sell_orders` | `auth.uid() = user_id` | None |
| `admin_users` | Active admin can read own row | Admin can update own row |
| `deposit_methods` | Admins can read all; authenticated users can read active methods | None (admin-only writes) |
| `notifications` | `auth.uid() = user_id` | `auth.uid() = user_id` (mark read only) |

### Tables with No Client Access
These tables have all client roles explicitly revoked:
- `exchange_settings` — platform configuration
- `audit_logs` — immutable audit trail
- `user_2fa` — TOTP secrets
- `recovery_codes` — 2FA recovery
- `user_2fa_verifications` — verification tokens

### Notification Security (Phase 20)
- **No client INSERT/DELETE** — notifications are only created inside `SECURITY DEFINER` financial RPCs (same transaction as the financial operation) and via the `notify_admins` helper; clients cannot fabricate or delete notifications
- **Atomic event wiring** — a notification exists only if the underlying financial operation commits; rollback removes both
- **Duplicate protection** — partial unique index on `(user_id, event_type, reference_id)` WHERE `reference_id IS NOT NULL`, plus a dedup check inside `create_notification`; RPC retries, polling, and tab changes cannot create duplicates
- **Admin isolation** — `notify_admins()` loops over `admin_users WHERE is_active = true`; each admin receives their own row, and RLS ensures users/admins can only read and mark their own notifications
- **Database timestamps** — `created_at`/`read_at` use `now()` server-side; the browser clock is never trusted

---

## Server-Side Business Logic

All financial operations are performed by `SECURITY DEFINER` PostgreSQL functions. The client never directly modifies balances, orders, or deposits.

### Principle
- Client calls RPC function with parameters
- Function runs with elevated privileges (bypasses RLS)
- Function validates: authentication, authorization, balances, 2FA
- Function performs atomic operations (balance updates + ledger entries + status changes)
- Function writes audit log entries

### Wallet Balance Invariants
- `available_usdt >= 0` (CHECK constraint)
- `reserved_usdt >= 0` (CHECK constraint)
- Sell orders can only reserve up to `available_usdt`
- All balance changes produce corresponding `ledger_entries`

### Ledger Immutability
- `BEFORE UPDATE OR DELETE` trigger raises an exception
- Ledger entries are append-only
- No client-side INSERT policy exists
- Only `SECURITY DEFINER` functions can insert entries

---

## Deposit Verification Pipeline

Deposits follow a 3-stage verification pipeline before wallet credit:

### Stage 1 — Blockchain Verification (Automated)
- On deposit submission, `request_blockchain_verification` RPC enqueues the deposit for verification
- The `verify-trc20-deposit` Edge Function queries the TronGrid API to independently confirm:
  - Transaction exists on-chain
  - Correct token (USDT TRC20 contract)
  - Correct recipient (matches `deposit_methods.destination_address`)
  - Sufficient confirmations
- The actual transferred amount is recorded as `verified_amount` (may differ from `declared_amount`)
- Verification data stored in `blockchain_verification_data` (JSONB): from_address, block_number, confirmations, etc.
- Multiple attempts tracked via `blockchain_verification_attempts`; errors logged to `blockchain_verification_error`
- Edge Function secret `BLOCKCHAIN_VERIFY_SECRET` authenticates RPC calls from the Edge Function

### Stage 2 — Manual Admin Verification (Human Review)
- After blockchain verification succeeds, an admin must independently verify 8 checklist items:
  1. Transaction ID (TXID) is correct
  2. TRC20 network confirmed
  3. Token is USDT
  4. Sender address verified
  5. Recipient matches XReserve deposit address
  6. Blockchain verified amount is correct
  7. Transaction has sufficient finality (confirmations)
  8. Relevant wallet/blockchain information reviewed
- Recorded via `admin_manually_verify_deposit` RPC — sets `manually_verified_at`, `manually_verified_by`, `manual_verification_notes`, `manual_verification_checklist`
- **No 2FA required** for manual verification — it is a logged confirmation, not a financial action
- The admin who performs manual verification is recorded in the audit log

### Stage 3 — Financial Authorization (2FA Required)
- Only after both blockchain and manual verification are complete
- Admin calls `admin_credit_deposit` with `admin_financial` 2FA scope
- Credits `verified_amount` (not `declared_amount`) to user's wallet
- Migration 012 hardened: only `PENDING` and `UNDER_REVIEW` are valid source statuses (NOT `PENDING_VERIFICATION`)
- Migration 013 hardened: `admin_update_deposit_status` cannot transition to `CREDITED` (only `admin_credit_deposit` can credit)

### Deposit Status Flow
```
PENDING_VERIFICATION → (blockchain + manual verified) → PENDING → UNDER_REVIEW → CREDITED
                                                           ↘ REJECTED (at any stage)
```

---

## Two-Factor Authentication (TOTP)

### Architecture
- TOTP secrets are generated and verified in **Supabase Edge Functions** (Deno)
- Secrets are encrypted at rest with **AES-256-GCM** in the `user_2fa` table
- The encryption key (`TOTP_ENCRYPTION_KEY`) is an Edge Function secret, never in client code or database

### Enrollment
1. Edge Function generates a 16-byte random secret (base32-encoded)
2. Secret is encrypted and stored in `user_2fa`
3. User scans QR code, enters 6-digit code
4. Edge Function verifies code, enables 2FA, generates 10 recovery codes
5. Recovery codes are hashed (SHA-256) before storage

### Verification Flow
```
User enters TOTP code
  → Frontend calls verify-2fa Edge Function
  → Edge Function verifies code (TOTP or recovery)
  → Creates verification token (5-min TTL, single-use, scoped)
  → Returns verification_id to frontend
  → Frontend passes verification_id to RPC function
  → RPC function validates token via _require_2fa_verification()
  → Token is consumed (marked used=true)
```

### Operation Scopes
Verification tokens carry an operation scope to prevent cross-context reuse:

| Scope | Used By |
|---|---|
| `user_transaction` | `create_sell_order`, `submit_deposit` |
| `admin_financial` | `admin_credit_deposit`, `admin_update_deposit_status`, `admin_complete_sell_order`, `admin_reject_sell_order` |
| `admin_settings` | `admin_update_exchange_rate`, `admin_set_deposit_method`, `admin_toggle_deposit_method` |

**Strict scope matching**: If a token has a scope, it must exactly match the required scope. Tokens with no scope are rejected for scoped operations. Tokens with one scope cannot be used for another.

### Atomic Token Consumption
- Verification tokens are consumed using `SELECT ... FOR UPDATE` row-level locking
- This prevents race conditions where concurrent RPC calls could consume the same token twice
- The lock is acquired before any validation checks, ensuring atomicity
- Token consumption and validation occur within the same database transaction

### Rate Limiting & Lockout
- **5 failed attempts** → account locked for **15 minutes**
- Lockout is enforced in Edge Functions (verify-2fa)
- Failed attempt counter resets on successful verification

### Replay Prevention
- SHA-256 hash of each verified code is stored as `last_code_hash`
- If the same code is submitted again while an active verification exists → rejected
- Verification tokens are single-use (`used` flag)

### Recovery Codes
- 10 codes generated on enrollment
- 8 characters each, crypto-random from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
- Stored as SHA-256 hashes
- Each code is single-use (marked `used=true` when consumed)
- Shown once after enrollment, never displayed again

### Mandatory 2FA
- **Deposits**: `submit_deposit` RPC requires a valid `verification_id` with `user_transaction` scope
- **Sell orders**: `create_sell_order` requires a valid `verification_id` with `user_transaction` scope
- **Admin financial operations**: All admin financial RPCs require `verification_id` with `admin_financial` scope
- **Admin settings**: Exchange rate changes (`admin_update_exchange_rate`) and deposit method configuration require `verification_id` with `admin_settings` scope
- **Admin panel access**: Router redirects to security page if 2FA is not enabled

---

## Audit Logging

Every significant action is recorded in `audit_logs`:

| Action | Triggered By |
|---|---|
| `2FA_ENROLLMENT_STARTED` | enroll-2fa Edge Function |
| `2FA_ENABLED` | verify-2fa-setup Edge Function |
| `2FA_DISABLED` | disable-2fa Edge Function |
| `2FA_VERIFIED` | verify-2fa Edge Function |
| `2FA_FAILED_ATTEMPT` | verify-2fa Edge Function |
| `2FA_RECOVERY_USED` | verify-2fa Edge Function |
| `2FA_VERIFIED_OPERATION` | `_require_2fa_verification` RPC (called by all financial RPCs) |
| `DEPOSIT_SUBMITTED` | `submit_deposit` RPC |
| `DEPOSIT_CREATED` | `create_deposit` RPC (legacy, replaced by `submit_deposit`) |
| `BLOCKCHAIN_VERIFICATION_SUCCESS` | `verify-trc20-deposit` Edge Function |
| `BLOCKCHAIN_VERIFICATION_FAILURE` | `verify-trc20-deposit` Edge Function |
| `MANUAL_VERIFICATION_RECORDED` | `admin_manually_verify_deposit` RPC |
| `DEPOSIT_CREDITED` | `admin_credit_deposit` RPC |
| `DEPOSIT_UNDER_REVIEW` | `admin_update_deposit_status` RPC |
| `DEPOSIT_REJECTED` | `admin_update_deposit_status` RPC |
| `DEPOSIT_REOPENED` | `admin_update_deposit_status` RPC |
| `SELL_ORDER_CREATED` | `create_sell_order` RPC |
| `SELL_COMPLETED` | `admin_complete_sell_order` RPC |
| `SELL_CANCELLED` | `admin_reject_sell_order` RPC |
| `SELL_REJECTED` | `admin_reject_sell_order` RPC |
| `EXCHANGE_RATE_UPDATED` | `admin_update_exchange_rate` RPC |
| `DEPOSIT_METHOD_UPDATED` | `admin_set_deposit_method` RPC |
| `DEPOSIT_METHOD_TOGGLED` | `admin_toggle_deposit_method` RPC |

Audit records include `actor_id`, `target_type`, `target_id`, and `metadata` (JSONB with full context including verification IDs, checklist data, and verification amounts).

---

## Security Summary

| Layer | Mechanism |
|---|---|
| **Authentication** | Google OAuth via Supabase Auth, JWT sessions |
| **Login 2FA Gate** | Pending-auth flow — no session until TOTP verified |
| **Authorization** | `admin_users` table, route guards, RPC-level checks |
| **Mandatory Admin 2FA** | Admin routes + RPCs blocked without 2FA enrollment |
| **Row-Level Security** | Per-user SELECT/UPDATE policies on all user-facing tables |
| **Business Logic** | `SECURITY DEFINER` RPC functions, no direct table writes |
| **Deposit Pipeline** | 3-stage: blockchain → manual review → 2FA credit |
| **Blockchain Verification** | TronGrid API, Edge Function with shared secret |
| **2FA** | TOTP via Edge Functions, encrypted secrets, scoped tokens |
| **Scope Enforcement** | Strict matching: `user_transaction`, `admin_financial`, `admin_settings` |
| **Atomic Token Consumption** | `SELECT FOR UPDATE` prevents race conditions |
| **Rate Limiting** | 5-attempt lockout, 15-minute cooldown |
| **Replay Prevention** | Code hashing, single-use verification tokens |
| **Audit Trail** | Immutable `audit_logs` table, written by every RPC function |
| **Ledger Integrity** | Append-only, mutation trigger blocks UPDATE/DELETE |
| **Encryption** | AES-256-GCM for TOTP secrets at rest, version-aware for key rotation |
