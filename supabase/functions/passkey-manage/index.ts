import { createClient } from "npm:@supabase/supabase-js@2";
import {
  CORS,
  extractSessionId,
  readJson,
  serviceClient,
  verifyAuth,
} from "../_shared/common.ts";

// ─────────────────────────────────────────────────────────────
// passkey-manage Edge Function
// ─────────────────────────────────────────────────────────────
// Server-enforced passkey management operations:
//   - delete: removes a passkey with last-factor protection
//   - rename: updates friendly name (cosmetic)
//   - list:   lists user's passkeys (via admin API)
//
// All operations require a valid JWT.
// Delete requires a verification_id (fresh 2FA verification).
// ─────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return CORS.preflight();
  }
  if (req.method !== "POST") return CORS.error("Method not allowed", 405);

  try {
    const { userId } = await verifyAuth(req);
    const body = await readJson(req);
    const action = body.action as string;

    if (!action) return CORS.error("action is required", 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = serviceClient();

    // ─────────────────────────────────────────────────────────
    // DELETE passkey
    // ─────────────────────────────────────────────────────────
    if (action === "delete") {
      const passkeyId = body.passkeyId as string;
      const verificationId = body.verification_id as string;

      if (!passkeyId) return CORS.error("passkeyId is required", 400);
      if (!verificationId) return CORS.error("verification_id is required", 400);

      // Validate required_scope against explicit whitelist
      const allowedScopes = ["user_transaction", "admin_financial"];
      const requestedScope = (body.required_scope as string) || "user_transaction";
      if (!allowedScopes.includes(requestedScope)) {
        return CORS.error("Invalid scope", 400);
      }

      // PHASE 30 FIX: Consume the verification token via serviceClient +
      // _consume_verification_token_internal.  The original
      // _consume_verification_token has EXECUTE revoked from authenticated
      // (Migration 006), so calling it via userClient/PostgREST fails with
      // "permission denied".  The internal variant accepts an explicit
      // p_user_id (from verifyAuth above) instead of auth.uid().
      // Security: userId comes from the validated JWT, NOT from the browser.
      const { error: consumeError } = await supabase.rpc(
        "_consume_verification_token_internal",
        {
          p_token_id: verificationId,
          p_required_scope: requestedScope,
          p_user_id: userId,
        }
      );
      if (consumeError) {
        return CORS.error(consumeError.message || "Invalid verification", 400);
      }

      // User-JWT client for RPCs that rely on auth.uid()
      const authorization = req.headers.get("authorization");
      if (!authorization) return CORS.error("Authentication required", 401);

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

      // List current passkeys via admin API (raw HTTP) — requires service-role
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

      if (!listRes.ok) {
        const errBody = await listRes.text().catch(() => "unknown");
        return CORS.error(`Failed to list passkeys: ${listRes.status} ${errBody}`, 500);
      }

      const passkeys: Array<{ id: string }> = await listRes.json();

      // Verify the target passkey belongs to this user
      const targetPasskey = passkeys.find((p) => p.id === passkeyId);
      if (!targetPasskey) {
        return CORS.error("Passkey not found", 404);
      }

      // PHASE 28: Server-side 2FA invariant enforcement via advisory lock.
      // Replaces the manual last-factor check with an atomic, race-safe check.
      const { error: invariantError } = await userClient.rpc(
        "_authorize_factor_removal",
        { p_factor_type: "passkey", p_current_passkey_count: passkeys.length }
      );
      if (invariantError) {
        return CORS.error(invariantError.message || "Factor removal not allowed", 409);
      }

      // Delete the passkey via admin API (raw HTTP)
      const deleteRes = await fetch(
        `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}/passkeys/${encodeURIComponent(passkeyId)}`,
        {
          method: "DELETE",
          headers: {
            "apikey": serviceKey,
            "Authorization": `Bearer ${serviceKey}`,
            "X-Supabase-Api-Version": "2024-01-01",
          },
        },
      );

      if (!deleteRes.ok) {
        const errData = await deleteRes.json().catch(() => ({}));
        return CORS.error(errData.error || "Failed to delete passkey", deleteRes.status);
      }

      // Clean up the factor removal receipt (best-effort)
      await userClient.rpc("_cleanup_factor_removal_receipt", {
        p_factor_type: "passkey",
      });

      // Audit log
      await supabase.from("audit_logs").insert({
        actor_id: userId,
        action: "PASSKEY_DELETED",
        target_type: "passkey",
        metadata: { passkey_id: passkeyId, user_id: userId },
      });

      return CORS.json({ success: true });
    }

    // ─────────────────────────────────────────────────────────
    // RENAME passkey
    // ─────────────────────────────────────────────────────────
    if (action === "rename") {
      const passkeyId = body.passkeyId as string;
      const friendlyName = body.friendlyName as string;

      if (!passkeyId) return CORS.error("passkeyId is required", 400);
      if (!friendlyName || friendlyName.trim().length === 0) {
        return CORS.error("friendlyName is required", 400);
      }
      if (friendlyName.length > 120) {
        return CORS.error("friendlyName must be 120 characters or less", 400);
      }

      // Rename via admin API (raw HTTP PATCH)
      const renameRes = await fetch(
        `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}/passkeys/${encodeURIComponent(passkeyId)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": serviceKey,
            "Authorization": `Bearer ${serviceKey}`,
            "X-Supabase-Api-Version": "2024-01-01",
          },
          body: JSON.stringify({ friendly_name: friendlyName.trim() }),
        },
      );

      if (!renameRes.ok) {
        const errData = await renameRes.json().catch(() => ({}));
        return CORS.error(errData.error || "Failed to rename passkey", renameRes.status);
      }

      return CORS.json({ success: true });
    }

    // ─────────────────────────────────────────────────────────
    // AUTHORIZE ENROLLMENT — existing user adding a passkey
    // ─────────────────────────────────────────────────────────
    // Consumes a verification token with scope "passkey_enrollment"
    // and creates a short-lived authorization for GoTrue registration.
    if (action === "authorize-enrollment") {
      const verificationId = body.verification_id as string;
      if (!verificationId) return CORS.error("verification_id is required", 400);

      // Invoke the narrow enrollment RPC with the already-validated user's JWT.
      // The database derives identity from auth.uid(); service role is not used.
      const authorization = req.headers.get("authorization");
      if (!authorization) return CORS.error("Authentication required", 401);

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

      const { data: authorized, error: authorizationError } = await userClient.rpc(
        "authorize_passkey_enrollment",
        { p_token_id: verificationId },
      );

      if (authorizationError || authorized !== true) {
        const message = authorizationError?.message || "Authorization was not created";
        const code = authorizationError?.code || "unknown";
        console.error("Passkey enrollment authorization RPC failed", { code, message });

        if (/not authenticated/i.test(message)) {
          return CORS.error("Authentication required", 401);
        }
        if (/expired/i.test(message)) {
          return CORS.error("Verification expired. Please verify again.", 400);
        }
        if (/already used/i.test(message)) {
          return CORS.error("Verification was already used. Please verify again.", 400);
        }
        if (/scope/i.test(message)) {
          return CORS.error("Verification is not valid for passkey enrollment.", 400);
        }
        if (/invalid verification token|ownership mismatch/i.test(message)) {
          return CORS.error("Verification is invalid. Please verify again.", 400);
        }

        return CORS.error("Failed to authorize passkey enrollment", 500);
      }

      return CORS.json({ success: true });
    }

    // ─────────────────────────────────────────────────────────
    // SIGNUP AUTHORIZE — new user enrolling first passkey
    // ─────────────────────────────────────────────────────────
    // No verification token needed (new users have no 2FA yet).
    // Strict conditions: account < 120s old, zero passkeys, no TOTP.
    if (action === "signup-authorize") {
      // Check account age (< 120 seconds)
      const { data: userRow } = await supabase
        .from("profiles")
        .select("created_at")
        .eq("id", userId)
        .single();

      if (!userRow) {
        return CORS.error("Profile not found", 404);
      }

      const accountAge = Date.now() - new Date(userRow.created_at).getTime();
      if (accountAge > 120_000) {
        return CORS.error("Account too old for signup passkey enrollment", 403);
      }

      // Check zero existing passkeys
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
      if (listRes.ok) {
        const passkeys = await listRes.json();
        if (Array.isArray(passkeys) && passkeys.length > 0) {
          return CORS.error("User already has passkeys", 403);
        }
      }

      // Check TOTP not enabled
      const { data: totpRecord } = await supabase
        .from("user_2fa")
        .select("enabled")
        .eq("user_id", userId)
        .single();
      if (totpRecord?.enabled) {
        return CORS.error("TOTP already enabled", 403);
      }

      // Create short-lived signup authorization (2-minute window)
      const { data: authRow, error: authError } = await supabase
        .from("passkey_enrollment_authorizations")
        .insert({
          user_id: userId,
          expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
          verification_method: "signup",
          is_signup: true,
        })
        .select("id")
        .single();

      if (authError || !authRow) {
        return CORS.error("Failed to create signup authorization", 500);
      }

      return CORS.json({ authorization_id: authRow.id });
    }

    // ─────────────────────────────────────────────────────────
    // MANDATORY AUTHORIZE — legacy zero-2FA user enrolling first passkey
    // ─────────────────────────────────────────────────────────
    // Same as signup-authorize but WITHOUT the account age check.
    // For legacy users who log in with password but have zero 2FA factors.
    if (action === "mandatory-authorize") {
      // Check zero existing passkeys
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
      if (listRes.ok) {
        const passkeys = await listRes.json();
        if (Array.isArray(passkeys) && passkeys.length > 0) {
          return CORS.error("User already has passkeys", 403);
        }
      }

      // Check TOTP not enabled
      const { data: totpRecord } = await supabase
        .from("user_2fa")
        .select("enabled")
        .eq("user_id", userId)
        .single();
      if (totpRecord?.enabled) {
        return CORS.error("TOTP already enabled", 403);
      }

      // Create authorization (5-minute window)
      const { data: authRow, error: authError } = await supabase
        .from("passkey_enrollment_authorizations")
        .insert({
          user_id: userId,
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          verification_method: "signup",
          is_signup: true,
        })
        .select("id")
        .single();

      if (authError || !authRow) {
        return CORS.error("Failed to create mandatory enrollment authorization", 500);
      }

      return CORS.json({ authorization_id: authRow.id });
    }

    // ─────────────────────────────────────────────────────────
    // MANDATORY COMPLETE — legacy zero-2FA user finished passkey registration
    // ─────────────────────────────────────────────────────────
    // Called by the frontend AFTER GoTrue registration succeeds.
    // Establishes login assurance (the passkey ceremony is the proof).
    if (action === "mandatory-complete") {
      // Validate zero TOTP (user chose passkey path, not TOTP)
      const { data: totpRecord } = await supabase
        .from("user_2fa")
        .select("enabled")
        .eq("user_id", userId)
        .single();
      if (totpRecord?.enabled) {
        return CORS.error("TOTP already enabled", 403);
      }

      // Validate at least one passkey exists (registration succeeded)
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
      if (listRes.ok) {
        const passkeys = await listRes.json();
        if (!Array.isArray(passkeys) || passkeys.length === 0) {
          return CORS.error("No passkeys found — registration may have failed", 403);
        }
      }

      // Establish login assurance
      const sessionId = extractSessionId(req);
      if (!sessionId) {
        return CORS.error("Session context lost", 400);
      }

      const { data: assuranceId, error: assuranceError } = await supabase.rpc(
        "establish_login_assurance_direct",
        { p_session_id: sessionId, p_user_id: userId },
      );

      if (assuranceError || !assuranceId) {
        return CORS.error("Failed to establish login assurance", 500);
      }

      return CORS.json({ success: true });
    }

    // ─────────────────────────────────────────────────────────
    // LIST passkeys
    // ─────────────────────────────────────────────────────────
    if (action === "list") {
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

      if (!listRes.ok) {
        const errBody = await listRes.text().catch(() => "unknown");
        return CORS.error(`Failed to list passkeys: ${listRes.status} ${errBody}`, 500);
      }

      const passkeys = await listRes.json();
      return CORS.json({ passkeys });
    }

    return CORS.error("Unknown action. Use: delete, rename, list, authorize-enrollment, signup-authorize, mandatory-authorize, or mandatory-complete", 400);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    const status = msg === "Unauthorized" ? 401 : 500;
    return CORS.error(msg, status);
  }
});
