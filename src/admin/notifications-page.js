import { supabase } from '@/lib/supabase';

const PAGE_SIZE = 20;

// Admin event type → icon + color mapping
const eventConfig = {
  new_user_signup:      { icon: '👤', color: 'text-blue-500',    bg: 'bg-blue-500/10' },
  new_deposit:          { icon: '↓',  color: 'text-blue-500',    bg: 'bg-blue-500/10' },
  deposit_verified:     { icon: '✓',  color: 'text-green-500',   bg: 'bg-green-500/10' },
  deposit_credited:     { icon: '✓',  color: 'text-green-500',   bg: 'bg-green-500/10' },
  deposit_rejected:     { icon: '✕',  color: 'text-red-500',     bg: 'bg-red-500/10' },
  new_sell_order:       { icon: '↑',  color: 'text-blue-500',    bg: 'bg-blue-500/10' },
  sell_order_completed: { icon: '✓',  color: 'text-green-500',   bg: 'bg-green-500/10' },
  sell_order_rejected:  { icon: '✕',  color: 'text-red-500',     bg: 'bg-red-500/10' },
  _default:             { icon: '•',  color: 'text-text-secondary', bg: 'bg-black/[0.04]' },
};

function getEventStyle(eventType) {
  return eventConfig[eventType] || eventConfig._default;
}

export function renderAdminNotifications() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col px-5 pb-8 pt-8 md:px-8 lg:px-12';

  let currentPage = 0;
  let notifications = [];
  let hasMore = false;

  page.innerHTML = `
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="page-title">Notifications</h1>
        <p class="text-muted mt-1">Admin activity feed</p>
      </div>
      <button id="mark-all-read" class="rounded-lg px-3 py-1.5 text-[12px] font-medium text-action hover:bg-action/10 dark:text-action-dark dark:hover:bg-action-dark/10">
        Mark all read
      </button>
    </div>
    <div id="notif-list" class="flex flex-col gap-2">
      <div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>
    </div>
    <div id="notif-pagination" class="mt-4"></div>
  `;

  async function loadNotifications() {
    const list = page.querySelector('#notif-list');
    if (currentPage === 0) {
      list.innerHTML = '<div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>';
    }

    const { data, error } = await supabase.rpc('get_user_notifications', {
      p_limit: PAGE_SIZE,
      p_offset: currentPage * PAGE_SIZE,
    });

    if (error) {
      list.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">Failed to load notifications</p></div>`;
      return;
    }

    notifications = data || [];
    hasMore = notifications.length === PAGE_SIZE;
    renderList(list);
  }

  function renderList(container) {
    if (notifications.length === 0) {
      container.innerHTML = `
        <div class="card flex flex-col items-center py-16 text-center">
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
            <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"/></svg>
          </div>
          <p class="mt-4 text-[14px] font-medium text-text-primary dark:text-text-primary-dark">No notifications yet</p>
          <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">Admin activity will appear here</p>
        </div>
      `;
      page.querySelector('#notif-pagination').innerHTML = '';
      return;
    }

    container.className = 'flex flex-col gap-2';
    container.innerHTML = '';
    notifications.forEach((n) => container.appendChild(createNotifCard(n)));
    renderPagination();
  }

  function createNotifCard(n) {
    const style = getEventStyle(n.event_type);
    const isUnread = !n.read_at;
    const card = document.createElement('div');
    card.className = `card card-interactive flex items-start gap-3.5 p-4 ${isUnread ? 'ring-1 ring-action/20 dark:ring-action-dark/20' : ''}`;
    card.dataset.notifId = n.id;

    const timeStr = formatTime(n.created_at);

    card.innerHTML = `
      <div class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${style.bg}">
        <span class="text-[16px] ${style.color}">${style.icon}</span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-start justify-between gap-2">
          <p class="text-[14px] font-medium text-text-primary dark:text-text-primary-dark ${isUnread ? 'font-semibold' : ''}">${escapeHtml(n.title)}</p>
          ${isUnread ? '<span class="mt-1 h-2 w-2 flex-shrink-0 rounded-full bg-action dark:bg-action-dark"></span>' : ''}
        </div>
        ${n.description ? `<p class="mt-0.5 text-[13px] text-text-secondary dark:text-text-secondary-dark">${escapeHtml(n.description)}</p>` : ''}
        <p class="mt-1 text-[11px] text-text-secondary/70 dark:text-text-secondary-dark/70">${timeStr}</p>
      </div>
    `;

    if (isUnread) {
      card.addEventListener('click', async () => {
        await supabase.rpc('mark_notification_read', { p_id: n.id });
        card.classList.remove('ring-1', 'ring-action/20', 'dark:ring-action-dark/20');
        const dot = card.querySelector('.h-2.w-2');
        if (dot) dot.remove();
        const titleEl = card.querySelector('p.text-\\[14px\\]');
        if (titleEl) titleEl.classList.remove('font-semibold');
      });
    }

    return card;
  }

  function renderPagination() {
    const pager = page.querySelector('#notif-pagination');
    if (!hasMore && currentPage === 0) {
      pager.innerHTML = '';
      return;
    }
    pager.innerHTML = `
      <div class="flex items-center justify-between gap-3">
        <button id="notif-prev" class="rounded-full px-4 py-2 text-[13px] font-medium ${currentPage > 0 ? 'tab-active' : 'tab-inactive cursor-not-allowed opacity-50'}" ${currentPage === 0 ? 'disabled' : ''}>Previous</button>
        <span class="text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark">Page ${currentPage + 1}</span>
        <button id="notif-next" class="rounded-full px-4 py-2 text-[13px] font-medium ${hasMore ? 'tab-active' : 'tab-inactive cursor-not-allowed opacity-50'}" ${!hasMore ? 'disabled' : ''}>Next</button>
      </div>
    `;
    pager.querySelector('#notif-prev')?.addEventListener('click', () => {
      if (currentPage > 0) { currentPage--; loadNotifications(); }
    });
    pager.querySelector('#notif-next')?.addEventListener('click', () => {
      if (hasMore) { currentPage++; loadNotifications(); }
    });
  }

  page.querySelector('#mark-all-read').addEventListener('click', async () => {
    await supabase.rpc('mark_all_notifications_read');
    loadNotifications();
  });

  loadNotifications();
  return page;
}

function formatTime(iso) {
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
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
