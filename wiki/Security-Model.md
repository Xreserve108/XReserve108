
XReserve employs a defense-in-depth security model spanning authentication, authorization, row-level security, server-side business logic, and two-factor verification.

---

## Authentication

### Username and Password Authentication
- Users sign in with a username and password
- The frontend converts the normalized username to a synthetic `@xreserve.com` email identity for Supabase Auth
- Supabase Auth handles password verification, JWT issuance, refresh, and persistent sessions
- Usernames are case-insensitively unique, case-preserving for display, and immutable after registration

### Session Management
- `persistSession: true` — sessions survive page reloads
- `autoRefreshToken: true` — tokens are refreshed automatically
- `detectSessionInUrl: true` — Supabase can process authentication callback state
- A valid Supabase session exists before the application-level login 2FA gate is completed

### Frontend Auth State
- `src/core/auth.js` maintains `currentUser` (null when signed out)
- `initAuth()` waits for the Supabase `INITIAL_SESSION` event before resolving — ensures session is fully restored
- `openAuthGate()` is async — populates `currentUser` from the Supabase session after the gate opens
- The router (`initRouter()`) is initialized **after** auth is ready, preventing initial render with null auth state
- `onAuthStateChange()` propagates events to subscribers
- Admin status is cached and reset on every auth state change

### Interactive Login 2FA Enforcement (Pending-Auth Flow)
- Username/password authentication first establishes a Supabase session
- `login2faPending` prevents that session from populating application `currentUser` during the interactive login flow
- The application detects whether the account has an enabled authenticator, one or more Passkeys, both, or no factor
- Authenticator-only users complete `TotpDialog` in login mode
- Passkey-only users complete a Passkey authentication ceremony
- Users with both factors choose either Authenticator or Passkey
- Successful 2FA verification establishes **server-side login assurance** — a session-bound record in `login_assurance` that cryptographically ties 2FA completion to the specific browser session
- If verification fails or is cancelled, the user is immediately signed out
- Security-state lookup failures fail closed
- Legacy users with no factor enter restricted, non-dismissible mandatory security setup and must enroll an Authenticator or Passkey before `currentUser` is populated
- `completeLogin2FA()` opens application authentication state only after the selected flow succeeds and assurance is confirmed

### Restored Sessions and Login Assurance
- On application bootstrap, `initAuth()` waits for Supabase session initialization
- `openAuthGate()` checks server-side login assurance via `check_login_assurance` RPC — the session must have a valid `login_assurance` record to proceed
- Restored sessions that lack assurance (e.g., assurance revoked, session mismatch) are signed out immediately
- The `TOKEN_REFRESHED` handler re-verifies assurance asynchronously on every token refresh — defense in depth
- Login assurance is established during interactive login (TOTP, recovery code, Passkey, or mandatory enrollment) and bound to the Supabase JWT `session_id`

---

## Authorization

### Admin Detection
- The `admin_users` table maps `user_id` → admin role
- Role: `super_admin` (enforced by CHECK constraint since Migration 008; the earlier `admin` role was removed)
- `is_admin_user()` RPC function checks if the current user is an active admin
- Result is cached in `adminStatus` (frontend) and invalidated on auth changes
- Admins are automatically redirected from user pages to the admin panel

### Route Guards
- **Protected routes**: Require `isAuthenticated() === true` (which requires 2FA gate to be open)
- **Admin routes**: Require `isAdmin() === true` and at least one configured 2FA method (Authenticator or Passkey)
- Admin factor-state lookup failures are treated as no configured factor and access is denied

### Mandatory Admin 2FA
- Admin accounts must retain at least one enabled factor
- All admin routes (`#admin`, `#admin/*`) are blocked until an Authenticator or Passkey is configured
- Admins without a factor are redirected to security setup
- Sensitive admin RPC operations require a fresh, correctly scoped verification token
- Admin authorization remains server-side through `is_admin_user()` and protected RPCs

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
| `admin_users` | Active admin can read own row | None (writes via `add_admin` RPC; original UPDATE policy dropped in Migrations 008/021) |
| `deposit_methods` | Admins can read all; authenticated users can read active methods | None (admin-only writes) |
| `notifications` | `auth.uid() = user_id` | `auth.uid() = user_id` (mark read only) |
| `support_agent_status` | `agent_id = auth.uid()` | None (writes via RPC) |
| `support_chat_sessions` | `user_id = auth.uid() OR agent_id = auth.uid()` | None (writes via RPC) |
| `support_chat_messages` | Participant check (session user or agent) | None (writes via RPC) |

### Tables with No Client Access
These tables have all client roles explicitly revoked:
- `exchange_settings` — platform configuration
- `audit_logs` — immutable audit trail
- `user_2fa` — TOTP secrets
- `recovery_codes` — 2FA recovery
- `user_2fa_verifications` — verification tokens
- `factor_removal_receipts` — short-lived receipts bridging cross-system factor-removal (Phase 28)
- `passkey_enrollment_authorizations` — short-lived server-created Passkey enrollment grants

### Notification Security (Phase 20)
- **No client INSERT/DELETE** — notifications are only created inside `SECURITY DEFINER` financial RPCs (same transaction as the financial operation) and via the `notify_admins` helper; clients cannot fabricate or delete notifications
- **Atomic event wiring** — a notification exists only if the underlying financial operation commits; rollback removes both
- **Duplicate protection** — partial unique index on `(user_id, event_type, reference_id)` WHERE `reference_id IS NOT NULL`, plus a dedup check inside `create_notification`; RPC retries, polling, and tab changes cannot create duplicates
- **Admin isolation** — `notify_admins()` loops over `admin_users WHERE is_active = true`; each admin receives their own row, and RLS ensures users/admins can only read and mark their own notifications
- **Database timestamps** — `created_at`/`read_at` use `now()` server-side; the browser clock is never trusted

### Live Chat Security (Phase 22–23)
- **User isolation** — RLS ensures users can only SELECT their own chat sessions and messages (sessions where `user_id = auth.uid()` or `agent_id = auth.uid()`)
- **Cross-user protection** — Users cannot access another user's chat sessions or messages; message SELECT uses an EXISTS subquery checking session participation
- **No client writes** — All INSERT/UPDATE/DELETE on chat tables revoked from `anon, authenticated, public`; writes go exclusively through `SECURITY DEFINER` RPCs
- **Admin authorization** — All admin chat RPCs (`support_set_agent_status`, `support_accept_chat`, `support_admin_get_waiting_chats`, `support_admin_get_active_chats`, `support_admin_get_chat_stats`, `support_agent_heartbeat`) check `is_admin_user()` before proceeding
- **Participant-only messaging** — `support_send_chat_message` validates the caller is the session's user or assigned agent before inserting
- **Queue manipulation prevention** — Queue position is computed server-side; users cannot modify their own queue position
- **Agent status protection** — Non-admin users cannot modify agent status (INSERT/UPDATE revoked; RPC requires `is_admin_user()`)
- **Heartbeat enforcement** — Stale agents (>3 minutes without heartbeat) are excluded from availability calculations and cannot receive new chat assignments
- **Duplicate chat prevention** — Partial unique index `uq_chat_sessions_one_active_per_user` ensures a user can never have more than one WAITING or ACTIVE session simultaneously
- **Notification integration** — Chat events (assigned, message, ended) create notifications atomically within the same RPC transaction

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
- Requires `admin_financial` 2FA verification (`_require_admin_2fa` with `admin_financial` scope) — it is a privileged admin action
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

## Two-Factor Authentication

XReserve supports two independent factors: Authenticator TOTP and Passkeys. Either method can perform fresh action verification and produce a scoped `verification_id`.

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
| `login` | Interactive login (TOTP, recovery code, Passkey login, mandatory enrollment) |
| `user_transaction` | `create_sell_order`, `submit_deposit` |
| `admin_financial` | `admin_credit_deposit`, `admin_update_deposit_status`, `admin_complete_sell_order`, `admin_reject_sell_order` |
| `admin_settings` | `admin_update_exchange_rate`, `admin_set_deposit_method`, `admin_toggle_deposit_method` |
| `passkey_enrollment` | Existing-user Passkey enrollment authorization |

**Strict scope matching**: If a token has a scope, it must exactly match the required scope. Tokens with no scope are rejected for scoped operations. Tokens with one scope cannot be used for another.

### Atomic Token Consumption
- Verification tokens are consumed using `SELECT ... FOR UPDATE` row-level locking
- This prevents race conditions where concurrent RPC calls could consume the same token twice
- The lock is acquired before any validation checks, ensuring atomicity
- Token consumption and validation occur within the same database transaction
- `_consume_verification_token()` derives the caller identity from `auth.uid()`; this function is revoked from `authenticated`, `anon`, and `public` (Migration 006) — only internal server-side callers (SECURITY DEFINER functions) can invoke it
- Edge Functions that need to consume verification tokens use `_consume_verification_token_internal(p_token_id, p_required_scope, p_user_id)` (Migration 043) via `serviceClient()`. The `p_user_id` parameter comes exclusively from `verifyAuth(req)` (validated JWT), never from the browser. This preserves ownership validation without requiring user-JWT PostgREST access.
- Service-role access to protected tables does not replace the required user identity context
- **Exception**: Login assurance establishment (`establish_login_assurance`) and internal token consumption (`_consume_verification_token_internal`) accept an explicit `p_user_id` parameter so Edge Functions (which use service-role clients where `auth.uid()` returns NULL) can operate without requiring user-JWT context

### Login Assurance (Session-Bound 2FA Proof)
- `login_assurance` table stores session-bound records tying 2FA completion to a specific Supabase JWT `session_id`
- Established by Edge Functions after successful TOTP, recovery code, Passkey login, or mandatory enrollment verification
- `establish_login_assurance(p_session_id, p_verification_token DEFAULT NULL, p_user_id DEFAULT NULL)` — consumes a verification token and creates the assurance record; `p_user_id` is required when called from service-role Edge Functions; defaults to `auth.uid()` when NULL. Single signature (Migration 041 resolved overloads from M039/M040).
- `establish_login_assurance_direct(p_session_id, p_user_id DEFAULT NULL)` — creates assurance without consuming a token (used for enrollment and Passkey login paths); `p_user_id` defaults to `auth.uid()` when NULL. Single signature (Migration 041 resolved overloads).
- `check_login_assurance(p_session_id)` — verifies a valid assurance exists for the session; called from the frontend using the user's JWT
- `revoke_login_assurance()` — removes the current user's assurance records
- Assurance is checked on every bootstrap (`openAuthGate`) and every token refresh (`TOKEN_REFRESHED` handler)
- Fail-closed: if assurance check fails, the user is signed out immediately
- Assurance records are idempotent per session (re-establishing replaces any prior record)

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
- **Admin panel access**: Router redirects to security setup if neither an Authenticator nor a Passkey is configured

### Passkeys

#### Registration
- Signup enrollment uses `signup-authorize`, limited to a new account with no existing Passkey and no enabled Authenticator
- Legacy zero-factor users use `mandatory-authorize`, which omits the new-account age limit but still requires zero existing factors
- Existing users complete fresh Authenticator or Passkey verification with `passkey_enrollment` scope
- `passkey-manage` consumes that verification token and creates a short-lived `passkey_enrollment_authorizations` row
- GoTrue performs the WebAuthn registration ceremony and inserts into `auth.webauthn_credentials`
- The `check_passkey_enrollment_auth` trigger requires and atomically consumes a valid authorization for the credential owner

#### Login and Action Verification
- Login Passkey authentication uses Supabase Auth and may establish or replace the browser session
- **Cross-account protection (login)**: `signInWithPasskey()` creates a new session for the WebAuthn credential owner. The login flow in `signin.js` captures the password-authenticated user's ID BEFORE the passkey ceremony and verifies it matches the post-ceremony session user. Fail-closed: if either user ID is missing or they differ, the user is signed out immediately. This prevents one account's passkey from authenticating a different account's login.
- Action verification uses a two-step WebAuthn ceremony and `verify-passkey-action`
- `verify-passkey-action` verifies the credential through raw GoTrue HTTP so the existing browser session is not replaced
- **Cross-account protection (step-up)**: `verify-passkey-action` checks that the credential owner (from GoTrue's `user.id` response) matches the JWT user. Mismatch returns 403 "Credential ownership mismatch".
- The GoTrue verify endpoint authenticates via the `apikey` header only (anon key) — the challenge itself is bound to the user's session, providing user context. Neither a user JWT nor a service role key should be sent in the `Authorization` header. The `X-Supabase-Api-Version` header must match the SDK's expected version.
- Credential ownership must match the JWT user (extracted from `user.id` in GoTrue's response)
- Successful action verification creates a five-minute verification token with the requested scope and `source_challenge_id`
- A unique partial index prevents reuse of the same Passkey challenge

#### Management and Last-Factor Protection (Phase 28)
- `passkey-manage` lists, renames, and deletes credentials through the GoTrue admin API
- Deletion requires fresh verification
- **2FA invariant**: Every active account must always have at least one active 2FA factor (Authenticator TOTP OR Passkey). The INVALID state (Authenticator OFF AND Passkey DELETED) is unreachable.
- Passkey deletion calls `_authorize_factor_removal('passkey', passkeyCount)` which uses a transaction-level advisory lock (`pg_advisory_xact_lock`) to serialize concurrent factor-removal operations for the same user
- TOTP disable calls `_authorize_factor_removal('totp', passkeyCount)` with the same advisory lock serialization
- A `factor_removal_receipts` table bridges the cross-system gap: when a passkey deletion is authorized, a receipt records the expected passkey count after deletion; TOTP disable checks these receipts to detect in-flight passkey deletions
- Receipts are short-lived (10-minute TTL), user-bound, operation-bound, single-use, and inaccessible to clients (all client roles revoked)
- Stale receipts self-expire and are cleaned by subsequent calls; they can only cause temporary blocks (never incorrectly authorize removal)
- `_consume_verification_token()` is called via user-JWT client (not service-role) to preserve `auth.uid()` identity context

### WebAuthn Domain Configuration (Phase 29)
- **Relying Party ID**: `xreserve.up.railway.app` (bare domain, not a URL)
- **Relying Party Display Name**: `XReserve`
- **Relying Party Origins**: `https://xreserve.up.railway.app` (production HTTPS only)
- **Passkeys are cryptographically bound to the RP ID** — changing the RP ID invalidates all existing credentials registered under a different RP ID
- **localhost development**: `http://localhost:3000` cannot be an RP origin when the RP ID is `xreserve.up.railway.app` (Supabase enforces that each origin's hostname must equal the RP ID or be a subdomain of it). Localhost passkey development requires either a temporary RP ID change back to `localhost` (which invalidates production credentials) or testing passkeys only on production.
- **HTTPS required**: Production WebAuthn operates exclusively over HTTPS. Railway provides TLS for `*.up.railway.app` domains.
- Configuration applied via Supabase Management API (`PATCH /v1/projects/{ref}/config/auth`), NOT via `supabase config push` (which does not propagate WebAuthn RP settings)
- The `supabase/config.toml` file is kept in sync as documentation but is not the authoritative configuration source for WebAuthn settings

### Passkey Enrollment Authorization
- Enrollment authorization is distinct from a verification token
- Authorization rows are short-lived, user-bound, and single-use
- Authenticated and anonymous clients have no direct authorization-table write path
- `service_role` creates authorization rows; `supabase_auth_admin` consumes them through the credential-insert trigger
- This server-side gate prevents possession of a Supabase session alone from authorizing a new Passkey

### Security Invariants
- **2FA invariant (Phase 28)**: `active_2fa_methods >= 1` — enforced server-side via advisory lock and factor-removal receipts for both users and admins
- Verification tokens remain bound to `auth.uid()`, short-lived, single-use, and strictly scoped
- Authenticator and Passkey verification remain independent token issuers with identical downstream scope semantics
- Action Passkey verification must not replace the active browser session
- Existing-user Passkey enrollment requires fresh `passkey_enrollment` verification and a separate server-created enrollment authorization
- Enrollment authorizations remain user-bound, short-lived, single-use, and unavailable for direct client writes
- The `auth.webauthn_credentials` insert trigger remains enforced
- Passkey challenge replay prevention and last-factor protection remain enabled
- Security-state lookup and admin route checks fail closed
- Admin identity checks and financial/settings scopes remain server-enforced

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
| `LOGIN_ASSURANCE_ESTABLISHED` | `establish_login_assurance` RPC (after TOTP/recovery login) |
| `LOGIN_ASSURANCE_ESTABLISHED_DIRECT` | `establish_login_assurance_direct` RPC (after enrollment/Passkey login) |
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
| **Authentication** | Username/password via synthetic Supabase Auth email identity; JWT sessions |
| **Interactive Login 2FA Gate** | `login2faPending` keeps `currentUser` unset until Authenticator/Passkey handling completes |
| **Login Assurance** | Session-bound server-side record ties 2FA completion to JWT `session_id`; checked on bootstrap and token refresh |
| **2FA Methods** | Authenticator TOTP and Passkeys/WebAuthn |
| **Passkey Enrollment** | Scoped fresh verification plus short-lived server authorization and credential trigger |
| **Authorization** | `admin_users` table, route guards, RPC-level checks |
| **Mandatory Admin 2FA** | Admin routes + RPCs blocked without 2FA enrollment |
| **Row-Level Security** | Per-user SELECT/UPDATE policies on all user-facing tables |
| **Business Logic** | `SECURITY DEFINER` RPC functions, no direct table writes |
| **Deposit Pipeline** | 3-stage: blockchain → manual review → 2FA credit |
| **Blockchain Verification** | TronGrid API, Edge Function with shared secret |
| **2FA Invariant (Phase 28)** | `active_2fa_methods >= 1` enforced via advisory lock + factor-removal receipts |
| **WebAuthn Domain (Phase 29)** | RP ID `xreserve.up.railway.app`, production HTTPS origin only, configured via Management API |
| **Passkey Cross-Account Protection** | Login: pre/post session user_id comparison (fail-closed). Step-up: GoTrue response user_id vs JWT user_id check |
| **2FA Verification** | Edge Functions issue scoped tokens after TOTP or Passkey verification |
| **Scope Enforcement** | Strict matching: `user_transaction`, `admin_financial`, `admin_settings`, `passkey_enrollment` |
| **Atomic Token Consumption** | `SELECT FOR UPDATE` prevents race conditions |
| **Rate Limiting** | 5-attempt lockout, 15-minute cooldown |
| **Replay Prevention** | Code hashing, single-use verification tokens |
| **Audit Trail** | Immutable `audit_logs` table, written by every RPC function |
| **Ledger Integrity** | Append-only, mutation trigger blocks UPDATE/DELETE |
| **Encryption** | AES-256-GCM for TOTP secrets at rest, version-aware for key rotation |
| **Live Chat RLS** | Per-user session/message isolation, participant-only access |
| **Chat Agent Auth** | `is_admin_user()` required for all agent operations |
| **Chat Heartbeat** | 60s heartbeat, 3-min stale threshold, stale agents excluded from assignment |
| **Duplicate Chat Guard** | Partial unique index prevents multiple WAITING/ACTIVE sessions per user |
