import { supabase } from '@/lib/supabase';

// =============================================================================
// Admin navigation notification badges
// =============================================================================
// Real counts from admin_notification_counts (server-side admin-only RPC):
//   Deposits = deposits currently requiring admin action
//              (status PENDING_VERIFICATION — authoritative DB status;
//              opening the section NEVER resets this count)
//   Orders   = sell orders currently requiring admin action
//              (PAYMENT_PROOF_UPLOADED, MANUAL_REVIEW — same semantics)
//   Users    = newly registered users (last 7 days) NOT YET SEEN by this
//              admin. Opening the Users section records a "seen" marker
//              (localStorage) and clears the badge; registrations after the
//              marker re-populate it. This open-to-clear behavior applies
//              to Users ONLY.
//
// One coordinated 15s refresh cycle for all three counts (single interval):
//   - guarded against duplicate timers and overlapping requests
//   - skips fetches while the tab is hidden; one immediate refresh on
//     return to foreground (no catch-up storm — setInterval never queues)
//   - cleared via stopAdminBadges() when the admin layout is torn down
// Badge elements are marked up with data-nav-badge="<route>" in the nav
// components; counts of 0 hide the badge. Updates are in-place DOM text
// changes (no page refresh, no layout rebuild, no navigation).
// =============================================================================

const REFRESH_MS = 15000;
const USERS_SEEN_KEY = 'xreserve_admin_users_seen_at';

let timerId = null;
let fetching = false;
let visibilityHandler = null;

const ROUTE_KEYS = {
  'admin/deposits': 'pending_deposits',
  'admin/sell-orders': 'pending_orders',
  'admin/users': 'new_users',
};

export function startAdminBadges() {
  if (timerId !== null) return; // never create duplicate timers
  refreshBadges();
  timerId = setInterval(refreshBadges, REFRESH_MS);

  // Foreground return: refresh once immediately (the throttled interval
  // may have been suppressed while hidden). Listener lives only as long
  // as the admin layout does.
  visibilityHandler = () => {
    if (!document.hidden) refreshBadges();
  };
  document.addEventListener('visibilitychange', visibilityHandler);
}

export function stopAdminBadges() {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  fetching = false;
}

// Users open-to-clear: record the moment the admin opened the Users
// section. Called from updateAdminNav() on navigation. Deposits/Orders
// must never call this — their counts are purely status-driven.
export function markUsersSeen() {
  try {
    localStorage.setItem(USERS_SEEN_KEY, new Date().toISOString());
  } catch {
    // Storage unavailable — badge simply keeps counting
  }
  setBadge('admin/users', 0); // immediate visual reset
}

function getUsersSeenSince() {
  try {
    return localStorage.getItem(USERS_SEEN_KEY) || null;
  } catch {
    return null;
  }
}

async function refreshBadges() {
  if (fetching) return; // no overlapping requests
  if (document.hidden) return; // no background-tab polling
  fetching = true;
  try {
    const since = getUsersSeenSince();
    const { data, error } = await supabase.rpc('admin_notification_counts', {
      p_users_since: since,
    });
    if (error || !data || data.length === 0) {
      // RPC unavailable (e.g. migration not applied yet) — hide badges.
      Object.keys(ROUTE_KEYS).forEach((route) => setBadge(route, 0));
      return;
    }
    const row = data[0];
    Object.entries(ROUTE_KEYS).forEach(([route, key]) => {
      setBadge(route, Number(row[key]) || 0);
    });
  } catch {
    // Silent — badges keep their last state / stay hidden
  } finally {
    fetching = false;
  }
}

function setBadge(route, count) {
  const els = document.querySelectorAll(`[data-nav-badge="${route}"]`);
  els.forEach((el) => {
    if (count > 0) {
      el.textContent = count > 99 ? '99+' : String(count);
      el.classList.remove('hidden');
      el.setAttribute('aria-label', `${count} pending`);
    } else {
      el.textContent = '';
      el.classList.add('hidden');
      el.removeAttribute('aria-label');
    }
  });
}
