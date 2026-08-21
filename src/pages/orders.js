import { supabase } from '@/lib/supabase';
import { navigate } from '@/core/router';
import { OrderCard } from '@/components/OrderCard';
import { StatusBadge } from '@/components/StatusBadge';

const typeFilters = ['All Orders', 'Sell Orders', 'Deposit Orders'];
const PAGE_SIZE = 5;

// Non-terminal statuses — the ONLY states that still change without user
// action and therefore need polling. Completed/Rejected/Cancelled/Credited
// are terminal and are never polled.
const NON_TERMINAL_SELL = ['PAYMENT_PENDING', 'PAYMENT_PROOF_UPLOADED', 'MANUAL_REVIEW'];
const NON_TERMINAL_DEPOSIT = ['PENDING', 'PENDING_VERIFICATION', 'UNDER_REVIEW'];
const POLL_MS = 15000;

export async function renderOrders() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  let activeType = 'All Orders';
  let currentPage = 1;
  let allOrders = [];

  // Fetch real sell orders + deposits in parallel (both RLS-scoped to auth.uid())
  const [sellRes, depositRes] = await Promise.all([
    supabase
      .from('sell_orders')
      .select('id, usdt_amount, inr_amount, exchange_rate, status, created_at')
      .order('created_at', { ascending: false }),
    supabase
      .from('deposits')
      .select('id, network, expected_amount, actual_amount, status, created_at')
      .order('created_at', { ascending: false }),
  ]);

  const sells = !sellRes.error && sellRes.data ? sellRes.data.map(mapSellOrder) : [];
  const deposits = !depositRes.error && depositRes.data ? depositRes.data.map(mapDeposit) : [];

  // Combined history sorted by actual creation timestamp, newest first
  allOrders = [...sells, ...deposits].sort(
    (a, b) => new Date(b.sortAt).getTime() - new Date(a.sortAt).getTime()
  );

  function matchesType(order) {
    if (activeType === 'Sell Orders') return order.type === 'sell';
    if (activeType === 'Deposit Orders') return order.type === 'deposit';
    return true;
  }

  function renderContent() {
    const list = page.querySelector('#order-list');
    const pager = page.querySelector('#order-pagination');
    list.innerHTML = '';

    const filtered = allOrders.filter(matchesType);

    if (filtered.length === 0) {
      pager.innerHTML = '';
      list.innerHTML = `
        <div class="card flex flex-col items-center py-16 text-center">
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
            <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3.75 3H7.5c-2.485 0-4.5-2.015-4.5-4.5V8.25c0-2.485 2.015-4.5 4.5-4.5h9c2.485 0 4.5 2.015 4.5 4.5v8.25c0 2.485-2.015 4.5-4.5 4.5z"/></svg>
          </div>
          <p class="mt-4 text-[14px] font-medium text-text-primary dark:text-text-primary-dark">No orders found</p>
          <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">Try a different filter or create a new order</p>
          <button class="mt-4 text-[13px] font-medium text-action dark:text-action-dark hover:underline" id="empty-support-btn">Need help? Create a support ticket</button>
        </div>
      `;
      list.querySelector('#empty-support-btn')?.addEventListener('click', () => {
        navigate('create-ticket');
      });
      return;
    }

    // Paginate — never more than PAGE_SIZE cards on the current page
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    filtered.slice(start, start + PAGE_SIZE).forEach((order) => {
      list.appendChild(OrderCard(order));
    });

    if (totalPages > 1) {
      pager.innerHTML = `
        <div class="mt-4 flex items-center justify-between gap-3">
          <button id="page-prev" class="${pagerBtnClass(currentPage > 1)}" ${currentPage === 1 ? 'disabled' : ''}>Previous</button>
          <span class="whitespace-nowrap text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark">Page ${currentPage} of ${totalPages}</span>
          <button id="page-next" class="${pagerBtnClass(currentPage < totalPages)}" ${currentPage === totalPages ? 'disabled' : ''}>Next</button>
        </div>
      `;
      pager.querySelector('#page-prev').addEventListener('click', () => {
        if (currentPage > 1) {
          currentPage--;
          renderContent();
        }
      });
      pager.querySelector('#page-next').addEventListener('click', () => {
        if (currentPage < totalPages) {
          currentPage++;
          renderContent();
        }
      });
    } else {
      pager.innerHTML = '';
    }
  }

  const pillClass = (isActive) => `rounded-full px-4 py-2 text-[13px] font-medium transition-colors duration-150 ${
    isActive
      ? 'tab-active'
      : 'tab-inactive'
  }`;

  page.innerHTML = `
    <div class="flex items-start justify-between mb-6">
      <div>
        <h1 class="page-title">Orders</h1>
        <p class="text-muted mt-1">Track your sell orders and deposits</p>
      </div>
      <button id="orders-support-btn" class="flex-shrink-0 mt-1 flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px] font-medium text-text-secondary transition-colors duration-150 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] dark:text-text-secondary-dark">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z"/></svg>
        Need Help?
      </button>
    </div>

    <div class="mb-5 flex flex-wrap gap-2" id="type-filters">
      ${typeFilters.map((f) => `
        <button class="${pillClass(f === activeType)}" data-type="${f}">${f}</button>
      `).join('')}
    </div>

    <div class="stagger flex flex-col gap-3" id="order-list"></div>
    <div id="order-pagination"></div>
  `;

  page.querySelector('#orders-support-btn').addEventListener('click', () => {
    navigate('create-ticket');
  });

  // Type filter — switching type returns to the first page
  const typeBar = page.querySelector('#type-filters');
  typeBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-type]');
    if (!btn || btn.dataset.type === activeType) return;
    activeType = btn.dataset.type;
    currentPage = 1;
    typeBar.querySelectorAll('button').forEach((b) => {
      b.className = pillClass(b.dataset.type === activeType);
    });
    renderContent();
  });

  renderContent();

  // =========================================================================
  // Automatic status refresh (15s) for PENDING items only.
  // In-place badge/amount updates: no re-render, so the active filter,
  // pagination and scroll position are always preserved. The timer stops
  // itself when the page is detached or no pending items remain.
  // =========================================================================
  const pendingKeys = new Set(
    allOrders
      .filter((o) => (o.type === 'sell' ? NON_TERMINAL_SELL : NON_TERMINAL_DEPOSIT).includes(o.status))
      .map((o) => o.key)
  );

  let pollingNow = false;
  let pollTimer = null;
  if (pendingKeys.size > 0) {
    pollTimer = setInterval(pollPendingOrders, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollPendingOrders() {
    // Page destroyed (navigation) — clean up
    if (!page.isConnected) {
      stopPolling();
      return;
    }
    // No background-tab polling; no overlapping requests
    if (document.hidden || pollingNow) return;
    if (pendingKeys.size === 0) {
      stopPolling();
      return;
    }

    pollingNow = true;
    try {
      // Query ONLY the tracked pending ids (RLS-scoped to auth.uid()).
      const sellIds = [];
      const depIds = [];
      pendingKeys.forEach((key) => {
        if (key.startsWith('sell:')) sellIds.push(key.slice(5));
        else if (key.startsWith('deposit:')) depIds.push(key.slice(8));
      });

      const [sellRes, depRes] = await Promise.all([
        sellIds.length > 0
          ? supabase.from('sell_orders').select('id, status').in('id', sellIds)
          : Promise.resolve({ data: [], error: null }),
        depIds.length > 0
          ? supabase.from('deposits').select('id, status, actual_amount').in('id', depIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

      // Temporary request failure — keep existing content, retry next tick
      if (sellRes.error || depRes.error) return;

      const fresh = new Map();
      (sellRes.data || []).forEach((r) => fresh.set(`sell:${r.id}`, { status: r.status }));
      (depRes.data || []).forEach((r) => fresh.set(`deposit:${r.id}`, { status: r.status, actual_amount: r.actual_amount }));

      allOrders.forEach((order) => {
        if (!pendingKeys.has(order.key)) return;
        const row = fresh.get(order.key);
        if (!row) return; // no change
        const changed = row.status !== order.status;
        const creditedAmount = order.type === 'deposit' && row.actual_amount != null && order.usdtAmount !== formatAmount(row.actual_amount);
        if (!changed && !creditedAmount) return;

        order.status = row.status;
        if (order.type === 'deposit' && row.actual_amount != null) {
          order.usdtAmount = formatAmount(row.actual_amount);
        }

        // Terminal now? Stop tracking it.
        const stillPending = (order.type === 'sell' ? NON_TERMINAL_SELL : NON_TERMINAL_DEPOSIT).includes(order.status);
        if (!stillPending) pendingKeys.delete(order.key);

        // In-place DOM update ONLY if this card is currently rendered
        const card = page.querySelector(`[data-order-id="${order.key}"]`);
        if (card) {
          if (changed) {
            const slot = card.querySelector('.order-badge-slot');
            if (slot) {
              slot.innerHTML = '';
              slot.appendChild(StatusBadge({ status: order.status }));
            }
          }
          if (creditedAmount) {
            const amountEl = card.querySelectorAll('p')[0];
            if (amountEl) amountEl.textContent = `${order.usdtAmount} USDT`;
          }
        }
      });

      if (pendingKeys.size === 0) stopPolling();
    } catch {
      // Silent — retry on next tick; rendered content is never destroyed
    } finally {
      pollingNow = false;
    }
  }

  return page;
}

function pagerBtnClass(enabled) {
  return `rounded-full px-4 py-2 text-[13px] font-medium transition-colors duration-150 ${
    enabled
      ? 'tab-active'
      : 'tab-inactive cursor-not-allowed opacity-50'
  }`;
}

function mapSellOrder(o) {
  return {
    type: 'sell',
    // Stable identity for in-place polling updates
    key: `sell:${o.id}`,
    // Presentation only — the underlying UUID stays unchanged in the database.
    id: o.id ? `SELL_ID # ${o.id.slice(0, 8).toUpperCase()}` : '',
    date: formatDate(o.created_at),
    usdtAmount: formatAmount(o.usdt_amount),
    rate: formatRate(o.exchange_rate),
    inrAmount: formatInr(o.inr_amount),
    status: o.status || '',
    sortAt: o.created_at,
  };
}

function mapDeposit(d) {
  return {
    type: 'deposit',
    // Stable identity for in-place polling updates
    key: `deposit:${d.id}`,
    // Presentation only — the underlying UUID stays unchanged in the database.
    id: d.id ? `DEP_ID # ${d.id.slice(0, 8).toUpperCase()}` : '',
    date: formatDate(d.created_at),
    // Credited amount when available, otherwise the declared amount
    usdtAmount: formatAmount(d.actual_amount != null ? d.actual_amount : d.expected_amount),
    rate: null,
    inrAmount: '',
    subtitle: d.network ? `Deposit · ${d.network}` : 'Deposit',
    status: d.status || '',
    sortAt: d.created_at,
  };
}

function formatAmount(num) {
  const n = Number(num);
  if (!isFinite(n) || n < 0) return '0.00';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatRate(num) {
  const n = Number(num);
  if (!isFinite(n)) return '0.00';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function formatInr(num) {
  const n = Number(num);
  if (!isFinite(n)) return '0.00';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
