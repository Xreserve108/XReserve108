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
 * Centralized wallet display refresh.
 * Fetches the authoritative balance from Supabase and updates every wallet
 * display element on the page (header pill, wallet page, sell page).
 *
 * Call this AFTER any server-confirmed wallet-affecting operation:
 *   - deposit credited / rejected
 *   - sell order completed / rejected / cancelled
 *   - sell order created (reserved USDT)
 *
 * Safe to call from any context — if no wallet elements exist (e.g. admin
 * layout), the function simply does nothing.
 */
export async function refreshWalletBalance() {
  const balance = await getWalletBalance();
  if (!balance || !isFinite(balance.available)) return;

  const formatted = formatBalance(balance.available);

  // Header pill (user layout — present on every user page)
  const headerEl = document.getElementById('wallet-balance-text');
  if (headerEl) headerEl.textContent = formatted;

  // Wallet page balance
  const walletEl = document.getElementById('wallet-balance');
  if (walletEl) {
    walletEl.textContent = '';
    walletEl.appendChild(document.createTextNode(formatted));
    const unit = document.createElement('span');
    unit.className = 'text-[18px] font-medium text-text-secondary dark:text-text-secondary-dark';
    unit.textContent = 'USDT';
    walletEl.appendChild(unit);
  }

  // Sell page balance
  const sellEl = document.getElementById('sell-balance');
  if (sellEl) {
    sellEl.innerHTML = `${formatted} <span class="text-[13px] font-medium text-text-secondary dark:text-text-secondary-dark">USDT</span>`;
  }

  // Homepage Instant Sell balance
  const homeEl = document.getElementById('home-balance');
  if (homeEl) {
    homeEl.textContent = formatted;
  }
}

function formatBalance(num) {
  const n = Number(num);
  if (!isFinite(n) || n < 0) return '0.00';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

// ---------------------------------------------------------------------------
// Global wallet heartbeat
//
// A single 15-second interval that keeps the wallet display synchronised
// with the authoritative server balance regardless of which page the user
// is on. Without this, wallet-affecting events (admin crediting a deposit,
// rejecting a sell order, etc.) would only be reflected when the user
// navigates to a page that happens to fetch the balance at render time.
//
// Why global:  the header pill (#wallet-balance-text) is present on every
//              authenticated user page, but previously it was only populated
//              once at layout creation. A page-scoped fetch cannot discover
//              remote changes that happen while the user stays on a page.
//
// Why it pauses while hidden:  there is no reason to consume network and
//              Supabase quota on a tab the user isn't looking at. When the
//              tab becomes visible again an immediate sync fires so the
//              displayed balance is never stale for more than a moment.
// ---------------------------------------------------------------------------

const WALLET_HEARTBEAT_MS = 15000;
let walletTimer = null;

/**
 * Start the global wallet heartbeat.
 * Safe to call multiple times — only one interval is ever created.
 */
export function startWalletHeartbeat() {
  if (walletTimer !== null) return;

  // Immediate sync so the display is correct from the start
  refreshWalletBalance();

  walletTimer = setInterval(() => {
    if (!document.hidden) {
      refreshWalletBalance();
    }
  }, WALLET_HEARTBEAT_MS);

  // When the tab becomes visible again, sync immediately rather than
  // waiting for the next 15-second tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && walletTimer !== null) {
      refreshWalletBalance();
    }
  });
}

/**
 * Stop the global wallet heartbeat and release the interval.
 */
export function stopWalletHeartbeat() {
  if (walletTimer !== null) {
    clearInterval(walletTimer);
    walletTimer = null;
  }
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
