import {
  authenticator,
  CORS,
  decryptSecret,
  readJson,
  serviceClient,
  sha256,
  verifyAuth,
} from "../_shared/common.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return CORS.preflight();
  }
  if (req.method !== "POST") return CORS.error("Method not allowed", 405);

  try {
    const { userId } = await verifyAuth(req);
    const body = await readJson(req);
    const code = body.code as string | undefined;
    const verificationId = body.verification_id as string | undefined;

    // Must provide either a TOTP code or a verification_id
    if (!code && !verificationId) {
      return CORS.error("Authenticator code or verification is required", 400);
    }

    const supabase = serviceClient();

    // HIGH-2 FIX: Create a user-JWT client for _consume_verification_token.
    // The RPC uses auth.uid() for ownership, which requires user-JWT context
    // (service-role returns NULL for auth.uid()).
    const authorization = req.headers.get("authorization");
    if (!authorization) return CORS.error("Authentication required", 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

    const userClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: { headers: { Authorization: authorization } },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );

    // ─────────────────────────────────────────────────────────
    // Authentication: verify the request via TOTP code or verification_id
    // ─────────────────────────────────────────────────────────
    if (verificationId) {
      // Passkey or TOTP verification token path
      // Validate required_scope against explicit whitelist
      const allowedScopes = ["user_transaction", "admin_financial"];
      const requestedScope = (body.required_scope as string) || "user_transaction";
      if (!allowedScopes.includes(requestedScope)) {
        return CORS.error("Invalid scope", 400);
      }

      // Use user-JWT client (HIGH-2 fix)
      const { error: consumeError } = await userClient.rpc(
        "_consume_verification_token",
        { p_token_id: verificationId, p_required_scope: requestedScope }
      );
      if (consumeError) {
        return CORS.error(consumeError.message || "Invalid verification", 400);
      }
    } else if (code) {
      // TOTP code path (existing flow)
      if (!/^\d{6}$/.test(code)) {
        return CORS.error("Valid 6-digit code is required", 400);
      }

      const { data: record, error } = await supabase
        .from("user_2fa")
        .select("encrypted_secret, enabled, last_code_hash, failed_attempts")
        .eq("user_id", userId)
        .single();

      if (error || !record) return CORS.error("2FA record not found", 404);
      if (!record.enabled) return CORS.error("2FA is not enabled", 400);

      const secret = await decryptSecret(record.encrypted_secret);
      const isValid = authenticator.verify({ token: code, secret });

      if (!isValid) {
        await supabase
          .from("user_2fa")
          .update({
            failed_attempts: record.failed_attempts + 1,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId);

        await supabase.from("audit_logs").insert({
          actor_id: userId,
          action: "2FA_DISABLE_FAILED",
          target_type: "user_2fa",
          metadata: { user_id: userId, reason: "invalid_code" },
        });

        return CORS.error("Invalid code", 400);
      }
    }

    // ─────────────────────────────────────────────────────────
    // 2FA invariant enforcement + last-factor protection
    // ─────────────────────────────────────────────────────────
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // HIGH-1 FIX: Corrected GoTrue admin URL to include /auth/v1 prefix
    const listRes = await fetch(
      `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}/passkeys`,
      {
        headers: {
          "apikey": serviceKey,
          "Authorization": `Bearer ${serviceKey}`,
          "X-Supabase-Api-Version": "2024-01-01",
        },
      },
    );

    let passkeyCount = 0;
    if (listRes.ok) {
      const passkeys = await listRes.json();
      passkeyCount = Array.isArray(passkeys) ? passkeys.length : 0;
    }

    // PHASE 28: Server-side 2FA invariant enforcement via advisory lock.
    // Replaces the manual passkey count check with an atomic, race-safe check.
    const { error: invariantError } = await userClient.rpc(
      "_authorize_factor_removal",
      { p_factor_type: "totp", p_current_passkey_count: passkeyCount }
    );
    if (invariantError) {
      return CORS.error(invariantError.message || "Factor removal not allowed", 409);
    }

    // ─────────────────────────────────────────────────────────
    // Disable TOTP
    // ─────────────────────────────────────────────────────────

    // 1. Disable 2FA (TOTP)
    await supabase
      .from("user_2fa")
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq("user_id", userId);

    // 2. Invalidate recovery codes
    await supabase.from("recovery_codes").delete().eq("user_id", userId);

    // 3. Invalidate active verification tokens
    await supabase.from("user_2fa_verifications").delete().eq("user_id", userId);

    // 4. Audit log
    await supabase.from("audit_logs").insert({
      actor_id: userId,
      action: "2FA_DISABLED",
      target_type: "user_2fa",
      metadata: { user_id: userId, passkeys_remaining: passkeyCount },
    });

    return CORS.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    const status = msg === "Unauthorized" ? 401 : 500;
    return CORS.error(msg, status);
  }
});
