// Username normalization and validation utilities

const RESERVED_USERNAMES = [
  'admin', 'administrator', 'root', 'system', 'support', 
  'help', 'api', 'null', 'undefined', 'moderator', 'staff'
];

const USERNAME_REGEX = /^[a-zA-Z0-9_.]+$/;
const MIN_LENGTH = 3;
const MAX_LENGTH = 24;

/**
 * Normalize username for display: trim whitespace only (preserve case)
 */
export function normalizeUsername(username) {
  if (!username || typeof username !== 'string') return '';
  return username.trim();
}

/**
 * Normalize username for authentication: lowercase + trim
 * Email-based auth is case-insensitive (RFC 5321)
 */
export function normalizeUsernameForAuth(username) {
  if (!username || typeof username !== 'string') return '';
  return username.trim().toLowerCase();
}

/**
 * Validate username format
 * Returns { valid: boolean, error?: string }
 */
export function validateUsername(username) {
  const normalized = normalizeUsername(username);
  
  if (!normalized) {
    return { valid: false, error: 'Username is required' };
  }
  
  if (normalized.length < MIN_LENGTH) {
    return { valid: false, error: 'Username must be at least 3 characters' };
  }
  
  if (normalized.length > MAX_LENGTH) {
    return { valid: false, error: 'Username must be 24 characters or less' };
  }
  
  if (!USERNAME_REGEX.test(normalized)) {
    return { 
      valid: false, 
      error: 'Username can only contain letters, numbers, dots, and underscores' 
    };
  }
  
  if (RESERVED_USERNAMES.includes(normalized.toLowerCase())) {
    return { valid: false, error: 'This username is reserved' };
  }
  
  return { valid: true, error: null };
}

/**
 * Convert username to synthetic email for Supabase Auth
 * Uses lowercase normalization (email auth is case-insensitive)
 * Internal use only - never expose to users
 */
export function usernameToEmail(username) {
  const normalized = normalizeUsernameForAuth(username);
  return `${normalized}@xreserve.com`;
}

/**
 * Extract username from synthetic email
 * Returns null if not a valid XReserve synthetic email
 */
export function emailToUsername(email) {
  if (!email || typeof email !== 'string') return null;
  const match = email.match(/^(.+)@xreserve\.com$/i);
  return match ? match[1] : null;
}

/**
 * Check if email is a synthetic XReserve email
 */
export function isSyntheticEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return email.endsWith('@xreserve.com');
}
