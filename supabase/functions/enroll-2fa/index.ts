import {
  authenticator,
  CORS,
  encryptSecret,
  readJson,
  serviceClient,
  verifyAuth,
} from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return CORS.preflight();
  }
  if (req.method !== "POST") return CORS.error("Method not allowed", 405);

  try {
    // 1. Authenticate user
    const { userId, email } = await verifyAuth(req);
    const body = await readJson(req);
    const action = body.action as string | undefined;

    const supabase = serviceClient();

    // 2. Check if 2FA is already enabled
    const { data: existing } = await supabase
      .from("user_2fa")
      .select("enabled")
      .eq("user_id", userId)
      .single();

    if (existing?.enabled) {
      return CORS.error("2FA is already enabled", 400);
    }

    // 3. If action=reissue, just regenerate without resetting DB row
    //    Otherwise generate fresh secret
    const secret = authenticator.generateSecret();
    const otpauthUri = authenticator.keyuri(email, "XReserve", secret);

    // 4. Encrypt and upsert
    const encrypted = await encryptSecret(secret);

    const { error: upsertError } = await supabase.from("user_2fa").upsert(
      {
        user_id: userId,
        encrypted_secret: encrypted,
        enabled: false,
        key_version: 1,
        failed_attempts: 0,
        locked_until: null,
        last_code_hash: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

    if (upsertError) {
      console.error("enroll-2fa upsert error:", upsertError);
      return CORS.error("Failed to save enrollment", 500);
    }

    // 5. Audit log
    await supabase.from("audit_logs").insert({
      actor_id: userId,
      action: "2FA_ENROLLMENT_STARTED",
      target_type: "user_2fa",
      metadata: { user_id: userId },
    });

    return CORS.json({ secret, qr_uri: otpauthUri });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    const status = msg === "Unauthorized" ? 401 : 500;
    return CORS.error(msg, status);
  }
});
