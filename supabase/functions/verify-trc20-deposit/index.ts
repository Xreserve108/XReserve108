// XReserve Phase 14 — TRC20 USDT Blockchain Verification Edge Function
//
// Server-side verification of TRC20 USDT transactions on the TRON network.
// Uses TronGrid API (https://api.trongrid.io).
//
// TRIGGER MODES:
//   1. Admin-triggered (authenticated): { deposit_id: "..." } or { process_all: true }
//   2. Cron-triggered (service role):    { cron: true, secret: "..." }
//
// SECURITY:
//   - Requires EITHER a valid admin JWT OR a service-role secret
//   - Uses service-role Supabase client to update deposit records
//   - TRONGRID_API_KEY is read from environment, never exposed to browser
//   - All validation errors are logged as audit events
//   - Idempotent — calling multiple times has the same effect
//   - Provider timeouts are treated as RETRYABLE, not as failures
//
// DO NOT modify behavior. This function is the authoritative source of blockchain
// truth. The verified_amount it sets is the amount that will be credited.

import { CORS, readJson, serviceClient } from "../_shared/common.ts";

// =============================================================================
// CONFIGURATION
// =============================================================================

// Official USDT TRC20 contract address (Tether).
// Verified against Tether's official documentation.
// NEVER trust user-supplied token contract.
const USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// TRC20 USDT uses 6 decimal places.
const USDT_DECIMALS = 6;

// Minimum number of block confirmations required to consider a transaction final.
// 19 confirmations is the standard "definitely finalized" threshold for TRON.
const MIN_CONFIRMATIONS = 19;

// Maximum number of verification attempts per deposit before giving up.
const MAX_ATTEMPTS = 10;

// ERC-20/TRC-20 Transfer event signature hash (keccak256 of "Transfer(address,address,uint256)").
const TRANSFER_EVENT_SIG = "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// USDT contract address in hex (without 41 prefix) — for matching log event addresses.
// This is the hex representation of USDT_TRC20_CONTRACT above.
const USDT_TRC20_CONTRACT_HEX = "a614f803b6fd780986a42c78ec9c7f77e6ded13c";

// =============================================================================
// INTERFACES
// =============================================================================

interface Deposit {
  id: string;
  user_id: string;
  network: string;
  token: string;
  declared_amount: number | null;
  expected_amount: number;
  tx_hash: string | null;
  destination_address: string | null;
  status: string;
  blockchain_verification_attempts: number;
  blockchain_verification_error: string | null;
  blockchain_verified_at: string | null;
}

interface TronTransaction {
  txID: string;
  blockNumber: number;
  block_timestamp: number; // milliseconds
  ret: Array<{ contractRet: string }>;
  raw_data?: { contract: Array<{ parameter: { value: { to: string; amount: number } } }> };
}

interface Trc20Transfer {
  transaction_id: string;
  block: number;
  block_timestamp: number; // milliseconds
  from: string;
  to: string;
  value: string; // raw amount as string (USDT has 6 decimals)
  token_info: { address: string; symbol: string; decimals: number; name: string };
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Convert a raw TRC20 token amount (as a decimal string) to a human-readable amount.
 * USDT has 6 decimals, so 1000000 raw = 1.00 USDT.
 */
function rawToAmount(raw: string, decimals: number): number {
  const rawBig = BigInt(raw);
  const divisor = BigInt(10) ** BigInt(decimals);
  // Convert to a string with decimals to avoid floating point issues
  const whole = rawBig / divisor;
  const remainder = rawBig % divisor;
  if (remainder === 0n) return Number(whole);
  const remainderStr = remainder.toString().padStart(decimals, "0");
  return Number(`${whole}.${remainderStr}`);
}

/**
 * Convert a TRON hex address (0x... or 41...) to base58.
 * For destination matching, TronGrid API returns base58 addresses in trc20 transfers,
 * but contract transactions use hex. We compare against the destination_address
 * stored on the deposit, which is base58 (from deposit_methods table).
 */
function normalizeAddress(addr: string): string {
  if (!addr) return "";
  // Strip 0x prefix if present
  if (addr.startsWith("0x")) return addr.slice(2);
  // Strip 41 prefix if present (TRON hex format)
  if (addr.startsWith("41") && addr.length === 42) return addr.slice(2);
  return addr;
}

/**
 * Base58-encode a byte array (standard Base58 alphabet, no checksum).
 */
function base58Encode(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let result = "";
  for (let i = digits.length - 1; i >= 0; i--) result += ALPHABET[digits[i]];
  for (const byte of bytes) {
    if (byte === 0) result = "1" + result;
    else break;
  }
  return result;
}

/**
 * Convert a TRON hex address (20 bytes, with or without 41 prefix) to Base58Check.
 * Uses double-SHA-256 checksum per TRON address encoding standard.
 */
async function hexToBase58Address(hex: string): Promise<string> {
  if (hex.startsWith("0x")) hex = hex.slice(2);
  if (!hex.startsWith("41")) hex = "41" + hex;
  const addrBytes = new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  const h1 = new Uint8Array(await crypto.subtle.digest("SHA-256", addrBytes));
  const h2 = new Uint8Array(await crypto.subtle.digest("SHA-256", h1));
  const checksum = h2.slice(0, 4);
  const full = new Uint8Array(addrBytes.length + 4);
  full.set(addrBytes);
  full.set(checksum, addrBytes.length);
  return base58Encode(full);
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Query TRON Full Node API for transaction info by TXID.
 * Uses two endpoints:
 *   1. /wallet/gettransactionbyid — transaction body (ret, txID, raw_data)
 *   2. /wallet/gettransactioninfobyid — block number and timestamp
 * Returns null if the transaction is not found.
 * Throws on transient errors (timeout, 5xx).
 */
async function fetchTronTransaction(
  txid: string,
  apiKey: string,
): Promise<{ tx: TronTransaction; transfers: Trc20Transfer[] } | null> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(apiKey ? { "TRON-PRO-API-KEY": apiKey } : {}),
  };
  const body = JSON.stringify({ value: txid });

  // 1. Fetch transaction body (ret, txID, raw_data)
  const txResponse = await fetch("https://api.trongrid.io/wallet/gettransactionbyid", {
    method: "POST",
    headers,
    body,
  });

  if (txResponse.status === 404) return null;
  if (txResponse.status === 429) {
    throw new Error("RATE_LIMITED");
  }
  if (txResponse.status >= 500) {
    throw new Error(`TRONGRID_SERVER_ERROR_${txResponse.status}`);
  }
  if (!txResponse.ok) {
    throw new Error(`TRONGRID_TX_HTTP_${txResponse.status}`);
  }

  const txData = await txResponse.json();
  if (!txData.txID) return null;

  // 2. Fetch transaction info (block number, timestamp)
  const infoResponse = await fetch("https://api.trongrid.io/wallet/gettransactioninfobyid", {
    method: "POST",
    headers,
    body,
  });

  if (infoResponse.status === 404) return null;
  if (infoResponse.status === 429) {
    throw new Error("RATE_LIMITED");
  }
  if (infoResponse.status >= 500) {
    throw new Error(`TRONGRID_SERVER_ERROR_${infoResponse.status}`);
  }
  if (!infoResponse.ok) {
    throw new Error(`TRONGRID_INFO_HTTP_${infoResponse.status}`);
  }

  const infoData = await infoResponse.json();
  // Empty object or missing blockNumber means tx not yet confirmed — retryable
  if (!infoData.blockNumber) return null;

  // blockNumber may be decimal or hex depending on node version — handle both
  const blockNumber = typeof infoData.blockNumber === "string"
    ? parseInt(infoData.blockNumber, 16)
    : infoData.blockNumber;

  const blockTimestamp = typeof infoData.blockTimeStamp === "string"
    ? parseInt(infoData.blockTimeStamp, 16)
    : (infoData.blockTimeStamp || 0);

  // 3. Extract TRC20 Transfer events from transaction logs
  const transfers: Trc20Transfer[] = [];
  const logs: Array<{ address: string; topics: string[]; data: string }> = infoData.log || [];
  for (const log of logs) {
    // Only process logs from the USDT contract
    if (log.address !== USDT_TRC20_CONTRACT_HEX) continue;
    // Only process Transfer events
    if (!log.topics || log.topics[0] !== TRANSFER_EVENT_SIG) continue;
    // Transfer event requires at least 3 topics (sig + from + to)
    if (log.topics.length < 3) continue;

    // Extract 20-byte addresses from 32-byte ABI-padded topics (last 40 hex chars)
    const fromHex = log.topics[1].slice(-40);
    const toHex = log.topics[2].slice(-40);
    // Raw token amount from event data (hex → decimal string)
    const rawAmount = BigInt("0x" + (log.data || "0")).toString();

    // Convert hex addresses to Base58Check for comparison with deposit destination
    const from = await hexToBase58Address(fromHex);
    const to = await hexToBase58Address(toHex);

    transfers.push({
      transaction_id: infoData.id,
      block: blockNumber,
      block_timestamp: blockTimestamp,
      from,
      to,
      value: rawAmount,
      token_info: {
        address: USDT_TRC20_CONTRACT,
        symbol: "USDT",
        decimals: USDT_DECIMALS,
        name: "Tether USD",
      },
    });
  }

  const tx: TronTransaction = {
    txID: txData.txID,
    ret: txData.ret || [],
    blockNumber,
    block_timestamp: blockTimestamp,
    raw_data: txData.raw_data,
  };

  return { tx, transfers };
}

/**
 * Get the current block height from TronGrid.
 * Used to compute confirmations.
 */
async function fetchCurrentBlock(apiKey: string): Promise<number> {
  const response = await fetch("https://api.trongrid.io/wallet/getnowblock", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "TRON-PRO-API-KEY": apiKey } : {}),
    },
  });

  if (!response.ok) {
    throw new Error(`TRONGRID_BLOCK_HTTP_${response.status}`);
  }
  const data = await response.json();
  return data.block_header?.raw_data?.number ?? 0;
}

// =============================================================================
// MAIN VERIFICATION LOGIC
// =============================================================================

/**
 * Verify a single deposit by querying the TRON blockchain via TronGrid.
 * Returns a result object indicating success or specific failure.
 */
async function verifyDeposit(
  deposit: Deposit,
  apiKey: string,
): Promise<
  | {
      status: "verified";
      verified_amount: number;
      from_address: string;
      block_number: number;
      block_timestamp: string;
      confirmations: number;
    }
  | { status: "retryable"; error: string }
  | { status: "permanent_failure"; error: string }
> {
  if (!deposit.tx_hash) {
    return { status: "permanent_failure", error: "no tx_hash on deposit" };
  }
  if (!deposit.destination_address) {
    return {
      status: "permanent_failure",
      error: "no destination_address on deposit",
    };
  }

  // 1. Fetch the base transaction and TRC20 transfers (from event logs)
  let tx: TronTransaction | null;
  let transfers: Trc20Transfer[];
  try {
    const result = await fetchTronTransaction(deposit.tx_hash, apiKey);
    if (!result) {
      return {
        status: "retryable",
        error: "TX_NOT_FOUND (transaction not yet visible)",
      };
    }
    tx = result.tx;
    transfers = result.transfers;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 5xx and 429 are retryable
    if (msg.includes("RATE_LIMITED") || msg.includes("SERVER_ERROR") || msg.includes("TIMEOUT")) {
      return { status: "retryable", error: msg };
    }
    return { status: "retryable", error: msg };
  }

  // 2. Check transaction succeeded
  if (!tx.ret || tx.ret.length === 0) {
    return { status: "permanent_failure", error: "transaction has no return value" };
  }
  const contractRet = tx.ret[0].contractRet;
  if (contractRet !== "SUCCESS") {
    return {
      status: "permanent_failure",
      error: `transaction failed (contractRet: ${contractRet})`,
    };
  }

  // 3. Get current block for confirmation count
  let currentBlock: number;
  try {
    currentBlock = await fetchCurrentBlock(apiKey);
  } catch (err) {
    // If we can't get current block, treat as retryable
    return {
      status: "retryable",
      error: `cannot fetch current block: ${err instanceof Error ? err.message : err}`,
    };
  }

  const confirmations = currentBlock - tx.blockNumber + 1;
  if (confirmations < MIN_CONFIRMATIONS) {
    return {
      status: "retryable",
      error: `INSUFFICIENT_FINALITY: ${confirmations}/${MIN_CONFIRMATIONS} confirmations`,
    };
  }

  // 4. Check TRC20 transfers (extracted from transaction logs in step 1)
  if (transfers.length === 0) {
    return {
      status: "permanent_failure",
      error: "no TRC20 transfers found in transaction",
    };
  }

  // 5. Find the USDT transfer to our deposit address
  const expectedDest = deposit.destination_address;
  const usdtTransfer = transfers.find((t) => {
    if (t.token_info?.address !== USDT_TRC20_CONTRACT) return false;
    if (t.token_info?.symbol !== "USDT") return false;
    return normalizeAddress(t.to) === normalizeAddress(expectedDest);
  });

  if (!usdtTransfer) {
    return {
      status: "permanent_failure",
      error: "no USDT transfer to deposit address found",
    };
  }

  // 6. Extract and convert the amount
  const verifiedAmount = rawToAmount(usdtTransfer.value, USDT_DECIMALS);
  if (verifiedAmount <= 0) {
    return {
      status: "permanent_failure",
      error: "transferred amount is zero or negative",
    };
  }

  // 7. Block timestamp
  const blockTimestamp = new Date(tx.block_timestamp).toISOString();

  return {
    status: "verified",
    verified_amount: verifiedAmount,
    from_address: usdtTransfer.from,
    block_number: tx.blockNumber,
    block_timestamp: blockTimestamp,
    confirmations,
  };
}

/**
 * Process a single deposit: call verifyDeposit() and update the database.
 * Returns true if the deposit reached a terminal state (verified or permanent failure).
 */
async function processDeposit(
  supabase: ReturnType<typeof serviceClient>,
  deposit: Deposit,
  apiKey: string,
): Promise<{ terminal: boolean; verified: boolean; attempts: number; error?: string; manualOverride?: boolean }> {
  const result = await verifyDeposit(deposit, apiKey);

  if (result.status === "verified") {
    // Update deposit with verification data.
    //
    // TOCTOU PROTECTION: the update is CONDITIONAL — it applies only if no
    // manual override exists AT WRITE TIME (metadata verified_amount_source).
    // This makes the write atomic: a manual override committed between the
    // earlier metadata read and this write can never be overwritten by a
    // late blockchain result. 0 rows affected = the override won the race,
    // which is an intentional skip, not an error.
    const { data: updatedRows, error: updateErr } = await supabase
      .from("deposits")
      .update({
        verified_amount: result.verified_amount,
        blockchain_verified_at: new Date().toISOString(),
        blockchain_verification_data: {
          txid: deposit.tx_hash,
          from_address: result.from_address,
          to_address: deposit.destination_address,
          block_number: result.block_number,
          block_timestamp: result.block_timestamp,
          confirmations: result.confirmations,
          token_contract: USDT_TRC20_CONTRACT,
          token_symbol: "USDT",
          token_decimals: USDT_DECIMALS,
          network: "TRC20",
        },
        blockchain_provider: "trongrid",
        blockchain_verification_error: null,
        blockchain_verification_attempts: deposit.blockchain_verification_attempts + 1,
        blockchain_verification_last_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", deposit.id)
      .or("metadata->>verified_amount_source.is.null,metadata->>verified_amount_source.neq.manual_override")
      .select("id");

    if (updateErr) {
      console.error(`DB update error for ${deposit.id}:`, updateErr);
      return { terminal: false, verified: false, attempts: deposit.blockchain_verification_attempts + 1, error: updateErr.message };
    }

    if (!updatedRows || updatedRows.length === 0) {
      // Manual override won the race: verified_amount was established by an
      // admin between the read and this write. Do not touch it — skip.
      console.warn(`Blockchain write skipped for ${deposit.id}: manual_override present at write time`);
      await supabase.from("audit_logs").insert({
        actor_id: null,
        action: "DEPOSIT_BLOCKCHAIN_VERIFICATION_SKIPPED_MANUAL_OVERRIDE",
        target_type: "deposit",
        target_id: deposit.id,
        metadata: {
          deposit_id: deposit.id,
          tx_hash: deposit.tx_hash,
          reason: "manual override present at write time (conditional update affected 0 rows)",
          provider: "trongrid",
        },
      });
      return { terminal: true, verified: false, manualOverride: true, attempts: deposit.blockchain_verification_attempts };
    }

    // Audit log
    await supabase.from("audit_logs").insert({
      actor_id: null,
      action: "DEPOSIT_BLOCKCHAIN_VERIFIED",
      target_type: "deposit",
      target_id: deposit.id,
      metadata: {
        deposit_id: deposit.id,
        tx_hash: deposit.tx_hash,
        verified_amount: result.verified_amount,
        declared_amount: deposit.declared_amount,
        block_number: result.block_number,
        confirmations: result.confirmations,
        from_address: result.from_address,
        provider: "trongrid",
      },
    });

    return { terminal: true, verified: true, attempts: deposit.blockchain_verification_attempts + 1 };
  }

  if (result.status === "permanent_failure") {
    // Update deposit with error
    await supabase
      .from("deposits")
      .update({
        blockchain_verification_error: result.error,
        blockchain_verification_attempts: deposit.blockchain_verification_attempts + 1,
        blockchain_verification_last_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", deposit.id);

    await supabase.from("audit_logs").insert({
      actor_id: null,
      action: "DEPOSIT_BLOCKCHAIN_VERIFICATION_FAILED",
      target_type: "deposit",
      target_id: deposit.id,
      metadata: {
        deposit_id: deposit.id,
        tx_hash: deposit.tx_hash,
        attempts: deposit.blockchain_verification_attempts + 1,
        error: result.error,
        permanent: true,
        provider: "trongrid",
      },
    });

    return { terminal: true, verified: false, attempts: deposit.blockchain_verification_attempts + 1, error: result.error };
  }

  // retryable
  const newAttempts = deposit.blockchain_verification_attempts + 1;
  if (newAttempts >= MAX_ATTEMPTS) {
    // Give up after MAX_ATTEMPTS
    await supabase
      .from("deposits")
      .update({
        blockchain_verification_error: `Max attempts (${MAX_ATTEMPTS}) reached: ${result.error}`,
        blockchain_verification_attempts: newAttempts,
        blockchain_verification_last_attempt_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", deposit.id);

    await supabase.from("audit_logs").insert({
      actor_id: null,
      action: "DEPOSIT_BLOCKCHAIN_VERIFICATION_FAILED",
      target_type: "deposit",
      target_id: deposit.id,
      metadata: {
        deposit_id: deposit.id,
        attempts: newAttempts,
        error: `Max attempts reached: ${result.error}`,
        permanent: true,
        provider: "trongrid",
      },
    });

    return { terminal: true, verified: false, attempts: newAttempts, error: `Max attempts reached: ${result.error}` };
  }

  // Still retryable — just increment counter
  await supabase
    .from("deposits")
    .update({
      blockchain_verification_error: result.error,
      blockchain_verification_attempts: newAttempts,
      blockchain_verification_last_attempt_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", deposit.id);

  return { terminal: false, verified: false, attempts: newAttempts, error: result.error };
}

// =============================================================================
// EDGE FUNCTION ENTRYPOINT
// =============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return CORS.preflight();
  }
  if (req.method !== "POST") {
    return CORS.error("Method not allowed", 405);
  }

  try {
    const body = await readJson(req);
    const depositId = body.deposit_id as string | undefined;
    const processAll = body.process_all === true;
    const cronSecret = body.secret as string | undefined;

    // Determine authorization
    const authHeader = req.headers.get("authorization");
    let isAdmin = false;
    let isServiceRole = false;
    let authUserId: string | null = null;

    if (authHeader) {
      // Verify JWT and check if admin
      try {
        const { verifyAuth } = await import("../_shared/common.ts");
        const { userId } = await verifyAuth(req);
        authUserId = userId;
        const supabaseCheck = serviceClient();
        const { data: adminRow } = await supabaseCheck
          .from("admin_users")
          .select("user_id")
          .eq("user_id", userId)
          .eq("is_active", true)
          .maybeSingle();
        if (adminRow) isAdmin = true;
      } catch {
        // JWT verification failed — fall through to secret check
      }
    }

    // Service role check via shared secret
    const expectedSecret = Deno.env.get("BLOCKCHAIN_VERIFY_SECRET");
    if (cronSecret && expectedSecret && cronSecret === expectedSecret) {
      isServiceRole = true;
    }

    // Owner invocation: an authenticated non-admin user may trigger
    // verification of their OWN pending deposit only (single deposit_id,
    // never process_all). Ownership + status are enforced both here and
    // again in the scoped query below.
    let isOwnerRequest = false;
    if (!isAdmin && !isServiceRole) {
      if (
        authUserId &&
        depositId &&
        !processAll &&
        typeof depositId === "string" &&
        depositId.length > 0
      ) {
        isOwnerRequest = true;
      } else {
        return CORS.error("Unauthorized", 401);
      }
    }

    const apiKey = Deno.env.get("TRONGRID_API_KEY") || "";
    const supabase = serviceClient();

    // Fetch deposits to process
    let query = supabase
      .from("deposits")
      .select(
        "id, user_id, network, token, declared_amount, expected_amount, tx_hash, destination_address, status, blockchain_verification_attempts, blockchain_verification_error, blockchain_verified_at",
      )
      .eq("status", "PENDING_VERIFICATION")
      .is("blockchain_verified_at", null)
      .lt("blockchain_verification_attempts", MAX_ATTEMPTS)
      .order("created_at", { ascending: true })
      .limit(20);

    if (depositId) {
      query = supabase
        .from("deposits")
        .select(
          "id, user_id, network, token, declared_amount, expected_amount, tx_hash, destination_address, status, blockchain_verification_attempts, blockchain_verification_error, blockchain_verified_at",
        )
        .eq("id", depositId);

      // Owner invocations are additionally scoped to the caller's own
      // PENDING_VERIFICATION deposit (defense in depth: the EF writes
      // with service_role, bypassing RLS).
      if (isOwnerRequest) {
        query = query
          .eq("user_id", authUserId)
          .eq("status", "PENDING_VERIFICATION")
          .is("blockchain_verified_at", null)
          .lt("blockchain_verification_attempts", MAX_ATTEMPTS);
      }

      query = query.single();
    }

    const { data: deposits, error: fetchErr } = await query;
    if (fetchErr) {
      return CORS.error(`Failed to fetch deposits: ${fetchErr.message}`, 500);
    }

    const depositList: Deposit[] = Array.isArray(deposits) ? deposits : deposits ? [deposits] : [];

    if (depositList.length === 0) {
      return CORS.json({ processed: 0, verified: 0, failed: 0, results: [] });
    }

    // Process each deposit
    const results: Array<{
      deposit_id: string;
      status: "verified" | "retryable" | "permanent_failure" | "max_attempts" | "manual_override";
      attempts: number;
      verified_amount?: number;
      error?: string;
    }> = [];

    let verifiedCount = 0;
    let failedCount = 0;

    for (const deposit of depositList) {
      // MANUAL OVERRIDE PROTECTION: if an admin manual verification has
      // already established the verified amount (metadata
      // verified_amount_source = 'manual_override'), the automatic
      // blockchain path must NEVER overwrite it. Re-read the fresh row so
      // a late blockchain result cannot clobber the manual amount.
      const { data: freshRow, error: freshErr } = await supabase
        .from("deposits")
        .select("metadata")
        .eq("id", deposit.id)
        .maybeSingle();

      if (freshErr) {
        // Fail closed for this deposit: skip this run, retry next time.
        results.push({
          deposit_id: deposit.id,
          status: "retryable",
          attempts: deposit.blockchain_verification_attempts,
          error: `metadata re-read failed: ${freshErr.message}`,
        });
        continue;
      }

      if (freshRow?.metadata?.verified_amount_source === "manual_override") {
        await supabase.from("audit_logs").insert({
          actor_id: null,
          action: "DEPOSIT_BLOCKCHAIN_VERIFICATION_SKIPPED_MANUAL_OVERRIDE",
          target_type: "deposit",
          target_id: deposit.id,
          metadata: {
            deposit_id: deposit.id,
            tx_hash: deposit.tx_hash,
            reason: "verified_amount already established by admin manual override",
            provider: "trongrid",
          },
        });
        results.push({
          deposit_id: deposit.id,
          status: "manual_override",
          attempts: deposit.blockchain_verification_attempts,
        });
        continue;
      }

      const result = await processDeposit(supabase, deposit, apiKey);

      if (result.manualOverride) {
        // Manual override won the write race — intentionally skipped.
        results.push({
          deposit_id: deposit.id,
          status: "manual_override",
          attempts: result.attempts,
        });
        continue;
      }

      if (result.terminal) {
        if (result.verified) {
          verifiedCount++;
          results.push({
            deposit_id: deposit.id,
            status: "verified",
            attempts: result.attempts,
            verified_amount: deposit.expected_amount, // approximate; real value in DB
          });
        } else {
          failedCount++;
          results.push({
            deposit_id: deposit.id,
            status: "permanent_failure",
            attempts: result.attempts,
            error: result.error,
          });
        }
      } else {
        results.push({
          deposit_id: deposit.id,
          status: "retryable",
          attempts: result.attempts,
          error: result.error,
        });
      }

      // Rate limit ourselves to be polite to TronGrid
      await sleep(200);
    }

    return CORS.json({
      processed: depositList.length,
      verified: verifiedCount,
      failed: failedCount,
      results,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    console.error("verify-trc20-deposit error:", msg);
    return CORS.error(msg, 500);
  }
});
