import { supabase } from '@/lib/supabase';
import { openChangeRateDialog } from '@/components/admin/ChangeRateDialog';

export function renderAdminDashboard() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col px-5 pb-8 pt-8 md:px-8 lg:px-12';

  page.innerHTML = `
    <h1 class="page-title">Dashboard</h1>
    <p class="text-muted mt-1 mb-6">Overview of exchange operations</p>
    <div id="rate-card" class="card p-5 mb-6">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">Exchange Rate</p>
          <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">Loading...</p>
        </div>
        <div class="auth-spinner"></div>
      </div>
    </div>
    <div class="flex items-center justify-center py-12">
      <div class="auth-spinner"></div>
    </div>
  `;

  loadAll(page);

  return page;
}

async function loadAll(page) {
  const { data, error } = await supabase.rpc('admin_dashboard_stats');
  const statsContainer = page.querySelector('.flex.items-center.justify-center.py-12');
  const rateCard = page.querySelector('#rate-card');

  if (error || !data || data.length === 0) {
    rateCard.innerHTML = `
      <div class="flex items-center justify-between">
        <div>
          <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">Exchange Rate</p>
          <p class="mt-1 text-[13px] text-red-500">Failed to load</p>
        </div>
      </div>
    `;
    statsContainer.innerHTML = `<p class="text-[14px] text-text-secondary dark:text-text-secondary-dark">Failed to load stats</p>`;
    return;
  }

  const stats = data[0];

  // Exchange rate card
  if (stats.platform_rate != null) {
    rateCard.innerHTML = `
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex items-center gap-4">
          <div class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-green-500/10 dark:bg-green-500/20">
            <svg class="h-5 w-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </div>
          <div>
            <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">USDT / INR Exchange Rate</p>
            <p class="mt-1 text-[24px] font-bold tracking-tight text-text-primary dark:text-text-primary-dark">1 USDT = ₹${Number(stats.platform_rate).toFixed(2)}</p>
          </div>
        </div>
        <button id="change-rate-btn" class="btn-secondary w-full sm:w-auto flex-shrink-0">Change Exchange Rate</button>
      </div>
    `;
    rateCard.querySelector('#change-rate-btn').addEventListener('click', () => {
      openChangeRateDialog({
        currentRate: Number(stats.platform_rate),
        onUpdated: () => loadAll(page),
      });
    });
  } else {
    rateCard.innerHTML = `
      <div class="flex items-center justify-between">
        <div>
          <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">Exchange Rate</p>
          <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">Not configured</p>
        </div>
      </div>
    `;
  }

  // Stats cards
  statsContainer.className = 'stagger grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5';
  statsContainer.innerHTML = '';

  const cards = [
    { label: 'Pending Deposits', value: stats.pending_deposits, color: 'text-amber-600 dark:text-amber-400' },
    { label: 'Pending Orders', value: stats.pending_sell_orders, color: 'text-amber-600 dark:text-amber-400' },
    { label: 'Total Users', value: stats.total_users, color: 'text-text-primary dark:text-text-primary-dark' },
    { label: 'Credited Deposits', value: stats.credited_deposits, color: 'text-green-600 dark:text-green-400' },
    { label: 'Completed Sells', value: stats.completed_sells, color: 'text-green-600 dark:text-green-400' },
  ];

  cards.forEach((card) => {
    const el = document.createElement('div');
    el.className = 'card p-5';
    el.innerHTML = `
      <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">${card.label}</p>
      <p class="mt-2 text-[28px] font-bold tracking-tight ${card.color}">${card.value}</p>
    `;
    statsContainer.appendChild(el);
  });
}
