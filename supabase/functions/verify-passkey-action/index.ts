import {
  CORS,
  extractSessionId,
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
    const { userId } = await verifyAuth(req);
    const body = await readJson(req);
    const challengeId = body.challengeId as string;
    const credential = body.credential as Record<string, unknown>;
    const scope = body.scope as string | undefined;

    if (!challengeId || !credential) {
      return CORS.error("challengeId and credential are required", 400);
    }

    // Validate scope if provided
    const validScopes = ["user_transaction", "admin_financial", "admin_settings", "passkey_enrollment", "login"];
    if (scope && !validScopes.includes(scope)) {
      return CORS.error("Invalid operation scope", 400);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // ─────────────────────────────────────────────────────────────
    // Step 1: Verify passkey authentication via RAW HTTP
    // ─────────────────────────────────────────────────────────────
    // We MUST NOT use the SDK's verifyAuthentication() because it calls
    // _saveSession() and _notifyAllSubscribers('SIGNED_IN'), which would
    // REPLACE the user's current browser session.
    // Raw HTTP gives us the verification result without side effects.
    //
    // IMPORTANT: GoTrue's passkey verify endpoint authenticates via the
    // apikey header ONLY (anon key).  It does NOT accept an Authorization
    // header — neither a user JWT nor a service role key.  The challenge
    // itself is bound to the user's session, providing user context.
    // The SDK also sends the X-Supabase-Api-Version header.
    // Sending unexpected auth headers causes GoTrue to reject with 403.
    const verifyRes = await fetch(
      `${supabaseUrl}/auth/v1/passkeys/authentication/verify`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": anonKey,
          "X-Supabase-Api-Version": "2024-01-01",
        },
        body: JSON.stringify({
          challenge_id: challengeId,
          credential: credential,
        }),
      },
    );

    const verifyData = await verifyRes.json();

    if (!verifyRes.ok) {
      const errMsg = verifyData.error || verifyData.msg || "Passkey verification failed";
      return CORS.error(errMsg, verifyRes.status);
    }

    // ─────────────────────────────────────────────────────────────
    // Step 2: Cross-account protection
    // ─────────────────────────────────────────────────────────────
    // The verified user (from GoTrue's response) MUST match the JWT
    // user. This prevents cross-account attacks.
    // GoTrue returns the credential owner in the `user` field of the
    // response (same format as a session response).
    const verifiedUserId = verifyData.user?.id || verifyData.credential_owner?.id;
    if (!verifiedUserId || verifiedUserId !== userId) {
      return CORS.error("Credential ownership mismatch", 403);
    }

    const supabase = serviceClient();

    // ─────────────────────────────────────────────────────────────
    // Step 3: Create verification token
    // ─────────────────────────────────────────────────────────────
    const { data: tokenRow, error: tokenError } = await supabase.rpc(
      "_create_verification_token",
      {
        p_user_id: userId,
        p_scope: scope || null,
        p_expires: "5 minutes",
        p_source_challenge_id: challengeId,
      },
    );

    if (tokenError || !tokenRow) {
      return CORS.error("Failed to create verification token", 500);
    }

    // ─────────────────────────────────────────────────────────────
    // Step 4: Audit log
    // ─────────────────────────────────────────────────────────────
    await supabase.from("audit_logs").insert({
      actor_id: userId,
      action: "PASSKEY_ACTION_VERIFIED",
      target_type: "verification_token",
      metadata: {
        user_id: userId,
        verification_id: tokenRow,
        scope: scope || null,
        challenge_id: challengeId,
      },
    });

    // ── Login assurance ──
    if (scope === "login") {
      const sessionId = extractSessionId(req);
      if (sessionId) {
        await supabase.rpc("establish_login_assurance", {
          p_session_id: sessionId,
          p_verification_token: tokenRow,
          p_user_id: userId,
        });
      }
    }

    return CORS.json({ verification_id: tokenRow });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    const status = msg === "Unauthorized" ? 401 : 500;
    return CORS.error(msg, status);
  }
});
