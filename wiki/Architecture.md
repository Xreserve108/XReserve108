# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (Client)                         │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │  Pages   │  │Components│  │  Core    │  │  Admin Panel  │  │
│  │ (home,   │  │(OrderCard│  │ (router, │  │ (dashboard,   │  │
│  │  wallet, │  │StatusBadg│  │  auth,   │  │  deposits,    │  │
│  │  sell,   │  │TotpDialog│  │  theme,  │  │  sell-orders, │  │
│  │  deposit,│  │ConfirmDlg│  │  totp,   │  │  deposit-     │  │
│  │  orders, │  └──────────┘  │  user-   │  │  methods,     │  │
│  │  profile,│                │  name)   │  │  security)    │  │
│  │  signin, │  ┌──────────────────────────────────────────┐  │  │
│  │  security│  │         Supabase JS Client               │  │  │
│  └──────────┘  │  (auth, RPC calls, Edge Function calls)  │  │  │
│                └──────────────────────────────────────────┘  │  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Supabase Platform                          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────────┐  ┌─────────────────┐  │
│  │  Supabase    │  │  PostgreSQL      │  │  Edge Functions │  │
│  │  Auth        │  │  (RPC Functions) │  │  (Deno)         │  │
│  │              │  │                  │  │                 │  │
│  │  - Username/ │  │  - Wallet ops    │  │  - enroll-2fa   │  │
│  │    password  │  │  - Admin ops     │  │  - verify-2fa   │  │
│  │  - Passkeys  │  │  - 2FA status    │  │  - verify-2fa-  │  │
│  │  - JWT       │  │  - Deposit mgmt  │  │    setup        │  │
│  │  - Sessions  │  │  - Sell orders   │  │  - disable-2fa  │  │
│  │              │  │  - Audit logs    │  │  - passkey-     │  │
│  │              │  │  - Enrollment    │  │    manage       │  │
│  │              │  │    authorization │  │  - verify-      │  │
│  │              │  │  - Support       │  │    passkey-     │  │
│  │              │  │                  │  │    action       │  │
│  └──────────────┘  └──────────────────┘  └─────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              Database Tables (PostgreSQL)                 │  │
│  │                                                          │  │
│  │  profiles · wallets · wallet_balances · ledger_entries   │  │
│  │  deposits · sell_orders · exchange_settings             │  │
│  │  deposit_methods · admin_users · audit_logs             │  │
│  │  user_2fa · recovery_codes · user_2fa_verifications     │  │
│  │  passkey_enrollment_authorizations · auth WebAuthn data │  │
│  │  factor_removal_receipts · login_assurance              │  │
│  │  notifications                                          │  │
│  │  support_agent_status · support_chat_sessions           │  │
│  │  support_chat_messages                                  │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Shared Data Modules** (`src/data/`): Thin wrappers over Supabase RLS-scoped queries. `wallet-data.js` provides `getWalletBalance()` and `getTransactions()` used by wallet page, home page, and navigation header balance display.

## Data Flow

### User Deposit Flow (Phase 12C + Phase 14)

```
User navigates to Deposit page → 2FA gate checked
    → Active deposit method loaded (admin-configured TRC20 address)
    → User sees QR code + deposit address
    → User sends USDT off-chain to the deposit address
    → User enters: amount, TXID, optional blockchain URL
    → User completes 2FA verification (user_transaction scope)
    → Frontend calls submit_deposit RPC with verification_id
    → RPC validates: auth, active deposit method, amount, TXID, URL
    → RPC resolves destination address server-side from deposit_methods
    → Deposit created (status: PENDING_VERIFICATION) — NO wallet crediting
    → Frontend attempts to enqueue blockchain verification (non-fatal)
    → verify-trc20-deposit Edge Function queries TronGrid API
    → On-chain amount recorded as verified_amount
    → Admin reviews deposit with full verification details
    → Admin completes manual verification checklist (8 items)
    → Admin verifies TOTP → calls admin_manually_verify_deposit RPC
    → OR: Admin verifies TOTP → calls admin_credit_deposit RPC (legacy path)
    → Wallet balance credited + ledger entry created
    → Deposit marked CREDITED
```

### User Sell Order Flow

```
User enters USDT amount → Frontend calculates INR payout
    → User clicks "Sell Now"
    → TotpDialog opens → User enters TOTP code
    → Frontend calls verify-2fa Edge Function → gets verification_id
    → Frontend calls create_sell_order RPC with verification_id
    → RPC validates token (scope: user_transaction, single-use)
    → USDT moved: available → reserved
    → Ledger entry (RESERVE) created
    → Sell order created (status: PAYMENT_PENDING)
    → Admin reviews → verifies TOTP → completes or rejects
    → On complete: reserved USDT consumed, order COMPLETED
    → On reject/cancel: reserved USDT released back to available
```

### Authentication and Login Flow

```text
Username/password submitted
    → Username normalized and mapped to a synthetic Supabase Auth email
    → Supabase Auth establishes a JWT session
    → login2faPending keeps application currentUser unset
    → Security state detects enabled Authenticator and registered Passkeys
    → Authenticator-only: non-dismissible TOTP/recovery verification
    → Passkey-only: Passkey authentication
    → Both: user chooses Authenticator or Passkey
    → Neither: restricted mandatory setup for Authenticator or Passkey
    → Successful 2FA verification establishes server-side login assurance
      (session-bound record in login_assurance tied to JWT session_id)
    → completeLogin2FA() checks assurance and populates currentUser
    → Authenticated application rendered
    → Failure/cancellation signs the user out
```

### Transaction Verification Flow

```text
Protected action requests fresh verification with an operation scope
    → TotpDialog detects available Authenticator and Passkey methods
    → Authenticator path calls verify-2fa
    → Passkey path calls verify-passkey-action without replacing the session
    → Edge Function returns verification_id
    → Protected RPC or management Edge Function validates ownership, expiry,
      single-use state, and exact scope
    → Verification token is atomically consumed
    → Protected action continues
```

### Passkey Enrollment Flow

```text
Existing user clicks Add Passkey
    → Fresh verification with passkey_enrollment scope
    → passkey-manage consumes verification token
    → Short-lived passkey_enrollment_authorizations row created
    → Supabase Auth starts WebAuthn registration
    → Browser creates credential
    → Supabase Auth verifies registration and inserts auth.webauthn_credentials
    → Database trigger finds and atomically consumes enrollment authorization
    → Credential accepted
```

Signup users use the age-limited `signup-authorize` path. Legacy users with no configured factor use the restricted `mandatory-authorize` path. Both still require a server-created enrollment authorization before credential insertion.

### 2FA Enrollment Flow

```
User navigates to Security → clicks "Set Up 2FA"
    → Frontend calls enroll-2fa Edge Function
    → Edge Function generates secret (otplib), encrypts (AES-256-GCM), upserts to user_2fa
    → Returns secret + otpauth URI
    → Frontend renders QR code
    → User scans QR, enters 6-digit code
    → Frontend calls verify-2fa-setup Edge Function
    → Edge Function verifies code, enables 2FA, generates 10 recovery codes
    → Recovery codes shown to user (one-time display)
```

### Blockchain Verification Flow (Phase 14)

```
Deposit created (PENDING_VERIFICATION)
    → request_blockchain_verification RPC enqueues deposit
    → verify-trc20-deposit Edge Function called (admin JWT or cron secret)
    → Queries TronGrid API: GET /v1/accounts/{address}/transactions
    → Searches for matching TXID in transaction list
    → Validates: correct token contract, sufficient confirmations, success status
    → Compares on-chain amount with declared amount
    → Records verified_amount on deposit row
    → Admin can view full verification details via get_deposit_verification_details RPC
    → Admin completes 8-point manual verification checklist
    → admin_manually_verify_deposit RPC credits wallet atomically
```

### Live Support Chat Flow (Phase 22–23)

```
User navigates to Help & Support → availability checked (support_get_chat_availability)
    → Shows agent availability, queue size, estimated wait
    → User clicks "Start Live Chat" or "Join Queue"
    → Frontend calls support_start_live_chat RPC
    → RPC checks for existing ACTIVE/WAITING session (returns it if found)
    → If no existing session:
        → Finds AVAILABLE agent with fresh heartbeat (<3 min) and capacity
        → If agent found: immediate assignment (status=ACTIVE)
        → If no agent: create WAITING session with queue position
    → Frontend subscribes to Realtime channels (messages + session status)
    → Messages sent via support_send_chat_message RPC (SECURITY DEFINER)
    → Realtime delivers INSERT events to subscribed clients
    → Agent heartbeat (60s interval) keeps agent AVAILABLE
    → Stale agents (>3 min no heartbeat) excluded from availability
    → Chat ends via support_end_chat RPC → status=ENDED
    → Notifications sent on assign, message, and end events
```

### Admin Agent Flow (Phase 22–23)

```
Admin navigates to Live Chat Center
    → Sets agent status (AVAILABLE / BUSY / OFFLINE) via support_set_agent_status
    → Heartbeat starts (60s interval) when AVAILABLE or BUSY
    → Dashboard shows: active chats, waiting chats, agent stats
    → Admin accepts waiting chat via support_accept_chat (FIFO)
    → Conversation view with realtime message delivery
    → Admin can send messages and end chats
    → Heartbeat stops when agent goes OFFLINE
```

## Application Bootstrap Sequence

```
main.js
  ├── initTheme()          — Apply saved theme preference
  ├── initLenis()          — Start smooth scrolling
  ├── initApp()            — Build shell and register routes
  ├── setupAuthListener()  — Subscribe to application auth events
  ├── initAuth()           — Wait for initial Supabase auth event
  ├── getSession()         — Restore the persisted Supabase session
  ├── openAuthGate()       — Check server-side login assurance, populate currentUser
  ├── initRouter()         — Start hash-based routing after auth state is ready
  ├── isAdmin()            — Check and cache admin status
  └── Start authenticated wallet/chat/admin heartbeat services as applicable

Interactive username/password login uses a separate pending-auth flow in `signin.js`: `login2faPending` remains true until Authenticator/Passkey verification or mandatory setup succeeds. Restored-session bootstrap checks login assurance via `check_login_assurance` RPC — sessions without valid assurance are signed out.

Note: Page render functions (home, wallet, orders) are async.
The router's renderPage() awaits route.render() before appending to DOM.
```

## Layout System

The app has two distinct layouts that are swapped dynamically by the router:

### User Layout
```
┌────────────────────────────────────────────┐
│ ┌──────────┐ ┌──────────────────────────┐  │
│ │ Desktop  │ │ TopBar (logo, wallet balance,    │  │
│ │ Sidebar  │ │  theme toggle, profile icon)     │  │
│ │ (240px)  │ ├──────────────────────────┤  │
│ │          │ │                          │  │
│ │ - Home   │ │   Page Content           │  │
│ │ - Wallet │ │   (#page-content)        │  │
│ │ - Sell   │ │                          │  │
│ │ - Orders │ │                          │  │
│ │          │ │                          │  │
│ │ [Theme]  ├──────────────────────────┤  │
│ └──────────┘ │ BottomNav (mobile)     │  │
│              └──────────────────────────┘  │
└────────────────────────────────────────────┘
```

**TopBar wallet balance control** (authenticated users only):
- Tether/USDT icon + real available balance + chevron
- Balance fetched via `getWalletBalance()` from `wallet_balances` table (RLS-scoped)
- Always visible (including mobile); compact sizing prevents header overflow

### Admin Layout
```
┌────────────────────────────────────────────┐
│ Header: "XReserve Admin"    [Theme Toggle] │
├────────────────────────────────────────────┤
│ Nav Tabs: Dashboard | Deposits | Orders    │
│           | Deposit Methods | Settings     │
├────────────────────────────────────────────┤
│                                            │
│   Page Content (#page-content)             │
│                                            │
└────────────────────────────────────────────┘
```

## Migration Phases

| Migration | Phase | Description |
|---|---|---|
| `001_database_foundation.sql` | Phase 3 | Core tables, RLS, auto-provision trigger |
| `002_wallet_engine.sql` | Phase 4A | Wallet operations (create sell, credit, release, consume) |
| `003_admin_operations.sql` | Phase 5-7 | Admin users, admin RPC functions, dashboard stats |
| `004_two_factor_auth.sql` | Phase 9A | TOTP in PL/pgSQL (superseded by 005) |
| `005_edge_function_2fa.sql` | Phase 9A (prod) | Replaces PL/pgSQL TOTP with Edge Function-based verification |
| `006_phase_9b_security_hardening.sql` | Phase 9B | Atomic token consumption, strict scope enforcement, deposit verification |
| `007_phase_10a_username_auth.sql` | Phase 10A | Username-based authentication (case-insensitive login, case-preserving storage) |
| `008_phase_11_admin_security_hardening.sql` | Phase 11 | Hardened admin_users table (super_admin role, RLS, audit) |
| `009_phase_12a_active_deposit_methods.sql` | Phase 12A | Admin-configurable deposit method registry (TRC20, BEP20) |
| `010_phase_12a_verification_used_at_fix.sql` | Phase 12A fix | Adds missing `used_at` column to `user_2fa_verifications` |
| `011b_phase_12c_user_deposit_submission_safe_parts.sql` | Phase 12C | User deposit submission (submit_deposit, get_user_pending_deposits) |
| `012_phase_12c_admin_credit_security_fix.sql` | Phase 12C fix | Hardens admin_credit_deposit (drops 2-arg overload, blocks PENDING_VERIFICATION credit) |
| `013_phase_12c_admin_status_rpc_security_fix.sql` | Phase 12C fix | Hardens admin_update_deposit_status (drops 2-arg overload, removes CREDITED target) |
| `014_phase_14_trc20_blockchain_verification.sql` | Phase 14 | TRC20 blockchain verification (TronGrid API, manual verification checklist) |
| `014b_phase_14_trc20_blockchain_verification_corrected.sql` | Phase 14 fix | Corrected blockchain verification wiring |
| `015_phase_15_user_bank_accounts.sql` | Phase 15 | `bank_accounts` table — user-managed bank accounts for sell payouts |
| `016_phase_16_sell_usdt_workflow.sql` | Phase 16 | Hardened sell order workflow (server-side rate, bank ownership, idempotency) |
| `017_drop_legacy_sell_rpcs.sql` | Phase 17 | Drops legacy create_sell_order overloads (security cleanup) |
| `018_admin_manual_verify_independent_path.sql` | Phase 18 | Independent admin manual verification path |
| `019_credit_continuation_and_notification_counts.sql` | Phase 19 | Admin credit continuation + notification counts |
| `020_notifications.sql` | Phase 20 | User & admin notification system with event wiring in financial RPCs |
| `021_pre_reconstruction_cleanup.sql` | Phase 21 | Pre-reconstruction cleanup |
| `022_live_support_chat.sql` | Phase 22 | Live support chat (agent status, sessions, messages, RLS, Realtime, 16 RPCs) |
| `023_agent_heartbeat_race_hardening.sql` | Phase 23 | Agent heartbeat, stale-agent filtering, duplicate active-chat protection |
| `024_support_tickets.sql` | Support tickets | Ticket tables, messages, internal notes, RLS, and RPCs |
| `025_phase2_ticket_security_hardening.sql` | Ticket hardening | Tightens ticket permissions and authorization |
| `026_ticket_ux_fixes.sql` | Ticket fixes | Ticket workflow and UX-supporting database corrections |
| `027_fix_live_chat_return_functions.sql` | Chat fix | Corrects live-chat return functions |
| `028_end_chat_purge_history.sql` | Chat lifecycle | Purges ended live-chat history as designed |
| `029_stale_session_recovery.sql` | Chat recovery | Recovers stale support sessions |
| `030_chat_session_presence_heartbeat.sql` | Chat presence | Session presence heartbeat support |
| `031_fix_chat_rpc_ambiguity_and_type.sql` | Chat fix | Resolves RPC ambiguity and return types |
| `032_admin_users_management.sql` | Admin users | Admin user-management RPCs and controls |
| `033_fix_admin_list_users_ambiguity.sql` | Admin users fix | Resolves list-users ambiguity |
| `034_add_is_admin_to_list_users.sql` | Admin users | Adds admin state to user-list results |
| `035_passkey_2fa_support.sql` | Passkey 2FA | Passkey verification tokens and challenge replay protection |
| `036_phase_20_passkey_enrollment_authorization.sql` | Passkey enrollment | Server-side, short-lived enrollment authorization and credential trigger |
| `039_phase_22_login_assurance.sql` | Login assurance | Session-bound 2FA proof (`login_assurance` table, assurance RPCs) |
| `040_phase_23_assurance_user_context.sql` | Assurance fix | Adds `p_user_id` parameter for service-role Edge Function context |
| `041_phase_23c_resolve_assurance_overloads.sql` | Overload resolution | Drops all old overloads from M039/M040; re-creates single signatures with `DEFAULT NULL` for `p_user_id` |
| `042_phase_28_2fa_invariant_enforcement.sql` | 2FA invariant | `factor_removal_receipts` table, `_authorize_factor_removal` RPC, `_cleanup_factor_removal_receipt` RPC |

## Environment Variables

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Supabase anonymous key (public) |

**Edge Function secrets** (set via Supabase dashboard, never in client code):

| Secret | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL (auto-injected) |
| `SUPABASE_ANON_KEY` | Anon key (auto-injected) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (auto-injected) |
| `TOTP_ENCRYPTION_KEY` | AES-256-GCM key for encrypting TOTP secrets at rest |
| `BLOCKCHAIN_VERIFY_SECRET` | Shared secret for cron/service-role access to verify-trc20-deposit |
