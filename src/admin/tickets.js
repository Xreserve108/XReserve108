import { supabase } from '@/lib/supabase';
import { getUser, getDisplayUsername } from '@/core/auth';
import { navigate } from '@/core/router';

const REFRESH_MS = 10000;

const statusConfig = {
  OPEN:                { label: 'Open', color: 'text-blue-500', bg: 'bg-blue-500/10' },
  IN_PROGRESS:         { label: 'In Progress', color: 'text-blue-600', bg: 'bg-blue-600/10' },
  WAITING_FOR_USER:    { label: 'Waiting User', color: 'text-yellow-500', bg: 'bg-yellow-500/10' },
  WAITING_FOR_SUPPORT: { label: 'Waiting Support', color: 'text-orange-500', bg: 'bg-orange-500/10' },
  RESOLVED:            { label: 'Resolved', color: 'text-green-500', bg: 'bg-green-500/10' },
  CLOSED:              { label: 'Closed', color: 'text-text-secondary', bg: 'bg-black/[0.04]' },
};

const priorityConfig = {
  LOW:    { label: 'Low', color: 'text-text-secondary' },
  NORMAL: { label: 'Normal', color: '' },
  HIGH:   { label: 'High', color: 'text-orange-500' },
  URGENT: { label: 'Urgent', color: 'text-red-500' },
};

const ALL_STATUSES = ['OPEN','IN_PROGRESS','WAITING_FOR_USER','WAITING_FOR_SUPPORT','RESOLVED','CLOSED'];
const ALL_PRIORITIES = ['LOW','NORMAL','HIGH','URGENT'];
const ALL_CATEGORIES = ['Deposit','Sell Order','Account','2FA / Security','Wallet','Transaction','Other'];

export function renderAdminTickets() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col px-5 pb-8 pt-8 md:px-8 lg:px-12';

  let currentView = 'dashboard'; // 'dashboard' | 'detail'
  let selectedTicketId = null;
  let refreshTimer = null;
  let stats = {};

  page.innerHTML = `
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="page-title">Support Tickets</h1>
        <p class="text-muted mt-1">Manage user support requests</p>
      </div>
    </div>
    <div id="admin-tickets-content"></div>
  `;

  function renderDashboard() {
    currentView = 'dashboard';
    const container = page.querySelector('#admin-tickets-content');
    container.innerHTML = '<div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>';
    loadDashboard(container);
  }

  async function loadDashboard(container) {
    // Load stats
    const { data: statsData } = await supabase.rpc('support_admin_get_ticket_stats');
    stats = statsData?.[0] || {};

    // Load recent tickets
    const { data: tickets, error } = await supabase.rpc('support_admin_get_tickets', {
      p_limit: 25,
      p_sort: 'updated',
    });

    container.innerHTML = `
      <!-- Stats -->
      <div class="grid grid-cols-3 gap-3 mb-6 md:grid-cols-7">
        ${statCard('Open', stats.open_count || 0, 'text-blue-500')}
        ${statCard('In Progress', stats.in_progress_count || 0, 'text-blue-600')}
        ${statCard('Waiting User', stats.waiting_for_user || 0, 'text-yellow-500')}
        ${statCard('Waiting Support', stats.waiting_for_support || 0, 'text-orange-500')}
        ${statCard('Resolved', stats.resolved_count || 0, 'text-green-500')}
        ${statCard('Closed', stats.closed_count || 0, 'text-text-secondary')}
        ${statCard('Unassigned', stats.unassigned_count || 0, 'text-red-500')}
      </div>

      <!-- Filters -->
      <div class="flex flex-wrap gap-2 mb-4">
        <select id="filter-status" class="rounded-lg border border-border-light bg-surface-light px-3 py-1.5 text-[12px] dark:border-border-dark dark:bg-surface-dark">
          <option value="">All Statuses</option>
          ${ALL_STATUSES.map(s => `<option value="${s}">${statusConfig[s].label}</option>`).join('')}
        </select>
        <select id="filter-category" class="rounded-lg border border-border-light bg-surface-light px-3 py-1.5 text-[12px] dark:border-border-dark dark:bg-surface-dark">
          <option value="">All Categories</option>
          ${ALL_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>
        <select id="filter-priority" class="rounded-lg border border-border-light bg-surface-light px-3 py-1.5 text-[12px] dark:border-border-dark dark:bg-surface-dark">
          <option value="">All Priorities</option>
          ${ALL_PRIORITIES.map(p => `<option value="${p}">${p}</option>`).join('')}
        </select>
        <select id="filter-sort" class="rounded-lg border border-border-light bg-surface-light px-3 py-1.5 text-[12px] dark:border-border-dark dark:bg-surface-dark">
          <option value="updated">Last Updated</option>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="priority">Priority</option>
        </select>
        <input id="filter-search" type="text" placeholder="Search..." class="rounded-lg border border-border-light bg-surface-light px-3 py-1.5 text-[12px] dark:border-border-dark dark:bg-surface-dark w-32" />
      </div>

      <!-- Ticket List -->
      <div id="admin-ticket-list" class="flex flex-col gap-2"></div>
    `;

    // Render tickets
    renderTicketList(tickets || []);

    // Wire up filters
    const filterEls = ['filter-status', 'filter-category', 'filter-priority', 'filter-sort'];
    filterEls.forEach(id => {
      container.querySelector(`#${id}`)?.addEventListener('change', () => reloadList(container));
    });
    container.querySelector('#filter-search')?.addEventListener('input', debounce(() => reloadList(container), 300));
  }

  async function reloadList(container) {
    const listEl = container.querySelector('#admin-ticket-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="flex items-center justify-center py-8"><div class="auth-spinner"></div></div>';

    const params = {
      p_status: container.querySelector('#filter-status')?.value || null,
      p_category: container.querySelector('#filter-category')?.value || null,
      p_priority: container.querySelector('#filter-priority')?.value || null,
      p_sort: container.querySelector('#filter-sort')?.value || 'updated',
      p_search: container.querySelector('#filter-search')?.value || null,
      p_limit: 25,
    };

    const { data, error } = await supabase.rpc('support_admin_get_tickets', params);
    renderTicketList(data || []);
  }

  function renderTicketList(tickets) {
    const listEl = page.querySelector('#admin-ticket-list');
    if (!listEl) return;

    if (tickets.length === 0) {
      listEl.innerHTML = `
        <div class="card flex flex-col items-center py-12 text-center">
          <p class="text-[14px] text-text-secondary dark:text-text-secondary-dark">No tickets found</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = '';
    tickets.forEach(t => {
      const st = statusConfig[t.status] || statusConfig.OPEN;
      const pr = priorityConfig[t.priority] || priorityConfig.NORMAL;
      const row = document.createElement('button');
      row.className = 'card card-interactive flex items-center gap-3 p-4 text-left transition-colors w-full';
      row.innerHTML = `
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-[11px] font-mono font-semibold text-text-secondary dark:text-text-secondary-dark">${t.ticket_number}</span>
            <span class="text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark">${escapeHtml(t.username || 'Unknown')}</span>
            <span class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${st.bg} ${st.color}">${st.label}</span>
            ${pr.label && t.priority !== 'NORMAL' ? `<span class="text-[10px] font-medium ${pr.color}">${pr.label}</span>` : ''}
          </div>
          <p class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark truncate">${escapeHtml(t.subject)}</p>
          <div class="flex items-center gap-2 mt-1 text-[11px] text-text-secondary dark:text-text-secondary-dark">
            <span>${t.category}</span>
            <span>·</span>
            <span>${formatRelativeTime(t.updated_at)}</span>
          </div>
        </div>
      `;
      row.addEventListener('click', () => openTicketDetail(t.id));
      listEl.appendChild(row);
    });
  }

  async function openTicketDetail(ticketId) {
    currentView = 'detail';
    selectedTicketId = ticketId;
    const container = page.querySelector('#admin-tickets-content');
    container.innerHTML = '<div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>';

    const { data, error } = await supabase.rpc('support_admin_get_ticket', { p_ticket_id: ticketId });
    if (error || !data) {
      container.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">Ticket not found</p></div>`;
      return;
    }

    renderAdminDetail(container, data);
  }

  function renderAdminDetail(container, t) {
    const st = statusConfig[t.status] || statusConfig.OPEN;
    const pr = priorityConfig[t.priority] || priorityConfig.NORMAL;
    const myUserId = getUser()?.id;

    container.innerHTML = `
      <button id="back-to-list" class="flex items-center gap-1.5 text-[13px] font-medium text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark transition-colors mb-4">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
        Back to Tickets
      </button>

      <!-- Ticket Info -->
      <div class="card p-5 mb-4">
        <div class="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="text-[12px] font-mono font-semibold text-text-secondary dark:text-text-secondary-dark">${t.ticket_number}</span>
              <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${st.bg} ${st.color}">${st.label}</span>
            </div>
            <h2 class="text-[16px] font-semibold text-text-primary dark:text-text-primary-dark">${escapeHtml(t.subject)}</h2>
            <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark mt-0.5">by ${escapeHtml(t.username || 'Unknown')} · ${t.category}</p>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3 mb-4 md:grid-cols-4">
          <div>
            <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">Priority</p>
            <p class="text-[13px] font-medium ${priorityColor(t.priority)}">${t.priority}</p>
          </div>
          <div>
            <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">Assigned</p>
            <p class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">${escapeHtml(t.assigned_agent_name || 'Unassigned')}</p>
          </div>
          <div>
            <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">Created</p>
            <p class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">${formatDate(t.created_at)}</p>
          </div>
          <div>
            <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">Updated</p>
            <p class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">${formatRelativeTime(t.updated_at)}</p>
          </div>
        </div>

        <!-- Admin Controls -->
        <div class="flex flex-wrap gap-2">
          <select id="admin-status" class="rounded-lg border border-border-light bg-surface-light px-3 py-1.5 text-[12px] dark:border-border-dark dark:bg-surface-dark">
            ${ALL_STATUSES.map(s => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${statusConfig[s].label}</option>`).join('')}
          </select>
          <select id="admin-priority" class="rounded-lg border border-border-light bg-surface-light px-3 py-1.5 text-[12px] dark:border-border-dark dark:bg-surface-dark">
            ${ALL_PRIORITIES.map(p => `<option value="${p}" ${p === t.priority ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
          <button id="admin-assign" class="rounded-lg border border-border-light px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary dark:border-border-dark dark:text-text-secondary-dark dark:hover:text-text-primary-dark">Assign</button>
          <button id="admin-save-status" class="rounded-lg bg-action px-3 py-1.5 text-[12px] font-medium text-white dark:bg-action-dark dark:text-background-dark">Save Changes</button>
        </div>
      </div>

      <!-- Description -->
      <div class="card p-4 mb-4">
        <p class="text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark mb-2">DESCRIPTION</p>
        <p class="text-[14px] text-text-primary dark:text-text-primary-dark whitespace-pre-wrap">${escapeHtml(t.description)}</p>
      </div>

      <!-- Conversation -->
      <div class="mb-4">
        <p class="text-[13px] font-semibold text-text-primary dark:text-text-primary-dark mb-3">Conversation</p>
        <div id="admin-messages" class="flex flex-col gap-3"></div>
      </div>

      <!-- Admin Reply -->
      <div class="card p-4 mb-4">
        <textarea id="admin-reply" rows="3" maxlength="4000" placeholder="Type a reply..."
          class="w-full resize-none rounded-xl border border-border-light bg-surface-light px-3.5 py-2.5 text-[14px] text-text-primary placeholder:text-text-secondary/50 outline-none transition-colors focus:border-action dark:border-border-dark dark:bg-surface-dark dark:focus:border-action-dark dark:placeholder:text-text-secondary-dark/50 mb-3"></textarea>
        <div class="flex justify-end">
          <button id="admin-send-reply" class="btn-primary rounded-xl px-5 py-2 text-[13px] font-medium">Reply</button>
        </div>
      </div>

      <!-- Internal Notes -->
      <div class="card p-4 mb-4">
        <p class="text-[13px] font-semibold text-text-primary dark:text-text-primary-dark mb-3">Internal Notes <span class="text-[11px] font-normal text-text-secondary dark:text-text-secondary-dark">(admin only)</span></p>
        <div id="admin-notes" class="flex flex-col gap-2 mb-3"></div>
        <textarea id="admin-note-input" rows="2" maxlength="4000" placeholder="Add a note..."
          class="w-full resize-none rounded-xl border border-border-light bg-surface-light px-3.5 py-2.5 text-[13px] text-text-primary placeholder:text-text-secondary/50 outline-none transition-colors focus:border-action dark:border-border-dark dark:bg-surface-dark dark:focus:border-action-dark dark:placeholder:text-text-secondary-dark/50 mb-2"></textarea>
        <div class="flex justify-end">
          <button id="admin-add-note" class="btn-secondary rounded-xl px-4 py-2 text-[12px] font-medium">Add Note</button>
        </div>
      </div>
    `;

    // Back button
    container.querySelector('#back-to-list').addEventListener('click', () => renderDashboard());

    // Render messages
    const msgContainer = container.querySelector('#admin-messages');
    const messages = t.messages || [];
    if (messages.length === 0) {
      msgContainer.innerHTML = '<p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">No messages yet</p>';
    } else {
      messages.forEach(m => {
        const isUser = m.sender_type === 'user';
        const div = document.createElement('div');
        div.className = `flex flex-col ${isUser ? 'items-start' : 'items-end'}`;
        const bgClass = isUser ? 'bg-black/[0.04] dark:bg-white/[0.06]' : 'bg-action/10 dark:bg-action-dark/15';
        div.innerHTML = `
          <div class="flex items-center gap-2 mb-1">
            <span class="text-[11px] font-medium ${isUser ? 'text-text-secondary dark:text-text-secondary-dark' : 'text-action dark:text-action-dark'}">${escapeHtml(m.sender_name || (isUser ? 'User' : 'Admin'))}</span>
            <span class="text-[11px] text-text-secondary/60 dark:text-text-secondary-dark/60">${formatRelativeTime(m.created_at)}</span>
          </div>
          <div class="rounded-2xl ${bgClass} px-4 py-3 max-w-[85%] md:max-w-[70%]">
            <p class="text-[14px] text-text-primary dark:text-text-primary-dark whitespace-pre-wrap break-words">${escapeHtml(m.body)}</p>
          </div>
        `;
        msgContainer.appendChild(div);
      });
    }

    // Render internal notes
    const notesContainer = container.querySelector('#admin-notes');
    const notes = t.internal_notes || [];
    if (notes.length === 0) {
      notesContainer.innerHTML = '<p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">No notes yet</p>';
    } else {
      notesContainer.innerHTML = '';
      notes.forEach(n => {
        const div = document.createElement('div');
        div.className = 'rounded-xl bg-yellow-500/5 dark:bg-yellow-500/10 px-3 py-2';
        div.innerHTML = `
          <div class="flex items-center gap-2 mb-1">
            <span class="text-[11px] font-medium text-yellow-600 dark:text-yellow-400">${escapeHtml(n.admin_name || 'Admin')}</span>
            <span class="text-[11px] text-text-secondary/60 dark:text-text-secondary-dark/60">${formatRelativeTime(n.created_at)}</span>
          </div>
          <p class="text-[13px] text-text-primary dark:text-text-primary-dark">${escapeHtml(n.note)}</p>
        `;
        notesContainer.appendChild(div);
      });
    }

    // Mark messages as read
    supabase.rpc('support_admin_mark_ticket_read', { p_ticket_id: t.id });

    // Wire up controls
    container.querySelector('#admin-send-reply').addEventListener('click', async () => {
      const textarea = container.querySelector('#admin-reply');
      const body = textarea.value.trim();
      if (!body) return;
      const btn = container.querySelector('#admin-send-reply');
      btn.disabled = true;
      btn.textContent = 'Sending...';
      const { error } = await supabase.rpc('support_admin_reply_to_ticket', { p_ticket_id: t.id, p_body: body });
      if (error) { btn.disabled = false; btn.textContent = 'Reply'; return; }
      openTicketDetail(t.id);
    });

    container.querySelector('#admin-add-note').addEventListener('click', async () => {
      const textarea = container.querySelector('#admin-note-input');
      const note = textarea.value.trim();
      if (!note) return;
      const btn = container.querySelector('#admin-add-note');
      btn.disabled = true;
      btn.textContent = 'Adding...';
      const { error } = await supabase.rpc('support_admin_add_note', { p_ticket_id: t.id, p_note: note });
      if (error) { btn.disabled = false; btn.textContent = 'Add Note'; return; }
      openTicketDetail(t.id);
    });

    container.querySelector('#admin-save-status').addEventListener('click', async () => {
      const newStatus = container.querySelector('#admin-status').value;
      const newPriority = container.querySelector('#admin-priority').value;
      const btn = container.querySelector('#admin-save-status');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      if (newStatus !== t.status) {
        await supabase.rpc('support_admin_update_ticket_status', { p_ticket_id: t.id, p_status: newStatus });
      }
      if (newPriority !== t.priority) {
        await supabase.rpc('support_admin_update_ticket_priority', { p_ticket_id: t.id, p_priority: newPriority });
      }

      openTicketDetail(t.id);
    });

    container.querySelector('#admin-assign').addEventListener('click', async () => {
      const agentId = prompt('Enter admin user ID to assign:');
      if (!agentId) return;
      const { error } = await supabase.rpc('support_admin_assign_ticket', { p_ticket_id: t.id, p_agent_id: agentId });
      if (error) { alert(error.message); return; }
      openTicketDetail(t.id);
    });
  }

  // Start auto-refresh
  refreshTimer = setInterval(() => {
    if (currentView === 'dashboard') renderDashboard();
  }, REFRESH_MS);

  // Cleanup on page leave
  const observer = new MutationObserver(() => {
    if (!document.body.contains(page)) {
      clearInterval(refreshTimer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  renderDashboard();
  return page;
}

function statCard(label, count, color) {
  return `
    <div class="card flex flex-col items-center px-3 py-3 text-center">
      <p class="text-[18px] font-bold ${color}">${count}</p>
      <p class="text-[10px] font-medium text-text-secondary dark:text-text-secondary-dark">${label}</p>
    </div>
  `;
}

function priorityColor(priority) {
  switch (priority) {
    case 'URGENT': return 'text-red-500';
    case 'HIGH': return 'text-orange-500';
    case 'LOW': return 'text-text-secondary dark:text-text-secondary-dark';
    default: return 'text-text-primary dark:text-text-primary-dark';
  }
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
  } catch { return ''; }
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return ''; }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
