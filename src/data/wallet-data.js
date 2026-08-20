import { supabase } from '@/lib/supabase';

/**
 * Fetch the authenticated user's wallet balance.
 * Uses RLS-protected wallet_balances table (scoped via wallets.user_id).
 * Returns { available, reserved } or null on error.
 */
export async function getWalletBalance() {
  const { data, error } = await supabase
    .from('wallet_balances')
    .select('available_usdt, reserved_usdt')
    .single();

  if (error || !data) return null;
  return {
    available: Number(data.available_usdt) || 0,
    reserved: Number(data.reserved_usdt) || 0,
  };
}

/**
 * Fetch the authenticated user's transaction history from the REAL order
 * records: deposits + sell_orders (both RLS-scoped to auth.uid()).
 * Shows the current DB status of each record, newest first by created_at.
 * Returns array of TransactionItem-compatible objects.
 */
export async function getTransactions(limit = 50) {
  const [depositRes, sellRes] = await Promise.all([
    supabase
      .from('deposits')
      .select('expected_amount, actual_amount, status, created_at')
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('sell_orders')
      .select('usdt_amount, status, created_at')
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);

  const deposits = !depositRes.error && depositRes.data
    ? depositRes.data.map((d) => ({
        type: 'deposit',
        title: 'Deposit',
        amount: formatAmount(d.actual_amount != null ? d.actual_amount : d.expected_amount),
        currency: 'USDT',
        date: formatDate(d.created_at),
        status: d.status || '',
        sortAt: d.created_at,
      }))
    : [];

  const sells = !sellRes.error && sellRes.data
    ? sellRes.data.map((o) => ({
        type: 'sell',
        title: 'Sell order',
        amount: formatAmount(o.usdt_amount),
        currency: 'USDT',
        date: formatDate(o.created_at),
        status: o.status || '',
        sortAt: o.created_at,
      }))
    : [];

  return [...deposits, ...sells]
    .sort((a, b) => new Date(b.sortAt).getTime() - new Date(a.sortAt).getTime())
    .slice(0, limit);
}

function formatAmount(num) {
  const n = Number(num);
  if (!isFinite(n) || n < 0) return '0.00';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
