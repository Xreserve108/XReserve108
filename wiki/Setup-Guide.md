
Step-by-step instructions to get XReserve running locally.

---

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| [Node.js](https://nodejs.org/) | 18+ | JavaScript runtime |
| [npm](https://www.npmjs.com/) | 9+ | Package manager (bundled with Node.js) |
| [Supabase CLI](https://supabase.com/docs/guides/cli) | Latest | Database migrations, Edge Functions, local dev |
| A Supabase project | — | Hosted backend (database, auth, edge functions) |

---

## 1. Clone the Repository

```bash
git clone <repository-url>
cd Project
```

---

## 2. Install Dependencies

```bash
npm install
```

This installs all packages listed in `package.json`:

- **Runtime**: `@supabase/supabase-js`, `@supabase/ssr`, `lenis`, `qrcode`
- **Development**: `vite`, `tailwindcss`, `postcss`, `autoprefixer`

> **Note**: `node_modules/` is gitignored and must be generated locally. It is never committed to the repository.

---

## 3. Configure Environment Variables

Create a `.env` file in the project root by copying the example:

```bash
cp .env.example .env
```

Then fill in the two required variables:

| Variable | Description | Where to Find |
|---|---|---|
| `VITE_SUPABASE_URL` | Your Supabase project URL | Supabase Dashboard → Settings → API |
| `VITE_SUPABASE_ANON_KEY` | The public anonymous key for your project | Supabase Dashboard → Settings → API |

Example `.env` structure (values are project-specific):

```env
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

> **Important**: The `.env` file is gitignored. Never commit it to version control. Only variable names (never secret values) are referenced in documentation.

---

## 4. Set Up Supabase

### 4.1 Run Database Migrations

Apply all migration files in numerical order through migration 036 to create the current tables, RLS policies, RPC functions, triggers, support systems, and Passkey enrollment controls:

```bash
supabase migration up --linked --include-all --yes
```

Or apply them individually via the Supabase SQL Editor in the dashboard:

| Order | File | Contents |
|---|---|---|
| 1 | `001_database_foundation.sql` | Core tables (profiles, wallets, deposits, sell_orders, audit_logs), RLS, auto-provision trigger |
| 2 | `002_wallet_engine.sql` | Wallet operations, sell order functions, ledger entries |
| 3 | `003_admin_operations.sql` | Admin tables (admin_users, exchange_settings), admin RPC functions |
| 4 | `004_two_factor_auth.sql` | Initial 2FA schema (superseded by 005) |
| 5 | `005_edge_function_2fa.sql` | Edge Function-based 2FA, operation-scoped tokens |
| 6 | `006_phase_9b_security_hardening.sql` | Atomic token consumption, strict scope enforcement, deposit verification tokens, dead code removal |
| 7 | `007_phase_10a_username_auth.sql` | Username support in profiles |
| 8 | `008_phase_11_admin_security_hardening.sql` | Admin RPC security hardening, super_admin role |
| 9 | `009_phase_12a_active_deposit_methods.sql` | `deposit_methods` table — admin-configurable deposit addresses per network |
| 10 | `010_phase_12a_verification_used_at_fix.sql` | `used_at` column on `user_2fa_verifications` |
| 11 | `011_phase_12c_user_deposit_submission.sql` | `submit_deposit` RPC (replaces `create_deposit`), `get_user_pending_deposits` RPC |
| 11b | `011b_phase_12c_user_deposit_submission_safe_parts.sql` | **Corrective migration** — safe subset of 011 for production (excludes `admin_credit_deposit` redefinition that conflicts with 012) |
| 12 | `012_phase_12c_admin_credit_security_fix.sql` | Hardens `admin_credit_deposit` — only `PENDING` and `UNDER_REVIEW` are creditable |
| 13 | `013_phase_12c_admin_status_rpc_security_fix.sql` | Hardens `admin_update_deposit_status` — removes `CREDITED` from allowed target statuses |
| 14 | `014_phase_14_trc20_blockchain_verification.sql` | Blockchain verification columns, `request_blockchain_verification` RPC, `admin_manually_verify_deposit` RPC, `get_deposit_verification_details` RPC |
| 14b | `014b_phase_14_trc20_blockchain_verification_corrected.sql` | **Corrective migration** — corrected blockchain verification wiring |
| 15 | `015_phase_15_user_bank_accounts.sql` | `bank_accounts` table — user-managed bank accounts for sell payouts |
| 16 | `016_phase_16_sell_usdt_workflow.sql` | Hardened sell order workflow (server-side rate, bank ownership, idempotency) |
| 17 | `017_drop_legacy_sell_rpcs.sql` | Drops legacy `create_sell_order` overloads (security cleanup) |
| 18 | `018_admin_manual_verify_independent_path.sql` | Independent admin manual verification path |
| 19 | `019_credit_continuation_and_notification_counts.sql` | `admin_credit_verified_deposit` + `admin_notification_counts` |
| 20 | `020_notifications.sql` | `notifications` table + notification event wiring inside financial RPCs |
| 21 | `021_pre_reconstruction_cleanup.sql` | Pre-reconstruction cleanup |
| 22 | `022_live_support_chat.sql` | Live support chat: `support_agent_status`, `support_chat_sessions`, `support_chat_messages` tables, RLS, Realtime publication, 16 RPC functions |
| 23 | `023_agent_heartbeat_race_hardening.sql` | Agent heartbeat (`last_heartbeat_at`), stale-agent filtering (>3 min), duplicate active-chat unique index |
| 24 | `024_support_tickets.sql` | Support ticket tables, messages, internal notes, RLS, and RPCs |
| 25 | `025_phase2_ticket_security_hardening.sql` | Ticket authorization and permission hardening |
| 26 | `026_ticket_ux_fixes.sql` | Ticket workflow corrections supporting the current UI |
| 27 | `027_fix_live_chat_return_functions.sql` | Live-chat return-function corrections |
| 28 | `028_end_chat_purge_history.sql` | Ended-chat history purge behavior |
| 29 | `029_stale_session_recovery.sql` | Stale support-session recovery |
| 30 | `030_chat_session_presence_heartbeat.sql` | Chat-session presence heartbeat |
| 31 | `031_fix_chat_rpc_ambiguity_and_type.sql` | Chat RPC ambiguity and type corrections |
| 32 | `032_admin_users_management.sql` | Admin user-management functions |
| 33 | `033_fix_admin_list_users_ambiguity.sql` | Admin list-users ambiguity correction |
| 34 | `034_add_is_admin_to_list_users.sql` | Admin state in user-list results |
| 35 | `035_passkey_2fa_support.sql` | Passkey verification tokens and challenge replay prevention |
| 36 | `036_phase_20_passkey_enrollment_authorization.sql` | Server-side Passkey enrollment authorization and credential trigger |

> **Note on Migration 011b**: If migrations 012+ are already applied but 011 is missing, use `011b` instead of `011`. Migration 011b excludes Section 9 (the `admin_credit_deposit` redefinition) which would revert 012's security fix.

### 4.2 Configure Supabase Authentication

1. Enable email/password authentication in the Supabase project
2. Ensure the project Auth service supports the Passkey APIs used by `@supabase/auth-js`
3. XReserve maps each normalized username to a synthetic `@xreserve.com` email identity; users interact with usernames, not those internal email values
4. Confirm the deployed Auth schema provides `auth.webauthn_credentials` before applying migration 036
5. Keep session persistence and token refresh enabled in the frontend client

### 4.3 Deploy Edge Functions

Deploy the current Edge Functions to the Supabase project, including the security functions:

```bash
supabase functions deploy enroll-2fa --no-verify-jwt
supabase functions deploy verify-2fa --no-verify-jwt
supabase functions deploy verify-2fa-setup --no-verify-jwt
supabase functions deploy disable-2fa --no-verify-jwt
supabase functions deploy passkey-manage --no-verify-jwt
supabase functions deploy verify-passkey-action --no-verify-jwt
supabase functions deploy verify-trc20-deposit --no-verify-jwt
supabase functions deploy market-rates --no-verify-jwt
```

> **Note**: Migration 006 is self-contained and can be run directly in Supabase SQL Editor without CLI migrations. It creates all 2FA tables, functions, and security rules if missing, and safely updates existing ones.

### 4.2.1 Configure Realtime for Live Chat

After applying migrations, ensure Realtime is enabled for the live chat tables. Migration 022 automatically adds `support_chat_messages` and `support_chat_sessions` to the `supabase_realtime` publication. Verify in Supabase Dashboard → **Database** → **Replication** that both tables are enabled for Realtime.
```

### 4.4 Set Edge Function Secrets

The Edge Functions require encryption and API keys. Generate secure random keys and set them as Supabase secrets:

```bash
# Generate a random 32-character key for TOTP encryption
openssl rand -base64 32

# Generate a random 32-character secret for blockchain verification authentication
openssl rand -base64 32

# Set both as Supabase secrets
supabase secrets set TOTP_ENCRYPTION_KEY=<your-totp-key>
supabase secrets set BLOCKCHAIN_VERIFY_SECRET=<your-verify-secret>
```

| Secret | Used By | Purpose |
|---|---|---|
| `TOTP_ENCRYPTION_KEY` | All 2FA Edge Functions | AES-256-GCM encrypt/decrypt TOTP secrets at rest |
| `BLOCKCHAIN_VERIFY_SECRET` | `verify-trc20-deposit` | Authenticates RPC calls from the Edge Function to the database |

> **Note**: The `TOTP_ENCRYPTION_KEY` is used by Edge Functions to AES-256-GCM encrypt/decrypt TOTP secrets stored in the database. It is never exposed to the browser or stored in `.env`. The `BLOCKCHAIN_VERIFY_SECRET` is validated by the `request_blockchain_verification` RPC to ensure only authorized Edge Functions can trigger blockchain verification.

---

## 5. Create an Admin User

After signing up with a username and password, promote the intended user by inserting a controlled `admin_users` row. In production, prefer the existing super-admin management path rather than routine manual SQL changes:

```sql
INSERT INTO admin_users (user_id, role, is_active)
VALUES ('<your-user-uuid>', 'admin', true);
```

You can find your user UUID in Supabase Dashboard → **Authentication** → **Users**.

---

## 6. Configure Deposit Methods

Before users can deposit, an admin must configure at least one active deposit method:

1. Navigate to **Admin → Settings → Deposit Methods**
2. Add a deposit address for the TRC20 network
3. Toggle the method to active
4. A QR code is automatically generated for the address

> Users will see a "no deposit method available" screen until at least one method is active.

---

## 7. Run the Development Server

```bash
npm run dev
```

The app will be available at `http://localhost:3000`.

| Command | Description |
|---|---|
| `npm run dev` | Start Vite dev server (port 3000) |
| `npm run build` | Create production build in `dist/` |
| `npm run preview` | Serve the production build locally |

---

## 8. Verify the Setup

After starting the dev server, verify everything works:

1. **Sign in** — Enter the registered username and password.
2. **Mandatory security setup** — A new or legacy zero-factor account must configure an Authenticator or Passkey before application access.
3. **Login verification** — Accounts with configured factors must complete the available Authenticator/Passkey flow.
4. **Deposit flow** — Navigate to Deposit. You should see the network selection screen (if a deposit method is configured). Fill in the deposit form and submit.
5. **Admin panel** — If you created an admin user, navigate to `/admin/redirect` to access the admin dashboard.
6. **Admin deposit methods** — Go to Settings → Deposit Methods and configure a TRC20 address.

---

## Troubleshooting

### Authentication fails
- Confirm email/password authentication is enabled
- Verify username normalization and synthetic email mapping are consistent
- Confirm the account has completed mandatory Authenticator or Passkey setup
- Inspect Supabase Auth and Edge Function logs without exposing tokens or credentials

### Passkey enrollment fails
- Confirm `passkey-manage` and `verify-passkey-action` are deployed from the same repository revision
- Confirm migrations 035 and 036 are applied
- Verify `auth.webauthn_credentials` exists and `check_passkey_enrollment_auth` is installed
- Verify `supabase_auth_admin` has the migration 036 authorization-table grants
- Preserve exact `passkey_enrollment` scope and `_consume_verification_token(p_token_id, p_required_scope)` parameter names

### Edge Functions return 401/500
- Verify `TOTP_ENCRYPTION_KEY` secret is set: `supabase secrets list`
- Check Edge Function logs in Supabase Dashboard → **Edge Functions** → **Logs**

### Edge Functions return 503 BOOT_ERROR
- **Check imports**: Ensure `common.ts` uses `npm:@supabase/supabase-js@2` (NOT `jsr:`)
- **Check otplib import**: Must be `import { authenticator }` (lowercase), not `import { Authenticator }`
- **No `deno.json` needed**: Direct `npm:` specifiers work without configuration
- Check Edge Function logs in Supabase Dashboard → **Edge Functions** → select function → **Logs** tab → filter for "worker boot error"

### Blockchain verification fails
- Verify `BLOCKCHAIN_VERIFY_SECRET` is set: `supabase secrets list`
- Check `verify-trc20-deposit` Edge Function logs
- Ensure TronGrid API is accessible (check network/firewall)
- Verify the deposit method's `destination_address` is a valid TRC20 USDT address

### Database functions not found
- Ensure all migrations through 036 have been applied in order
- Check for errors in the Supabase SQL Editor or via `supabase migration up --linked`
- If 012+ was applied but 011 is missing, use `011b` (corrective migration)

### Port 3000 already in use
- Vite is configured to use port 3000. If occupied, either stop the other process or modify `vite.config.js`

### Blank page / JS errors
- Run `npm install` to ensure all dependencies are present
- Clear browser cache and reload
- Check browser console for errors related to Supabase connection

---

## Project Structure Quick Reference

```
src/
├── main.js          # App bootstrap (session restoration → auth state → router)
├── app.js           # Route definitions, layout switching
├── core/            # auth, router, theme, TOTP, Passkeys, smooth-scroll
├── lib/supabase.js  # Supabase client initialization
├── data/            # wallet-data, market-data, platform-rate
├── pages/           # User pages including auth, security, support, tickets, wallet, deposits, and orders
├── admin/           # Admin operations, users, security, notifications, live chat, and tickets
├── components/      # Shared UI components (incl. MarketPulse)
├── layouts/         # Admin layout wrapper
└── styles/app.css   # Tailwind + custom component classes

supabase/
├── functions/       # Deno Edge Functions, including TOTP and Passkey security functions
└── migrations/      # Sequential SQL migrations through 036
```

See the other wiki pages for detailed documentation on each module.
