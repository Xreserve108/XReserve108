/**
 * Admin Users Management — Read-only user list and 360° detail view.
 * Uses server-side pagination, search, and filtering via SECURITY DEFINER RPCs.
 */
import { supabase } from '../lib/supabase.js';

// ─── State ─────────────────────────────────────────────────────────────────────
let currentFilter = 'all';
let currentSearch = '';
let currentOffset = 0;
const PAGE_SIZE = 20;
let hasMore = false;
let users = [];
let isLoading = false;
let detailModal = null;
let pageEl = null;

// ─── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
  const { data, error } = await supabase.rpc('admin_user_stats');
  if (error) {
    console.error('admin_user_stats error:', error);
    return;
  }
  const stats = data?.[0] || {};
  const statsEl = pageEl ? pageEl.querySelector('#users-stats') : document.getElementById('users-stats');
  if (!statsEl) return;

  statsEl.innerHTML = `
    <div class="card p-4">
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-1">Total Users</p>
      <p class="text-2xl font-bold text-gray-900 dark:text-white">${stats.total_users || 0}</p>
    </div>
    <div class="card p-4">
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-1">2FA Enabled</p>
      <p class="text-2xl font-bold text-green-600">${stats.users_with_2fa || 0}</p>
    </div>
    <div class="card p-4">
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-1">Pending Activity</p>
      <p class="text-2xl font-bold text-amber-600">${stats.users_with_pending_activity || 0}</p>
    </div>
    <div class="card p-4">
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-1">New (7d)</p>
      <p class="text-2xl font-bold text-blue-600">${stats.new_users_7d || 0}</p>
    </div>
    <div class="card p-4">
      <p class="text-xs text-gray-500 dark:text-gray-400 mb-1">New (30d)</p>
      <p class="text-2xl font-bold text-blue-600">${stats.new_users_30d || 0}</p>
    </div>
  `;
}

// ─── Filter Tabs ───────────────────────────────────────────────────────────────
const FILTERS = [
  { key: 'all', label: 'All' },
  { key: '2fa_on', label: '2FA On' },
  { key: '2fa_off', label: '2FA Off' },
  { key: 'pending_deposit', label: 'Pending Deposit' },
  { key: 'pending_sell', label: 'Pending Sell' },
];

function renderFilterTabs() {
  const tabs = pageEl ? pageEl.querySelector('#users-filter-tabs') : document.getElementById('users-filter-tabs');
  if (!tabs) return;
  tabs.innerHTML = FILTERS.map(f => `
    <button
      data-filter="${f.key}"
      class="rounded-full px-4 py-1.5 text-sm font-medium transition
        ${f.key === currentFilter
          ? 'bg-blue-600 text-white'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}"
    >${f.label}</button>
  `).join('');
  tabs.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.filter === currentFilter) return;
      currentFilter = btn.dataset.filter;
      currentOffset = 0;
      users = [];
      renderFilterTabs();
      loadUsers(false);
    });
  });
}

// ─── User List ─────────────────────────────────────────────────────────────────
async function loadUsers(append = false) {
  if (isLoading) return;
  isLoading = true;

  const listEl = pageEl ? pageEl.querySelector('#users-list') : document.getElementById('users-list');
  const emptyEl = pageEl ? pageEl.querySelector('#users-empty') : document.getElementById('users-empty');
  const loadMoreEl = pageEl ? pageEl.querySelector('#users-load-more') : document.getElementById('users-load-more');

  if (!listEl) { isLoading = false; return; }

  if (!append) {
    listEl.innerHTML = `<div class="text-center py-8 text-gray-500 dark:text-gray-400">Loading users...</div>`;
    emptyEl.style.display = 'none';
  }

  const { data, error } = await supabase.rpc('admin_list_users', {
    p_search: currentSearch || null,
    p_filter: currentFilter,
    p_limit: PAGE_SIZE + 1,
    p_offset: currentOffset,
  });

  isLoading = false;

  if (error) {
    console.error('admin_list_users error:', error);
    listEl.innerHTML = `<div class="text-center py-8 text-red-500">Failed to load users.</div>`;
    return;
  }

  const rows = data || [];
  hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);

  if (append) {
    users = users.concat(page);
  } else {
    users = page;
  }

  if (users.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
    if (loadMoreEl) loadMoreEl.style.display = 'none';
    return;
  }

  emptyEl.style.display = 'none';
  renderUserList(listEl);

  if (loadMoreEl) {
    loadMoreEl.style.display = hasMore ? 'block' : 'none';
  }
}

function renderUserList(container) {
  container.innerHTML = users.map(u => {
    const avatar = u.avatar_url
      ? `<img src="${u.avatar_url}" alt="" class="w-10 h-10 rounded-full object-cover flex-shrink-0" />`
      : `<div class="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-sm flex-shrink-0">${(u.username || u.email || '?').charAt(0).toUpperCase()}</div>`;

    const badges = [];
    if (u.is_admin) badges.push('<span class="inline-flex items-center rounded-full bg-red-100 text-red-700 px-2 py-0.5 text-xs font-medium dark:bg-red-900/30 dark:text-red-400">ADMIN</span>');
    if (u.has_2fa) badges.push('<span class="inline-flex items-center rounded-full bg-green-100 text-green-700 px-2 py-0.5 text-xs font-medium dark:bg-green-900/30 dark:text-green-400">2FA</span>');
    if (u.has_pending_deposit) badges.push('<span class="inline-flex items-center rounded-full bg-amber-100 text-amber-700 px-2 py-0.5 text-xs font-medium dark:bg-amber-900/30 dark:text-amber-400">Deposit</span>');
    if (u.has_pending_sell_order) badges.push('<span class="inline-flex items-center rounded-full bg-purple-100 text-purple-700 px-2 py-0.5 text-xs font-medium dark:bg-purple-900/30 dark:text-purple-400">Sell</span>');

    return `
      <div class="card p-4 flex items-center gap-3 cursor-pointer hover:shadow-md transition" data-user-id="${u.user_id}">
        ${avatar}
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="font-semibold text-gray-900 dark:text-white truncate">${u.username || '—'}</span>
            ${badges.join('')}
          </div>
          <p class="text-sm text-gray-500 dark:text-gray-400 truncate">${u.email || ''}</p>
          <div class="flex items-center gap-3 mt-1 text-xs text-gray-400 dark:text-gray-500">
            <span>Balance: ${Number(u.available_usdt || 0).toFixed(2)} USDT</span>
            <span>Deposits: ${u.total_deposits || 0}</span>
            <span>Sells: ${u.total_sell_orders || 0}</span>
          </div>
        </div>
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5 text-gray-400 flex-shrink-0">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
        </svg>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-user-id]').forEach(card => {
    card.addEventListener('click', () => openUserDetail(card.dataset.userId));
  });
}

// ─── Search ────────────────────────────────────────────────────────────────────
function setupSearch() {
  const input = pageEl ? pageEl.querySelector('#users-search') : document.getElementById('users-search');
  if (!input) return;
  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      currentSearch = input.value.trim();
      currentOffset = 0;
      users = [];
      loadUsers(false);
    }, 400);
  });
}

// ─── User Detail Modal ─────────────────────────────────────────────────────────
async function openUserDetail(userId) {
  if (detailModal) detailModal.remove();

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50';
  overlay.innerHTML = `
    <div class="card w-full max-w-2xl max-h-[90vh] overflow-y-auto">
      <div class="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
        <h2 class="text-lg font-bold text-gray-900 dark:text-white">User Details</h2>
        <button id="user-detail-close" class="p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div id="user-detail-body" class="p-4">
        <div class="text-center py-8 text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    </div>
  `;

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDetail();
  });
  overlay.querySelector('#user-detail-close').addEventListener('click', closeDetail);

  document.body.appendChild(overlay);
  detailModal = overlay;

  // Fetch 360° data
  const { data, error } = await supabase.rpc('admin_get_user_360', { p_user_id: userId });
  if (error || !data) {
    document.getElementById('user-detail-body').innerHTML =
      `<div class="text-center py-8 text-red-500">Failed to load user details.</div>`;
    return;
  }

  renderDetailBody(data);
}

function closeDetail() {
  if (detailModal) {
    detailModal.remove();
    detailModal = null;
  }
}

function renderDetailBody(data) {
  const body = document.getElementById('user-detail-body');
  if (!body) return;

  const { profile, wallet, deposits, sell_orders, bank_accounts, two_fa } = data;

  const avatar = profile.avatar_url
    ? `<img src="${profile.avatar_url}" alt="" class="w-14 h-14 rounded-full object-cover" />`
    : `<div class="w-14 h-14 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-lg">${(profile.username || profile.email || '?').charAt(0).toUpperCase()}</div>`;

  const depRows = (deposits || []).slice(0, 10).map(d => `
    <tr class="border-b border-gray-100 dark:border-gray-700">
      <td class="py-2 text-xs">${formatDate(d.created_at)}</td>
      <td class="py-2 text-xs">${d.network || '-'}</td>
      <td class="py-2 text-xs">${d.verified_amount || d.declared_amount || d.expected_amount || '-'}</td>
      <td class="py-2"><span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(d.status)}">${d.status}</span></td>
    </tr>
  `).join('');

  const sellRows = (sell_orders || []).slice(0, 10).map(s => `
    <tr class="border-b border-gray-100 dark:border-gray-700">
      <td class="py-2 text-xs">${formatDate(s.created_at)}</td>
      <td class="py-2 text-xs">${s.usdt_amount || '-'}</td>
      <td class="py-2 text-xs">${s.inr_amount || '-'}</td>
      <td class="py-2"><span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(s.status)}">${s.status}</span></td>
    </tr>
  `).join('');

  const bankRows = (bank_accounts || []).map(b => `
    <tr class="border-b border-gray-100 dark:border-gray-700">
      <td class="py-2 text-xs">${b.bank_name || '-'}</td>
      <td class="py-2 text-xs">${b.account_holder_name || '-'}</td>
      <td class="py-2 text-xs font-mono">${b.account_number || '-'}</td>
      <td class="py-2 text-xs">${b.ifsc_code || '-'}</td>
    </tr>
  `).join('');

  body.innerHTML = `
    <!-- Profile -->
    <div class="flex items-center gap-4 mb-6">
      ${avatar}
      <div>
        <h3 class="text-lg font-bold text-gray-900 dark:text-white">${profile.username || '—'}</h3>
        <p class="text-sm text-gray-500 dark:text-gray-400">${profile.email || ''}</p>
        <p class="text-xs text-gray-400 dark:text-gray-500">Joined: ${formatDate(profile.created_at)}</p>
      </div>
    </div>

    <!-- Wallet -->
    <div class="grid grid-cols-3 gap-3 mb-6">
      <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 text-center">
        <p class="text-xs text-gray-500 dark:text-gray-400">Available</p>
        <p class="text-lg font-bold text-gray-900 dark:text-white">${Number(wallet?.available_usdt || 0).toFixed(2)}</p>
      </div>
      <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 text-center">
        <p class="text-xs text-gray-500 dark:text-gray-400">Reserved</p>
        <p class="text-lg font-bold text-gray-900 dark:text-white">${Number(wallet?.reserved_usdt || 0).toFixed(2)}</p>
      </div>
      <div class="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-3 text-center">
        <p class="text-xs text-gray-500 dark:text-gray-400">Total</p>
        <p class="text-lg font-bold text-gray-900 dark:text-white">${Number(wallet?.total_usdt || 0).toFixed(2)}</p>
      </div>
    </div>

    <!-- 2FA -->
    <div class="mb-6 p-3 rounded-lg ${two_fa?.enabled ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium ${two_fa?.enabled ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}">
          2FA: ${two_fa?.enabled ? 'Enabled' : 'Disabled'}
        </span>
        ${two_fa?.last_verified_at ? `<span class="text-xs text-gray-500 dark:text-gray-400">Last verified: ${formatDate(two_fa.last_verified_at)}</span>` : ''}
      </div>
    </div>

    <!-- Deposits -->
    <div class="mb-6">
      <h4 class="text-sm font-bold text-gray-900 dark:text-white mb-2">Recent Deposits (${(deposits || []).length})</h4>
      ${depRows ? `
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead><tr class="border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
              <th class="py-2">Date</th><th class="py-2">Network</th><th class="py-2">Amount</th><th class="py-2">Status</th>
            </tr></thead>
            <tbody>${depRows}</tbody>
          </table>
        </div>
      ` : '<p class="text-sm text-gray-500 dark:text-gray-400">No deposits.</p>'}
    </div>

    <!-- Sell Orders -->
    <div class="mb-6">
      <h4 class="text-sm font-bold text-gray-900 dark:text-white mb-2">Recent Sell Orders (${(sell_orders || []).length})</h4>
      ${sellRows ? `
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead><tr class="border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
              <th class="py-2">Date</th><th class="py-2">USDT</th><th class="py-2">INR</th><th class="py-2">Status</th>
            </tr></thead>
            <tbody>${sellRows}</tbody>
          </table>
        </div>
      ` : '<p class="text-sm text-gray-500 dark:text-gray-400">No sell orders.</p>'}
    </div>

    <!-- Bank Accounts -->
    <div class="mb-6">
      <h4 class="text-sm font-bold text-gray-900 dark:text-white mb-2">Bank Accounts (${(bank_accounts || []).length})</h4>
      ${bankRows ? `
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead><tr class="border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
              <th class="py-2">Bank</th><th class="py-2">Holder</th><th class="py-2">Account</th><th class="py-2">IFSC</th>
            </tr></thead>
            <tbody>${bankRows}</tbody>
          </table>
        </div>
      ` : '<p class="text-sm text-gray-500 dark:text-gray-400">No bank accounts.</p>'}
    </div>
  `;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(d) {
  if (!d) return '—';
  const date = new Date(d);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function statusColor(status) {
  const map = {
    'COMPLETED': 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    'APPROVED': 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    'CREDITED': 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    'PENDING': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    'PENDING_VERIFICATION': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    'UNDER_REVIEW': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    'REJECTED': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    'FAILED': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    'CANCELLED': 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
    'PAYMENT_PENDING': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
    'PAYMENT_PROOF_UPLOADED': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
    'MANUAL_REVIEW': 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  };
  return map[status] || 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
}

// ─── Main Render ───────────────────────────────────────────────────────────────
export function renderAdminUsers() {
  const page = document.createElement('div');
  page.className = 'page-enter px-5 pb-8 pt-8 md:px-8 lg:px-12';

  page.innerHTML = `
    <div class="flex items-center justify-between mb-6">
      <h1 class="page-title">Users</h1>
    </div>

    <!-- Stats -->
    <div id="users-stats" class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6"></div>

    <!-- Search -->
    <div class="mb-4">
      <input
        id="users-search"
        type="text"
        placeholder="Search by username, email, or user ID..."
        class="w-full rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white dark:placeholder-gray-500"
      />
    </div>

    <!-- Filter Tabs -->
    <div id="users-filter-tabs" class="flex gap-2 mb-4 overflow-x-auto pb-1"></div>

    <!-- User List -->
    <div id="users-list" class="space-y-3 mb-4"></div>

    <!-- Empty State -->
    <div id="users-empty" class="text-center py-12 text-gray-500 dark:text-gray-400" style="display:none;">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-12 h-12 mx-auto mb-3 text-gray-400 dark:text-gray-500">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
      </svg>
      <p class="text-sm">No users found.</p>
    </div>

    <!-- Load More -->
    <div id="users-load-more" class="text-center" style="display:none;">
      <button id="users-load-more-btn" class="btn-secondary">Load More</button>
    </div>
  `;

  pageEl = page;

  // Wire up
  renderFilterTabs();
  setupSearch();
  loadStats();
  loadUsers(false);

  // Load more handler
  const loadMoreBtn = page.querySelector('#users-load-more-btn');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      currentOffset += PAGE_SIZE;
      loadUsers(true);
    });
  }

  return page;
}
