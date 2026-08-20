import { createClient } from "npm:@supabase/supabase-js@2";
import { authenticator } from "npm:otplib@^10.2.3";

// -----------------------------------------------------------------------------
// CORS
// -----------------------------------------------------------------------------

export const CORS = {
  preflight: () =>
    new Response(null, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
      },
    }),
  json: (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  error: (msg: string, status: number) =>
    new Response(JSON.stringify({ error: msg }), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
};

// -----------------------------------------------------------------------------
// Auth — verify JWT, return user record
// -----------------------------------------------------------------------------

export async function verifyAuth(
  req: Request,
): Promise<{ userId: string; email: string }> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) throw new Error("Missing authorization header");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const client = createClient(supabaseUrl, anonKey);

  const token = authHeader.replace(/^Bearer\s+/i, "");
  const {
    data: { user },
    error,
  } = await client.auth.getUser(token);

  if (error || !user) throw new Error("Unauthorized");
  return { userId: user.id, email: user.email ?? "" };
}

// -----------------------------------------------------------------------------
// Service-role Supabase client (Edge Function only — never exposed to browser)
// -----------------------------------------------------------------------------

export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// -----------------------------------------------------------------------------
// AES-256-GCM encryption for TOTP secrets
// -----------------------------------------------------------------------------

async function deriveKey(raw: string): Promise<CryptoKey> {
  const buf = new TextEncoder().encode(raw);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await deriveKey(Deno.env.get("TOTP_ENCRYPTION_KEY")!);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const combined = new Uint8Array(iv.byteLength + ct.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ct), iv.byteLength);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptSecret(encrypted: string): Promise<string> {
  const key = await deriveKey(Deno.env.get("TOTP_ENCRYPTION_KEY")!);
  const data = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = data.slice(0, 12);
  const ct = data.slice(12);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ct,
  );
  return new TextDecoder().decode(pt);
}

// Version-aware decryption for key rotation support
// key_version 1 = TOTP_ENCRYPTION_KEY (current)
// Future versions can map to rotated keys via env vars (e.g. TOTP_ENCRYPTION_KEY_V2)
export async function decryptSecretByVersion(
  encrypted: string,
  keyVersion: number,
): Promise<string> {
  switch (keyVersion) {
    case 1:
      return decryptSecret(encrypted);
    default:
      throw new Error(`Unsupported key version: ${keyVersion}`);
  }
}

// -----------------------------------------------------------------------------
// SHA-256 hash helper (for code hashing / replay prevention)
// -----------------------------------------------------------------------------

export async function sha256(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// -----------------------------------------------------------------------------
// TOTP authenticator instance (shared)
// -----------------------------------------------------------------------------

export { authenticator };

// -----------------------------------------------------------------------------
// Request body helper
// -----------------------------------------------------------------------------

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
