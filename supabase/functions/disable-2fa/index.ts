import {
  authenticator,
  CORS,
  decryptSecret,
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

    if (!code || !/^\d{6}$/.test(code)) {
      return CORS.error("Valid 6-digit code is required", 400);
    }

    const supabase = serviceClient();

    // 1. Read enabled 2FA record
    const { data: record, error } = await supabase
      .from("user_2fa")
      .select("encrypted_secret, enabled, last_code_hash, failed_attempts")
      .eq("user_id", userId)
      .single();

    if (error || !record) return CORS.error("2FA record not found", 404);
    if (!record.enabled) return CORS.error("2FA is not enabled", 400);

    // 2. Verify TOTP code
    const secret = await decryptSecret(record.encrypted_secret);
    const isValid = authenticator.verify({ token: code, secret });

    if (!isValid) {
      // Replay check: if same code as last, still reject
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

    // 3. Disable 2FA
    await supabase
      .from("user_2fa")
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq("user_id", userId);

    // 4. Invalidate recovery codes
    await supabase.from("recovery_codes").delete().eq("user_id", userId);

    // 5. Invalidate active verification tokens
    await supabase.from("user_2fa_verifications").delete().eq("user_id", userId);

    // 6. Audit log
    await supabase.from("audit_logs").insert({
      actor_id: userId,
      action: "2FA_DISABLED",
      target_type: "user_2fa",
      metadata: { user_id: userId },
    });

    return CORS.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    const status = msg === "Unauthorized" ? 401 : 500;
    return CORS.error(msg, status);
  }
});
