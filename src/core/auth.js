import { supabase } from '@/lib/supabase';
import { normalizeUsername, usernameToEmail } from '@/core/username';

let currentUser = null;
let authLoaded = false;
let adminStatus = null; // null = unknown, true/false = cached
let twoFAVerified = false;
let authGateOpen = false;
let previousUserId = null; // Track user ID to detect actual user changes
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
  if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
    if (authGateOpen) {
      const newUser = session?.user || null;
      const newUserId = newUser?.id || null;
      
      // Detect if user actually changed
      const userChanged = previousUserId !== newUserId;
      previousUserId = newUserId;
      
      currentUser = newUser;
      
      // Only notify callbacks if user changed or it's initial session
      // For token refresh with same user, don't trigger full rebuild
      if (authGateOpen) {
        if (userChanged || event === 'INITIAL_SESSION') {
          notifyCallbacks('SIGNED_IN');
        } else if (event === 'TOKEN_REFRESHED') {
          notifyCallbacks('SESSION_REFRESHED');
        }
        // For SIGNED_IN with same user (session restoration), don't notify
        // to avoid unnecessary rebuilds
      }
    }
    // If gate closed, hold currentUser as null until 2FA verified
  } else if (event === 'SIGNED_OUT') {
    currentUser = null;
    previousUserId = null;
    twoFAVerified = false;
    authGateOpen = false;
  }
  adminStatus = null; // reset admin cache on auth change
  if (authGateOpen || event === 'SIGNED_OUT') {
    // Don't notify here, already handled above for SIGNED_IN/TOKEN_REFRESHED
    if (event === 'SIGNED_OUT') {
      notifyCallbacks('SIGNED_OUT');
    }
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

export async function openAuthGate() {
  authGateOpen = true;
  twoFAVerified = true;
  // Populate currentUser from the current session
  const { data: { session } } = await supabase.auth.getSession();
  currentUser = session?.user || null;
  previousUserId = currentUser?.id || null; // Set initial user ID
  if (currentUser) {
    notifyCallbacks('SIGNED_IN');
  }
}

export function is2FAVerified() {
  return twoFAVerified;
}

export function isAuthGateOpen() {
  return authGateOpen;
}
