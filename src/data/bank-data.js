import { supabase } from '@/lib/supabase';

/**
 * Fetch the authenticated user's bank accounts.
 * RLS-scoped to auth.uid().
 * Returns array of bank account rows, newest first.
 */
export async function getBankAccounts() {
  const { data, error } = await supabase
    .from('bank_accounts')
    .select('id, bank_name, ifsc_code, account_number, account_holder_name, created_at')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

/**
 * Add a bank account for the authenticated user.
 * Requires a verification_id obtained from 2FA verification; the token is
 * consumed server-side by the add_bank_account RPC (_require_2fa_verification).
 * Server-side RPC + trigger enforce ownership and the 2-account maximum.
 * Returns the new account's UUID.
 */
export async function addBankAccount({ bankName, ifscCode, accountNumber, accountHolderName }, verificationId) {
  if (!verificationId) {
    throw new Error('2FA verification is required');
  }

  const { data, error } = await supabase.rpc('add_bank_account', {
    p_bank_name: bankName.trim(),
    p_ifsc_code: ifscCode.trim().toUpperCase(),
    p_account_number: accountNumber.trim(),
    p_account_holder_name: accountHolderName.trim(),
    p_verification_id: verificationId,
  });

  if (error) throw error;
  return data;
}

/**
 * Delete a bank account owned by the authenticated user.
 * Requires a verification_id obtained from 2FA verification; the token is
 * consumed server-side by the delete_bank_account RPC (_require_2fa_verification).
 * Server-side RPC enforces ownership and 2FA authorization.
 */
export async function deleteBankAccount(id, verificationId) {
  if (!verificationId) {
    throw new Error('2FA verification is required');
  }

  const { data, error } = await supabase.rpc('delete_bank_account', {
    p_bank_account_id: id,
    p_verification_id: verificationId,
  });

  if (error) throw error;
  return data;
}

/**
 * Mask an account number for display.
 * Shows only the last 4 digits, grouped as "XXXX XXXX 1234".
 * Falls back to fully masked if the number is too short.
 */
export function maskAccountNumber(accountNumber) {
  const raw = (accountNumber || '').trim();
  if (raw.length <= 4) return 'XXXX ' + raw;
  const last4 = raw.slice(-4);
  const prefixLength = raw.length - 4;
  const groupSize = 4;
  let masked = '';
  for (let i = 0; i < prefixLength; i += groupSize) {
    masked += 'XXXX ';
  }
  return (masked + last4).trim();
}

/**
 * Validate an Indian IFSC code.
 * Format: 4 alphabetic bank code + 0 + 6 alphanumeric branch code.
 */
export function isValidIFSC(ifsc) {
  const code = (ifsc || '').trim().toUpperCase();
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(code);
}
