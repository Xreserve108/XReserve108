# Edge Functions

XReserve uses Supabase Edge Functions (Deno) for all TOTP-related operations, blockchain verification, and market data aggregation. This ensures TOTP secrets are generated and verified in a secure server-side environment, blockchain data is fetched without exposing API keys to the browser, and the authoritative platform rate is read server-side without exposing `exchange_settings` to clients.

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

**Response**: `{ success: true, recovery_codes: string[] }`

---

### `verify-2fa`

**Purpose**: Verify a TOTP code and issue a single-use verification token for subsequent RPC calls.

**Endpoint**: `POST /functions/v1/verify-2fa`

**Auth**: Required (JWT)

**Request body**: `{ code: string, scope?: string }`

**Supported scopes**: `user_transaction`, `admin_financial`, `admin_settings`

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

**Response**: `{ verification_id: string }`

**Verification Token Lifecycle**:
- Created with 5-minute TTL
- Single-use (marked `used=true` when consumed by an RPC function)
- Scoped to an operation (e.g., `user_transaction`, `admin_financial`)
- Consumed by `_require_2fa_verification()` in PostgreSQL RPC functions

---

### `disable-2fa`

**Purpose**: Disable 2FA after verifying a valid TOTP code.

**Endpoint**: `POST /functions/v1/disable-2fa`

**Auth**: Required (JWT)

**Request body**: `{ code: string }` (6-digit TOTP code)

**Process**:
1. Authenticate user
2. Validate code format (6 digits)
3. Read enabled `user_2fa` record
4. Decrypt secret, verify TOTP code
5. If invalid: increment `failed_attempts`, audit log `2FA_DISABLE_FAILED`, reject
6. Set `enabled=false` on `user_2fa`
7. Delete all recovery codes
8. Delete all active verification tokens
9. Audit log: `2FA_DISABLED`

**Response**: `{ success: true }`

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
| 404 | Not found (2FA record missing, deposit not found) |
| 405 | Method not allowed (non-POST requests) |
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
