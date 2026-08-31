import {
  authenticator,
  CORS,
  decryptSecret,
  extractSessionId,
  readJson,
  serviceClient,
  sha256,
  verifyAuth,
} from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return CORS.preflight();
  }
  if (req.method !== "POST") return CORS.error("Method not allowed", 405);

  try {
    const { userId } = await verifyAuth(req);
    const body = await readJson(req);
    const code = body.code as string;
    const scope = body.scope as string | undefined;

    if (!code) return CORS.error("Code is required", 400);

    // Validate scope if provided
    const validScopes = ["user_transaction", "admin_financial", "admin_settings", "passkey_enrollment", "login"];
    if (scope && !validScopes.includes(scope)) {
      return CORS.error("Invalid operation scope", 400);
    }

    const supabase = serviceClient();

    // 1. Read 2FA record
    const { data: record, error } = await supabase
      .from("user_2fa")
      .select(
        "encrypted_secret, enabled, failed_attempts, locked_until, last_code_hash",
      )
      .eq("user_id", userId)
      .single();

    if (error || !record) return CORS.error("2FA record not found", 404);
    if (!record.enabled) return CORS.error("2FA is not enabled", 400);

    // 2. Rate-limit / lockout check
    if (record.locked_until && new Date(record.locked_until) > new Date()) {
      const mins = Math.ceil(
        (new Date(record.locked_until).getTime() - Date.now()) / 60000,
      );
      return CORS.error(
        `Too many failed attempts. Try again in ${mins} minutes`,
        429,
      );
    }
    if (record.failed_attempts >= 5) {
      const lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await supabase
        .from("user_2fa")
        .update({ locked_until: lockedUntil, failed_attempts: 0 })
        .eq("user_id", userId);
      return CORS.error("Too many failed attempts. Locked for 15 minutes", 429);
    }

    const codeHash = await sha256(code);

    // 3. Recovery-code path
    const { data: recoveryRows } = await supabase
      .from("recovery_codes")
      .select("id, code_hash, used")
      .eq("user_id", userId)
      .eq("used", false);

    if (recoveryRows) {
      for (const rc of recoveryRows) {
        if (rc.code_hash === codeHash) {
          // Mark recovery code as used
          await supabase
            .from("recovery_codes")
            .update({ used: true, used_at: new Date().toISOString() })
            .eq("id", rc.id);

          // Reset failed attempts
          await supabase
            .from("user_2fa")
            .update({
              failed_attempts: 0,
              last_verified_at: new Date().toISOString(),
            })
            .eq("user_id", userId);

          // Create verification token (5-min window)
          const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
          const { data: verRow } = await supabase
            .from("user_2fa_verifications")
            .insert({ user_id: userId, expires_at: expiresAt, operation_scope: scope || null })
            .select("id")
            .single();

          await supabase.from("audit_logs").insert({
            actor_id: userId,
            action: "2FA_RECOVERY_USED",
            target_type: "user_2fa",
            metadata: { user_id: userId, scope: scope || null },
          });

          // ── Login assurance (recovery-code path) ──
          if (scope === "login") {
            const sessionId = extractSessionId(req);
            if (sessionId) {
              await supabase.rpc("establish_login_assurance", {
                p_session_id: sessionId,
                p_verification_token: verRow.id,
                p_user_id: userId,
              });
            }
          }

          return CORS.json({ verification_id: verRow.id });
        }
      }
    }

    // 4. TOTP verification
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
        action: "2FA_FAILED_ATTEMPT",
        target_type: "user_2fa",
        metadata: { user_id: userId },
      });

      return CORS.error("Invalid code", 400);
    }

    // 5. Replay prevention — reject if same code was already verified
    if (record.last_code_hash && record.last_code_hash === codeHash) {
      const { data: activeVer } = await supabase
        .from("user_2fa_verifications")
        .select("id")
        .eq("user_id", userId)
        .eq("used", false)
        .gt("expires_at", new Date().toISOString())
        .limit(1);

      if (activeVer && activeVer.length > 0) {
        return CORS.error("Code already used. Wait for a new code.", 400);
      }
    }

    // 6. Create verification token with validated scope
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { data: verRow } = await supabase
      .from("user_2fa_verifications")
      .insert({ user_id: userId, expires_at: expiresAt, operation_scope: scope || null })
      .select("id")
      .single();

    // 7. Update last verified state
    await supabase
      .from("user_2fa")
      .update({
        failed_attempts: 0,
        last_verified_at: new Date().toISOString(),
        last_code_hash: codeHash,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    await supabase.from("audit_logs").insert({
      actor_id: userId,
      action: "2FA_VERIFIED",
      target_type: "user_2fa",
      metadata: { user_id: userId, verification_id: verRow.id, scope: scope || null },
    });

    // ── Login assurance (TOTP path) ──
    if (scope === "login") {
      const sessionId = extractSessionId(req);
      if (sessionId) {
        await supabase.rpc("establish_login_assurance", {
          p_session_id: sessionId,
          p_verification_token: verRow.id,
          p_user_id: userId,
        });
      }
    }

    return CORS.json({ verification_id: verRow.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    const status = msg === "Unauthorized" ? 401 : 500;
    return CORS.error(msg, status);
  }
});
