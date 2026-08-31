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

    if (!code || !/^\d{6}$/.test(code)) {
      return CORS.error("Invalid code format", 400);
    }

    const supabase = serviceClient();

    // 1. Read pending (not yet enabled) 2FA record
    const { data: record, error } = await supabase
      .from("user_2fa")
      .select("encrypted_secret, enabled, failed_attempts")
      .eq("user_id", userId)
      .single();

    if (error || !record) {
      return CORS.error("No pending 2FA enrollment", 400);
    }
    if (record.enabled) {
      return CORS.error("2FA is already enabled", 400);
    }

    // 2. Decrypt secret and verify TOTP code
    const secret = await decryptSecret(record.encrypted_secret);
    const isValid = authenticator.verify({ token: code, secret });

    if (!isValid) {
      // Increment failed attempts
      await supabase
        .from("user_2fa")
        .update({ failed_attempts: record.failed_attempts + 1 })
        .eq("user_id", userId);
      return CORS.error("Invalid code", 400);
    }

    // 3. Enable 2FA (key_version preserved for rotation support)
    await supabase
      .from("user_2fa")
      .update({
        enabled: true,
        failed_attempts: 0,
        locked_until: null,
        last_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    // 4. Generate 10 recovery codes
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const codes: string[] = [];

    // Delete any existing recovery codes first
    await supabase.from("recovery_codes").delete().eq("user_id", userId);

    for (let i = 0; i < 10; i++) {
      let rc = "";
      const randomBytes = new Uint8Array(8);
      crypto.getRandomValues(randomBytes);
      for (let j = 0; j < 8; j++) {
        rc += chars[randomBytes[j] % chars.length];
      }
      codes.push(rc);

      const hash = await sha256(rc);
      await supabase.from("recovery_codes").insert({
        user_id: userId,
        code_hash: hash,
      });
    }

    // 5. Audit log
    await supabase.from("audit_logs").insert({
      actor_id: userId,
      action: "2FA_ENABLED",
      target_type: "user_2fa",
      metadata: { user_id: userId },
    });

    // ── Establish login assurance after successful enrollment ──
    // The enrollment itself is the proof — no verification token consumed.
    const sessionId = extractSessionId(req);
    if (sessionId) {
      await supabase.rpc("establish_login_assurance_direct", {
        p_session_id: sessionId,
        p_user_id: userId,
      });
    }

    return CORS.json({ success: true, recovery_codes: codes });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    const status = msg === "Unauthorized" ? 401 : 500;
    return CORS.error(msg, status);
  }
});
