import { supabase } from '@/lib/supabase';
import { isAuthenticated } from '@/core/auth';
import { navigate } from '@/core/router';

const FILTERS = [
  { label: 'All', value: null },
  { label: 'Open', value: 'OPEN' },
  { label: 'In Progress', value: 'IN_PROGRESS' },
  { label: 'Waiting', value: 'WAITING_FOR_USER' },
  { label: 'Resolved', value: 'RESOLVED' },
  { label: 'Closed', value: 'CLOSED' },
];

const statusConfig = {
  OPEN:                { label: 'Open', color: 'text-blue-500', bg: 'bg-blue-500/10' },
  IN_PROGRESS:         { label: 'In Progress', color: 'text-blue-600', bg: 'bg-blue-600/10' },
  WAITING_FOR_USER:    { label: 'Waiting for You', color: 'text-yellow-500', bg: 'bg-yellow-500/10' },
  WAITING_FOR_SUPPORT: { label: 'Waiting for Support', color: 'text-yellow-600', bg: 'bg-yellow-600/10' },
  RESOLVED:            { label: 'Resolved', color: 'text-green-500', bg: 'bg-green-500/10' },
  CLOSED:              { label: 'Closed', color: 'text-text-secondary', bg: 'bg-black/[0.04]' },
};

const priorityConfig = {
  LOW:    { label: 'Low', color: 'text-text-secondary' },
  NORMAL: { label: '', color: '' },
  HIGH:   { label: 'High', color: 'text-orange-500' },
  URGENT: { label: 'Urgent', color: 'text-red-500' },
};

export function renderMyTickets() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  if (!isAuthenticated()) {
    navigate('signin');
    return page;
  }

  let activeFilter = null;
  let tickets = [];
  let currentPage = 0;
  const PAGE_SIZE = 20;

  page.innerHTML = `
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="page-title">My Tickets</h1>
        <p class="text-muted mt-1">Your support requests</p>
      </div>
      <button id="create-ticket-btn" class="btn-primary rounded-xl px-4 py-2 text-[13px] font-medium">
        + New Ticket
      </button>
    </div>

    <!-- Filters -->
    <div id="ticket-filters" class="flex gap-1 mb-5 overflow-x-auto pb-1 scrollbar-hide" role="tablist"></div>

    <!-- Ticket list -->
    <div id="ticket-list" class="flex flex-col gap-2">
      <div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>
    </div>

    <div id="ticket-pagination" class="mt-4"></div>
  `;

  // Render filter tabs
  const filtersContainer = page.querySelector('#ticket-filters');
  FILTERS.forEach((f) => {
    const btn = document.createElement('button');
    btn.className = `whitespace-nowrap rounded-full px-4 py-2 text-[12px] font-medium transition-colors ${
      activeFilter === f.value
        ? 'tab-active'
        : 'tab-inactive text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark'
    }`;
    btn.textContent = f.label;
    btn.addEventListener('click', () => {
      activeFilter = f.value;
      currentPage = 0;
      updateFilterUI();
      loadTickets();
    });
    btn.dataset.value = f.value || '';
    filtersContainer.appendChild(btn);
  });

  function updateFilterUI() {
    filtersContainer.querySelectorAll('button').forEach((btn) => {
      const val = btn.dataset.value || null;
      const isActive = val === (activeFilter === null ? null : activeFilter);
      btn.className = `whitespace-nowrap rounded-full px-4 py-2 text-[12px] font-medium transition-colors ${
        isActive ? 'tab-active' : 'tab-inactive text-text-secondary dark:text-text-secondary-dark'
      }`;
    });
  }

  async function loadTickets() {
    const list = page.querySelector('#ticket-list');
    list.innerHTML = '<div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>';

    const { data, error } = await supabase.rpc('support_get_user_tickets', {
      p_status: activeFilter,
      p_limit: PAGE_SIZE,
      p_offset: currentPage * PAGE_SIZE,
    });

    if (error) {
      list.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">Failed to load tickets</p></div>`;
      return;
    }

    tickets = data || [];
    renderList(list);
  }

  function renderList(container) {
    if (tickets.length === 0) {
      container.innerHTML = `
        <div class="card flex flex-col items-center py-16 text-center">
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
            <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h7.5"/></svg>
          </div>
          <p class="mt-4 text-[14px] font-medium text-text-primary dark:text-text-primary-dark">No tickets found</p>
          <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">Create a ticket to get help from our support team</p>
        </div>
      `;
      page.querySelector('#ticket-pagination').innerHTML = '';
      return;
    }

    container.innerHTML = '';
    tickets.forEach((t) => container.appendChild(createTicketCard(t)));
    renderPagination();
  }

  function createTicketCard(t) {
    const st = statusConfig[t.status] || statusConfig.OPEN;
    const pr = priorityConfig[t.priority] || priorityConfig.NORMAL;
    const card = document.createElement('button');
    card.className = 'card card-interactive flex flex-col gap-2 p-4 text-left transition-colors w-full';

    const timeStr = formatRelativeTime(t.updated_at);
    const hasUnread = t.unread_count > 0;

    card.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="text-[12px] font-mono font-semibold text-text-secondary dark:text-text-secondary-dark">${t.ticket_number}</span>
          ${hasUnread ? '<span class="h-2 w-2 flex-shrink-0 rounded-full bg-action dark:bg-action-dark"></span>' : ''}
        </div>
        <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${st.bg} ${st.color} whitespace-nowrap">${st.label}</span>
      </div>
      <p class="text-[14px] font-medium text-text-primary dark:text-text-primary-dark truncate">${escapeHtml(t.subject)}</p>
      <div class="flex items-center gap-3 text-[12px] text-text-secondary dark:text-text-secondary-dark">
        <span>${t.category}</span>
        ${pr.label ? `<span class="${pr.color} font-medium">${pr.label}</span>` : ''}
        <span class="ml-auto">${timeStr}</span>
      </div>
    `;

    card.addEventListener('click', () => navigate(`ticket-detail?id=${t.id}`));
    return card;
  }

  function renderPagination() {
    const pager = page.querySelector('#ticket-pagination');
    const hasMore = tickets.length === PAGE_SIZE;
    if (!hasMore && currentPage === 0) {
      pager.innerHTML = '';
      return;
    }
    pager.innerHTML = `
      <div class="flex items-center justify-between gap-3">
        <button id="tick-prev" class="rounded-full px-4 py-2 text-[13px] font-medium ${currentPage > 0 ? 'tab-active' : 'tab-inactive cursor-not-allowed opacity-50'}" ${currentPage === 0 ? 'disabled' : ''}>Previous</button>
        <span class="text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark">Page ${currentPage + 1}</span>
        <button id="tick-next" class="rounded-full px-4 py-2 text-[13px] font-medium ${hasMore ? 'tab-active' : 'tab-inactive cursor-not-allowed opacity-50'}" ${!hasMore ? 'disabled' : ''}>Next</button>
      </div>
    `;
    pager.querySelector('#tick-prev')?.addEventListener('click', () => {
      if (currentPage > 0) { currentPage--; loadTickets(); }
    });
    pager.querySelector('#tick-next')?.addEventListener('click', () => {
      if (hasMore) { currentPage++; loadTickets(); }
    });
  }

  page.querySelector('#create-ticket-btn').addEventListener('click', () => navigate('create-ticket'));

  loadTickets();
  return page;
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
