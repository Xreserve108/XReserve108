# Edge Functions

XReserve uses Supabase Edge Functions (Deno) for TOTP operations, Passkey action verification and management, blockchain verification, and market data aggregation. Security-sensitive secrets and service-role operations remain server-side.

**Location**: `supabase/functions/`

**Runtime**: Deno with `otplib` (npm:otplib@^10.2.3) and `@supabase/supabase-js` (npm:@supabase/supabase-js@2)

---

## Shared Module (`_shared/common.ts`)

Provides utilities used by all Edge Functions:

| Export | Purpose |
|---|---|
| `CORS` | CORS helpers — `preflight`, `json(body, status)`, `error(msg, status)` |
| `verifyAuth(req)` | Extracts and validates JWT from `Authorization` header, returns `{ userId, email }` |
| `serviceClient()` | Creates a Supabase client with service-role key (bypasses RLS) |
| `encryptSecret(plaintext)` | AES-256-GCM encryption of TOTP secret using `TOTP_ENCRYPTION_KEY` |
| `decryptSecret(encrypted)` | AES-256-GCM decryption |
| `decryptSecretByVersion(encrypted, keyVersion)` | Version-aware decryption for key rotation support |
| `sha256(input)` | SHA-256 hash (for code hashing / replay prevention) |
| `authenticator` | Pre-instantiated `otplib.authenticator` instance (lowercase export from otplib) |
| `readJson(req)` | Safely parse request body as JSON |
| `extractSessionId(req)` | Decode JWT payload to extract the Supabase `session_id` claim (used for login assurance) |

### Encryption Details

- **Algorithm**: AES-256-GCM
- **Key derivation**: SHA-256 hash of `TOTP_ENCRYPTION_KEY` environment variable
- **IV**: 12 random bytes, prepended to ciphertext
- **Output**: Base64-encoded `IV + ciphertext`

### Key Rotation Support

- Each `user_2fa` record stores a `key_version` (default: 1)
- `decryptSecretByVersion(encrypted, keyVersion)` selects the correct key based on version
- Version 1 uses `TOTP_ENCRYPTION_KEY`; future versions can use rotated keys (e.g., `TOTP_ENCRYPTION_KEY_V2`)
- New enrollments always use the latest key version
- Existing secrets remain decryptable with their original key version

---

## Edge Functions

### `enroll-2fa`

**Purpose**: Begin 2FA enrollment — generate a TOTP secret and return it with a QR URI.

**Endpoint**: `POST /functions/v1/enroll-2fa`

**Auth**: Required (JWT)

**Request body**: `{}` (empty or optional `{ action: "reissue" }`)

**Process**:
1. Authenticate user via JWT
2. Check if 2FA is already enabled → reject if yes
3. Generate TOTP secret via `authenticator.generateSecret()`
4. Build `otpauth://` URI via `authenticator.keyuri(email, "XReserve", secret)`
5. Encrypt secret with AES-256-GCM
6. Upsert to `user_2fa` table (enabled=false, reset any prior state)
7. Insert audit log: `2FA_ENROLLMENT_STARTED`

**Response**: `{ secret: string, qr_uri: string }`

---

### `verify-2fa-setup`

**Purpose**: Confirm 2FA enrollment — verify the user's TOTP code, enable 2FA, generate recovery codes.

**Endpoint**: `POST /functions/v1/verify-2fa-setup`

**Auth**: Required (JWT)

**Request body**: `{ code: string }` (6-digit TOTP code)

**Process**:
1. Authenticate user
2. Validate code format (6 digits)
3. Read pending (not enabled) `user_2fa` record
4. Decrypt secret, verify TOTP code via `authenticator.verify()`
5. If invalid → increment `failed_attempts`, reject
6. Enable 2FA: set `enabled=true`, reset `failed_attempts`
7. Delete any existing recovery codes
8. Generate 10 recovery codes (8 chars each, crypto-random from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`)
9. Hash each code with SHA-256, insert into `recovery_codes` table
10. Insert audit log: `2FA_ENABLED`
11. Establish login assurance via `establish_login_assurance_direct(p_session_id, p_user_id)` — binds 2FA completion to the session

**Response**: `{ success: true, recovery_codes: string[] }`

---

### `verify-2fa`

**Purpose**: Verify a TOTP code and issue a single-use verification token for subsequent RPC calls.

**Endpoint**: `POST /functions/v1/verify-2fa`

**Auth**: Required (JWT)

**Request body**: `{ code: string, scope?: string }`

**Supported scopes**: `user_transaction`, `admin_financial`, `admin_settings`, `passkey_enrollment`

**Process**:
1. Authenticate user
2. Read enabled `user_2fa` record
3. Check lockout (rate limit):
   - If `locked_until` is in the future → reject with 429
   - If `failed_attempts >= 5` → lock for 15 minutes, reject with 429
4. Compute SHA-256 hash of submitted code
5. **Recovery code path**: Check if code hash matches any unused recovery code
   - If match: mark recovery code as used, reset failed attempts, create verification token
   - Audit log: `2FA_RECOVERY_USED`
6. **TOTP path**: Decrypt secret, verify via `authenticator.verify()`
   - If invalid: increment `failed_attempts`, audit log `2FA_FAILED_ATTEMPT`, reject
7. **Replay prevention**: If same code hash as `last_code_hash` and an active verification exists → reject
8. Create verification token in `user_2fa_verifications`:
   - `expires_at`: 5 minutes from now
   - `operation_scope`: provided scope or null
9. Update `user_2fa`: reset `failed_attempts`, set `last_verified_at`, set `last_code_hash`
10. Audit log: `2FA_VERIFIED`
11. **Login assurance** (when scope is `login`): establish assurance via `establish_login_assurance(p_session_id, p_verification_token, p_user_id)` — consumes the token and binds 2FA completion to the session

**Response**: `{ verification_id: string }`

**Verification Token Lifecycle**:
- Created with 5-minute TTL
- Bound to the authenticated user
- Single-use through atomic database consumption
- Strictly scoped; null-scoped tokens cannot authorize scoped operations
- Consumed through `_consume_verification_token(p_token_id, p_required_scope)` directly or through `_require_2fa_verification()`

---

### `verify-passkey-action`

**Purpose**: Verify a Passkey for a sensitive action and issue a scoped `verification_id` without replacing the current browser session.

**Auth**: Required JWT.

**Request body**: `{ challengeId, credential, scope? }`

**Process**:
1. Validate the JWT and scope
2. Call GoTrue's raw passkey verification endpoint with `apikey` (anon key) and `X-Supabase-Api-Version` headers only — NO `Authorization` header. The challenge itself is bound to the user's session, providing user context. Sending an Authorization header (user JWT or service key) causes GoTrue to reject with 403.
3. Require the returned user (from `user.id` in the response) to match the JWT user
4. Create a five-minute verification token through `_create_verification_token`
5. Store `source_challenge_id` for replay protection
6. Write `PASSKEY_ACTION_VERIFIED` audit metadata
7. **Login assurance** (when scope is `login`): establish assurance via `establish_login_assurance(p_session_id, p_verification_token, p_user_id)`

**Response**: `{ verification_id: string }`

The raw HTTP verification path is deliberate: using the SDK verification helper would save the returned session and notify auth subscribers, replacing the current session during transaction verification. The endpoint authenticates via the `apikey` header only (anon key) — the challenge itself is bound to the user's session, providing user context. Neither a user JWT nor a service role key should be sent in the `Authorization` header, as GoTrue rejects unexpected auth headers with 403. The `X-Supabase-Api-Version` header must match the SDK's expected version.

---

### `passkey-manage`

**Purpose**: List, rename, delete, and authorize registration of Passkeys.

**Auth**: Required JWT for every action.

**Actions**:
- `list` — list the authenticated user's credentials through the GoTrue admin API
- `rename` — update a credential's cosmetic friendly name
- `delete` — consume fresh `user_transaction` or `admin_financial` verification and enforce 2FA invariant via `_authorize_factor_removal`
- `authorize-enrollment` — consume a `passkey_enrollment` verification token and create a five-minute enrollment authorization
- `signup-authorize` — create a two-minute first-factor authorization for a new account with no existing factors
- `mandatory-authorize` — create a five-minute authorization for a legacy account with no existing factors; after successful mandatory Passkey registration, establishes login assurance via `establish_login_assurance_direct(p_session_id, p_user_id)`

Passkey registration itself remains a Supabase Auth/WebAuthn operation. The Edge Function creates the server-side authorization that the `auth.webauthn_credentials` insert trigger requires.

**Caller identity requirement**: `_consume_verification_token()` validates ownership through `auth.uid()`. Calls from this Edge Function must therefore preserve the authenticated user's JWT context when invoking that RPC; service-role table privileges alone do not provide the user's identity. The `delete` action creates a user-JWT client (same pattern as `authorize-enrollment`) for token consumption and invariant enforcement.

**2FA invariant enforcement (Phase 28)**: The `delete` action calls `_authorize_factor_removal('passkey', passkeyCount)` after listing passkeys. This uses a transaction-level advisory lock to serialize concurrent factor-removal operations. After successful GoTrue deletion, the receipt is cleaned up via `_cleanup_factor_removal_receipt('passkey')`.

---

### `disable-2fa`

**Purpose**: Disable the Authenticator after either direct TOTP verification or a fresh verification token, while preserving the 2FA invariant (at least one Passkey must remain).

**Endpoint**: `POST /functions/v1/disable-2fa`

**Auth**: Required (JWT)

**Request body**: `{ code: string }` or `{ verification_id: string, required_scope?: "user_transaction" | "admin_financial" }`

**Process**:
1. Authenticate user
2. Require either a TOTP code or `verification_id`
3. For a verification token, validate its allowed scope and consume it atomically (via user-JWT client)
4. For a TOTP code, validate format and verify it against the enabled encrypted secret
5. List passkeys via GoTrue admin API (`/auth/v1/admin/users/...`)
6. Call `_authorize_factor_removal('totp', passkeyCount)` to enforce the 2FA invariant
7. Set `enabled=false` on `user_2fa`
8. Delete recovery codes and active verification tokens
9. Insert audit log: `2FA_DISABLED`

**Response**: `{ success: true }`

**Phase 28 fixes applied**:
1. **GoTrue URL corrected**: Passkey-list fetch now uses `${supabaseUrl}/auth/v1/admin/users/...` (was missing `/auth/v1` prefix)
2. **User-JWT token consumption**: `_consume_verification_token` is now called via a user-JWT client (not service-role), preserving `auth.uid()` identity context
3. **Invariant enforcement**: Manual passkey count check replaced with `_authorize_factor_removal('totp', passkeyCount)` for race-safe enforcement

---

### `verify-trc20-deposit` (Phase 14)

**Purpose**: Verify a TRC20 USDT deposit on the Tron blockchain via the TronGrid API.

**Endpoint**: `POST /functions/v1/verify-trc20-deposit`

**Auth**: Admin JWT (with `admin_users` check) OR service-role via `BLOCKCHAIN_VERIFY_SECRET` header

**Request body**: `{ deposit_id: string }`

**Process**:
1. Authenticate caller (admin JWT or cron secret)
2. Fetch deposit from database (must be `PENDING_VERIFICATION` status)
3. Extract TXID from deposit record
4. Query TronGrid API: `GET https://api.trongrid.io/v1/accounts/{address}/transactions`
5. Search transaction list for matching TXID
6. Validate transaction:
   - Correct USDT TRC20 contract address (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`)
   - Transaction success (not failed/reverted)
   - Sufficient confirmations
   - Correct recipient address (matches `deposit_methods.deposit_address`)
7. Extract on-chain transfer amount (6 decimal precision)
8. Compare with declared amount
9. Update deposit: set `verified_amount`, update metadata with blockchain details
10. Return verification result

**Response**: `{ success: boolean, verified_amount?: number, details?: object }`

**Security**:
- USDT TRC20 contract address is hardcoded (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`)
- Destination address validated against `deposit_methods` table
- Admin JWT verified against `admin_users` table with `is_active` check
- Cron/service-role access via `BLOCKCHAIN_VERIFY_SECRET` environment variable
- No wallet crediting — verification only. Crediting requires separate admin action.

### `market-rates` (Market Pulse)

**Purpose**: Aggregate public USDT/USD spot reference prices (Binance, OKX, Bybit), derive a USD/INR cross rate from CoinGecko, and return per-exchange USDT/INR reference prices together with the authoritative XReserve platform rate.

**Endpoint**: `GET /functions/v1/market-rates`

**Auth**: None — public market data + read-only server-side DB access

**Process**:
1. Read `exchange_settings` (`platform_usdt_inr_rate`) via service-role client — server-side only, never exposed to the browser directly; failure is non-fatal (`xreserveRate: null`)
2. Fetch USDT/USD spot prices from Binance, OKX, Bybit in parallel (8s timeout each; per-source errors are isolated)
3. Fetch aggregate USDT/USD + USDT/INR from CoinGecko; derive cross rate `USDT_INR / USDT_USD`
4. Derive per-exchange USDT/INR: `exchange_usdt_usd × cross_rate`

**Response**: `{ xreserveRate, exchanges: [{ name, rate, usdRate, error }], usdInrRate, fetchedAt }`

**Security**:
- Price type: non-P2P reference/conversion prices (no direct USDT/INR spot pair exists on these exchanges); UI labels them "Market reference"
- `exchange_settings` has no client RLS access — the only browser read path is this function
- `xreserveRate` is read-only here; writes go exclusively through the `admin_update_exchange_rate` RPC (admin + `admin_settings` 2FA)

---

## Error Handling

All Edge Functions follow a consistent error pattern:

```typescript
catch (err) {
  const msg = err instanceof Error ? err.message : "Internal error";
  const status = msg === "Unauthorized" ? 401 : 500;
  return CORS.error(msg, status);
}
```

| Status | Meaning |
|---|---|
| 400 | Bad request (invalid code, 2FA not enabled, etc.) |
| 401 | Unauthorized (missing/invalid JWT) |
| 403 | Forbidden (authorization or credential ownership rejected) |
| 404 | Not found (2FA record, profile, credential, or deposit missing) |
| 405 | Method not allowed (non-POST requests) |
| 409 | Conflict (last-factor protection) |
| 429 | Rate limited (too many failed attempts) |
| 500 | Internal server error |

---

## Deno Configuration

Edge Functions use **direct `npm:` specifiers** for all imports — no `deno.json` or import map is required:

```typescript
import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticator } from "npm:otplib@^10.2.3";
```

### Important Notes

- **Do NOT use `jsr:` for `@supabase/supabase-js`** — the JSR CDN has known stability issues causing `BOOT_ERROR` (503). Always use `npm:@supabase/supabase-js@2`.
- **otplib exports lowercase `authenticator`** — the package provides a pre-instantiated instance, not a class. Import as `import { authenticator }` (not `Authenticator`).
- **No `deno.json` needed** — direct `npm:` specifiers work without a configuration file.

The `otplib` library provides TOTP generation and verification per RFC 6238.
