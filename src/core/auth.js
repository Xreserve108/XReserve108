import { supabase } from '@/lib/supabase';
import { normalizeUsername, usernameToEmail } from '@/core/username';

let currentUser = null;
let authLoaded = false;
let adminStatus = null; // null = unknown, true/false = cached
let twoFAVerified = false;
let authGateOpen = false;
let login2faPending = false; // true during LOGIN 2FA challenge
let previousUserId = null; // Track user ID to detect actual user changes
let sessionId = null; // Current Supabase session_id (stable across token refreshes)
const authCallbacks = [];

export async function signUpWithUsername(username, password) {
  const displayUsername = normalizeUsername(username); // preserve case for display
  const syntheticEmail = usernameToEmail(displayUsername); // lowercases internally
  
  const { data, error } = await supabase.auth.signUp({
    email: syntheticEmail,
    password: password,
    options: {
      data: {
        username: displayUsername, // original case for display
        full_name: displayUsername,
      },
    },
  });
  
  if (error) throw error;
  return data;
}

export async function signInWithUsername(username, password) {
  const syntheticEmail = usernameToEmail(username); // lowercases for auth
  
  const { data, error } = await supabase.auth.signInWithPassword({
    email: syntheticEmail,
    password: password,
  });
  
  if (error) throw error;
  return data;
}

export async function signOut() {
  // Clear local state FIRST so listeners see the reset
  currentUser = null;
  previousUserId = null;
  sessionId = null;
  twoFAVerified = false;
  authGateOpen = false;
  login2faPending = false;
  adminStatus = null;

  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

export function getUser() {
  return currentUser;
}

export function getDisplayUsername() {
  if (!currentUser) return null;
  // Try to get username from metadata (set during username/password signup)
  const username = currentUser.user_metadata?.username;
  if (username) return username;
  // Fallback: extract from synthetic email
  const email = currentUser.email;
  if (email && email.endsWith('@xreserve.com')) {
    return email.replace('@xreserve.com', '');
  }
  // Fallback: use full_name or email prefix
  return currentUser.user_metadata?.full_name || email?.split('@')[0] || null;
}

export function isAuthenticated() {
  return currentUser !== null;
}

export function isAuthLoaded() {
  return authLoaded;
}

export async function isAdmin() {
  if (adminStatus !== null) return adminStatus;
  if (!currentUser) return false;
  const { data, error } = await supabase.rpc('is_admin_user');
  if (error) {
    adminStatus = false;
    return false;
  }
  adminStatus = !!data;
  return adminStatus;
}

export async function requireAdmin() {
  const admin = await isAdmin();
  if (!admin) throw new Error('Admin access required');
  return true;
}

export function onAuthStateChange(callback) {
  authCallbacks.push(callback);
}

function notifyCallbacks(event) {
  authCallbacks.forEach((cb) => cb(event, currentUser));
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
    // INITIAL_SESSION / SIGNED_IN: do NOT auto-populate currentUser.
    // openAuthGate() and completeLogin2FA() are the ONLY paths that
    // set currentUser — both require server-side assurance first.
    if (authGateOpen && !login2faPending) {
      const newUser = session?.user || null;
      const newUserId = newUser?.id || null;
      const userChanged = previousUserId !== newUserId;
      previousUserId = newUserId;
      currentUser = newUser;
      sessionId = _extractSessionId(session);

      if (userChanged || event === 'INITIAL_SESSION') {
        notifyCallbacks('SIGNED_IN');
      }
    }
  } else if (event === 'TOKEN_REFRESHED') {
    if (authGateOpen && !login2faPending) {
      const newUser = session?.user || null;
      const newUserId = newUser?.id || null;
      const newSessionId = _extractSessionId(session);

      // Re-verify assurance after token refresh (defense in depth).
      // The session_id is stable across refreshes so the same assurance
      // record should remain valid.
      _verifyAssurance(newSessionId).then(ok => {
        if (!ok) {
          // Assurance lost — force sign-out
          signOut().catch(() => {});
          return;
        }
        const userChanged = previousUserId !== newUserId;
        previousUserId = newUserId;
        currentUser = newUser;
        sessionId = newSessionId;

        if (userChanged) {
          notifyCallbacks('SIGNED_IN');
        } else {
          notifyCallbacks('SESSION_REFRESHED');
        }
      });
    }
  } else if (event === 'SIGNED_OUT') {
    currentUser = null;
    previousUserId = null;
    sessionId = null;
    twoFAVerified = false;
    authGateOpen = false;
    login2faPending = false;
  }
  adminStatus = null; // reset admin cache on auth change
  if (event === 'SIGNED_OUT') {
    notifyCallbacks('SIGNED_OUT');
  }
});

export async function initAuth() {
  // Wait for INITIAL_SESSION event before resolving
  await new Promise((resolve) => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        // Don't set currentUser yet — wait for 2FA gate to open
        subscription.unsubscribe();
        resolve();
      } else if (event === 'SIGNED_OUT') {
        subscription.unsubscribe();
        resolve();
      }
    });
  });
  
  // Get the current session after waiting for auth state
  const { data: { session } } = await supabase.auth.getSession();
  authLoaded = true;
  return session?.user || null;
}

/**
 * Open the authentication gate — ONLY if server-side login assurance
 * confirms the current session completed 2FA.  If no session exists or
 * assurance is missing, the gate stays closed and currentUser remains null.
 *
 * Called once from main.js during app bootstrap.
 */
export async function openAuthGate() {
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    // No session — gate stays closed, no user
    authGateOpen = true;
    authLoaded = true;
    return;
  }

  const sid = _extractSessionId(session);
  const assured = await _verifyAssurance(sid);

  authGateOpen = true;

  if (assured) {
    twoFAVerified = true;
    sessionId = sid;
    currentUser = session.user || null;
    previousUserId = currentUser?.id || null;
    if (currentUser) {
      notifyCallbacks('SIGNED_IN');
    }
  }
  // If !assured: currentUser stays null, gate is open but no user is set.
  // main.js will detect this and redirect to signin.
}

export function is2FAVerified() {
  return twoFAVerified;
}

export function isAuthGateOpen() {
  return authGateOpen;
}

export function isLogin2faPending() {
  return login2faPending;
}

export function setLogin2faPending(pending) {
  login2faPending = pending;
}

/**
 * Complete the login 2FA flow.
 * The Edge Functions (verify-2fa / verify-passkey-action / verify-2fa-setup /
 * passkey-manage mandatory-complete) have ALREADY established login assurance
 * server-side.  This function checks that assurance and, if valid, opens the
 * gate and populates currentUser.
 *
 * If assurance is missing (should not happen in normal flow), the user is
 * signed out for security.
 */
export async function completeLogin2FA() {
  const { data: { session } } = await supabase.auth.getSession();
  const sid = _extractSessionId(session);
  const assured = await _verifyAssurance(sid);

  if (!assured) {
    // Server did not confirm 2FA completion — fail closed
    login2faPending = false;
    await signOut().catch(() => {});
    throw new Error('Login assurance failed');
  }

  login2faPending = false;
  twoFAVerified = true;
  sessionId = sid;
  currentUser = session?.user || null;
  previousUserId = currentUser?.id || null;
  if (currentUser) {
    notifyCallbacks('SIGNED_IN');
  }
}

// ─────────────────────────────────────────────────────────────
// Internal helpers — session assurance
// ─────────────────────────────────────────────────────────────

/**
 * Extract the stable session_id from a Supabase session object.
 * The session_id is embedded in the JWT payload and persists across
 * access-token refreshes within the same browser session.
 */
function _extractSessionId(session) {
  try {
    const token = session?.access_token;
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return typeof payload.session_id === 'string' ? payload.session_id : null;
  } catch {
    return null;
  }
}

/**
 * Query the server to check whether a login assurance record exists
 * for the given session_id.  Returns false when there is no session,
 * no session_id, or the server says assurance is missing.
 */
async function _verifyAssurance(sid) {
  if (!sid) return false;
  try {
    const { data, error } = await supabase.rpc('check_login_assurance', {
      p_session_id: sid,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}
