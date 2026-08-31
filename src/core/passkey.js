import { supabase } from '@/lib/supabase';

// ─────────────────────────────────────────────────────────────
// Passkey helpers — client-side WebAuthn operations
// ─────────────────────────────────────────────────────────────
// These wrap the Supabase SDK passkey API and the custom
// verify-passkey-action Edge Function.
// ─────────────────────────────────────────────────────────────

/**
 * Call a passkey management Edge Function.
 */
async function callPasskeyEdge(name, body) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─────────────────────────────────────────────────────────────
// Passkey Registration
// ─────────────────────────────────────────────────────────────

/**
 * Internal: Execute the GoTrue two-step passkey registration.
 * Called after an authorization has been created (either signup or existing-user).
 * @returns {Promise<{ id: string, friendly_name?: string }>}
 */
async function _executeGoTrueRegistration() {
  // Step 1: Get registration options from server
  const { data: optionsData, error: optionsError } = await supabase.auth.passkey.startRegistration();
  if (optionsError) throw optionsError;

  // Step 2: Create credential via browser WebAuthn API
  const { deserializeCredentialCreationOptions, createCredential, serializeCredentialCreationResponse } = await import(
    '@supabase/auth-js/dist/module/lib/webauthn.js'
  );

  const publicKeyOptions = deserializeCredentialCreationOptions(optionsData.options);
  const { data: credential, error: credentialError } = await createCredential({ publicKey: publicKeyOptions });
  if (credentialError) throw credentialError;
  if (!credential) throw new Error('No credential returned');

  // Step 3: Serialize and verify with server
  // The DB trigger validates that an enrollment authorization exists
  const serialized = serializeCredentialCreationResponse(credential);
  const { data: verifyData, error: verifyError } = await supabase.auth.passkey.verifyRegistration({
    challengeId: optionsData.challenge_id,
    credential: serialized,
  });
  if (verifyError) throw verifyError;

  return verifyData;
}

/**
 * Register a passkey during signup.
 * First obtains a signup authorization, then executes GoTrue registration.
 * @returns {Promise<{ id: string, friendly_name?: string }>}
 */
export async function registerPasskeySignup() {
  // Step 1: Obtain signup authorization (validates account age, zero passkeys, no TOTP)
  await callPasskeyEdge('passkey-manage', { action: 'signup-authorize' });

  // Step 2: Execute GoTrue registration (trigger validates authorization)
  return _executeGoTrueRegistration();
}

/**
 * Register an additional passkey for an existing user.
 * Requires a verification_id from TOTP or existing-passkey verification.
 * @param {string} verificationId - From requireVerification('Add Passkey', 'passkey_enrollment')
 * @returns {Promise<{ id: string, friendly_name?: string }>}
 */
export async function registerPasskeyExisting(verificationId) {
  // Step 1: Consume verification token and create enrollment authorization
  await callPasskeyEdge('passkey-manage', {
    action: 'authorize-enrollment',
    verification_id: verificationId,
  });

  // Step 2: Execute GoTrue registration (trigger validates authorization)
  return _executeGoTrueRegistration();
}

/**
 * Register a passkey for a legacy zero-2FA user during mandatory setup.
 * Uses the signup-authorize path (no prior 2FA verification needed).
 * Validates: account < 120s old, zero passkeys, no TOTP.
 * @returns {Promise<{ id: string, friendly_name?: string }>}
 */
export async function registerPasskeyMandatory() {
  // Step 1: Obtain mandatory authorization (no account age check, validates zero 2FA)
  await callPasskeyEdge('passkey-manage', { action: 'mandatory-authorize' });

  // Step 2: Execute GoTrue registration (trigger validates authorization)
  const result = await _executeGoTrueRegistration();

  // Step 3: Establish login assurance (passkey ceremony is the proof)
  await callPasskeyEdge('passkey-manage', { action: 'mandatory-complete' });

  return result;
}

// ─────────────────────────────────────────────────────────────
// Passkey Authentication (login)
// ─────────────────────────────────────────────────────────────

/**
 * Sign in with a passkey.
 * Uses the SDK's signInWithPasskey which handles the full flow
 * and replaces the session (correct behavior for login).
 */
export async function signInWithPasskey() {
  const { data, error } = await supabase.auth.signInWithPasskey();
  if (error) throw error;
  return data;
}

/**
 * Establish login assurance after a successful passkey login.
 *
 * signInWithPasskey() already performs full WebAuthn authentication
 * through GoTrue — the ceremony IS the proof.  This function binds
 * that proof to the session by calling establish_login_assurance_direct
 * from the frontend (user JWT, auth.uid() works correctly).
 *
 * This replaces the old verifyPasskeyAction('login') path which
 * incorrectly required a SECOND passkey ceremony.
 */
export async function establishPasskeyLoginAssurance() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Not authenticated');

  // Extract session_id from the new JWT
  const token = session.access_token;
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid session');
  const payload = JSON.parse(atob(parts[1]));
  const sessionId = payload.session_id;
  if (!sessionId) throw new Error('No session_id in token');

  // Establish assurance — called with user's JWT so auth.uid() works
  const { data, error } = await supabase.rpc('establish_login_assurance_direct', {
    p_session_id: sessionId,
  });
  if (error) throw error;
  return data;
}

// ─────────────────────────────────────────────────────────────
// Passkey Transaction Verification
// ─────────────────────────────────────────────────────────────

/**
 * Perform a passkey ceremony for transaction/action verification.
 * Uses the two-step API + raw HTTP Edge Function to avoid
 * replacing the user's current session.
 *
 * @param {string} scope - Operation scope (e.g. 'user_transaction')
 * @returns {Promise<string>} verification_id
 */
export async function verifyPasskeyAction(scope) {
  // Step 1: Start authentication (get challenge options)
  const { data: optionsData, error: optionsError } = await supabase.auth.passkey.startAuthentication();
  if (optionsError) throw optionsError;

  // Step 2: Get credential from browser WebAuthn API
  const { deserializeCredentialRequestOptions, getCredential, serializeCredentialRequestResponse } = await import(
    '@supabase/auth-js/dist/module/lib/webauthn.js'
  );

  const publicKeyOptions = deserializeCredentialRequestOptions(optionsData.options);
  const { data: credential, error: credentialError } = await getCredential({ publicKey: publicKeyOptions });
  if (credentialError) throw credentialError;
  if (!credential) throw new Error('No credential returned');

  // Step 3: Serialize credential
  const serialized = serializeCredentialRequestResponse(credential);

  // Step 4: Send to Edge Function for raw HTTP verification
  // This does NOT replace the session (unlike the SDK's verifyAuthentication)
  const result = await callPasskeyEdge('verify-passkey-action', {
    challengeId: optionsData.challenge_id,
    credential: serialized,
    scope,
  });

  return result.verification_id;
}

// ─────────────────────────────────────────────────────────────
// Passkey Management
// ─────────────────────────────────────────────────────────────

/**
 * List user's passkeys via the passkey-manage Edge Function.
 * @returns {Promise<Array<{ id: string, friendly_name?: string, created_at: string }>>}
 */
export async function listPasskeys() {
  const data = await callPasskeyEdge('passkey-manage', { action: 'list' });
  return data.passkeys || [];
}

/**
 * Delete a passkey. Requires a fresh verification_id.
 * Server enforces last-factor protection.
 * @param {string} passkeyId
 * @param {string} verificationId
 * @param {string} [requiredScope] - Scope the token was created with (default: 'user_transaction')
 */
export async function deletePasskey(passkeyId, verificationId, requiredScope) {
  return callPasskeyEdge('passkey-manage', {
    action: 'delete',
    passkeyId,
    verification_id: verificationId,
    required_scope: requiredScope || undefined,
  });
}

/**
 * Rename a passkey (cosmetic).
 * @param {string} passkeyId
 * @param {string} friendlyName
 */
export async function renamePasskey(passkeyId, friendlyName) {
  return callPasskeyEdge('passkey-manage', {
    action: 'rename',
    passkeyId,
    friendlyName,
  });
}

/**
 * Check if the browser supports WebAuthn/passkeys.
 */
export function browserSupportsPasskeys() {
  return (
    typeof window !== 'undefined' &&
    'PublicKeyCredential' in window &&
    typeof navigator?.credentials?.create === 'function' &&
    typeof navigator?.credentials?.get === 'function'
  );
}
