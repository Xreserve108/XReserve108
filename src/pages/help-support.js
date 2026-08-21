import { supabase } from '@/lib/supabase';
import { isAuthenticated, getUser } from '@/core/auth';
import { navigate } from '@/core/router';
import { getActiveChat, startChatPolling } from '@/lib/chat';

const chatIcon = `<svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.068.157 2.148.279 3.238.36a37.5 37.5 0 003.604 0c1.09-.081 2.17-.203 3.238-.36C16.623 15.754 17.75 14.36 17.75 12.76v-.012a3.019 3.019 0 00-.783-2.052A14.47 14.47 0 0012.82 7.12a.75.75 0 00-.64 0 14.47 14.47 0 00-4.147 3.588A3.019 3.019 0 007.25 12.75v.012z"/></svg>`;
const historyIcon = `<svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
const ticketIcon = `<svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h7.5"/></svg>`;

const statusConfig = {
  OPEN:                { label: 'Open', color: 'text-blue-500', bg: 'bg-blue-500/10' },
  IN_PROGRESS:         { label: 'In Progress', color: 'text-blue-600', bg: 'bg-blue-600/10' },
  WAITING_FOR_USER:    { label: 'Waiting for You', color: 'text-yellow-500', bg: 'bg-yellow-500/10' },
  WAITING_FOR_SUPPORT: { label: 'Waiting for Support', color: 'text-yellow-600', bg: 'bg-yellow-600/10' },
  RESOLVED:            { label: 'Resolved', color: 'text-green-500', bg: 'bg-green-500/10' },
  CLOSED:              { label: 'Closed', color: 'text-text-secondary', bg: 'bg-black/[0.04]' },
};

// Friendly labels for deposit/sell-order statuses in ticket popup
const txStatusLabels = {
  PENDING: 'Pending', PENDING_VERIFICATION: 'Under Verification',
  UNDER_REVIEW: 'Under Review', CREDITED: 'Credited', REJECTED: 'Rejected',
  PAYMENT_PENDING: 'Payment Pending', PAYMENT_PROOF_UPLOADED: 'Proof Uploaded',
  COMPLETED: 'Completed', CANCELLED: 'Cancelled', MANUAL_REVIEW: 'Manual Review',
};
const txStatusColors = {
  PENDING: 'bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  PENDING_VERIFICATION: 'bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  UNDER_REVIEW: 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400',
  CREDITED: 'bg-green-500/10 text-green-600 dark:bg-green-500/15 dark:text-green-400',
  REJECTED: 'bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400',
  PAYMENT_PENDING: 'bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  PAYMENT_PROOF_UPLOADED: 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400',
  COMPLETED: 'bg-green-500/10 text-green-600 dark:bg-green-500/15 dark:text-green-400',
  CANCELLED: 'bg-gray-500/10 text-gray-500 dark:bg-gray-500/15 dark:text-gray-400',
  MANUAL_REVIEW: 'bg-purple-500/10 text-purple-600 dark:bg-purple-500/15 dark:text-purple-400',
};

export function renderHelpSupport() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  if (!isAuthenticated()) {
    navigate('signin');
    return page;
  }

  // Start chat polling if not already running
  startChatPolling();

  page.innerHTML = `
    <h1 class="page-title">Help & Support</h1>
    <p class="text-muted mt-1 mb-8">Get help from our support team</p>

    <div class="flex flex-col gap-6">
      <!-- LIVE SUPPORT SECTION -->
      <section>
        <div id="hs-chat-content" class="flex flex-col gap-3">
          <div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>
        </div>
      </section>

      <!-- SUPPORT TICKETS SECTION -->
      <section id="hs-tickets-section" class="hidden">
        <div class="mb-3 flex items-center justify-between">
          <span class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">SUPPORT TICKETS</span>
          <button id="hs-create-ticket-top" class="text-[12px] font-medium text-action dark:text-action-dark hover:underline">+ New Ticket</button>
        </div>
        <!-- Summary counts -->
        <div id="hs-ticket-summary" class="hidden"></div>
        <!-- Ticket list -->
        <div id="hs-tickets-content" class="flex flex-col gap-2 mt-3">
          <div class="flex items-center justify-center py-8"><div class="auth-spinner"></div></div>
        </div>
      </section>
    </div>
  `;

  page.querySelector('#hs-create-ticket-top').addEventListener('click', () => navigate('create-ticket'));

  loadAvailability(page);
  loadTicketList(page);
  return page;
}

async function loadAvailability(page) {
  const container = page.querySelector('#hs-chat-content');
  const activeChat = getActiveChat();

  if (activeChat && activeChat.status === 'ACTIVE') {
    renderActiveChatCard(container);
    renderHistoryLink(container);
    return;
  }

  if (activeChat && activeChat.status === 'WAITING') {
    renderQueueCard(container, activeChat);
    renderHistoryLink(container);
    return;
  }

  const { data: avail, error } = await supabase.rpc('support_get_chat_availability');

  if (error) {
    container.innerHTML = `
      <div class="card flex flex-col items-center py-10 text-center">
        <p class="text-[14px] text-red-600 dark:text-red-400">Unable to load support availability</p>
        <button id="hs-retry" class="mt-4 btn-secondary px-4 py-2 text-[13px]">Retry</button>
      </div>
    `;
    container.querySelector('#hs-retry').addEventListener('click', () => loadAvailability(page));
    return;
  }

  const info = avail?.[0] || { available_agents: 0, queue_size: 0, estimated_wait_seconds: 0 };
  renderAvailabilityCard(container, info);
  renderHistoryLink(container);
}

function renderAvailabilityCard(container, info) {
  const { available_agents, queue_size, estimated_wait_seconds } = info;

  let statusColor, statusDot, statusText, waitText, btnText, btnClass, btnDisabled;

  if (available_agents > 0) {
    statusColor = 'text-green-500';
    statusDot = 'bg-green-500';
    statusText = `${available_agents} support agent${available_agents > 1 ? 's' : ''} available`;
    waitText = estimated_wait_seconds < 60
      ? 'Estimated wait: <1 minute'
      : `Estimated wait: ~${Math.ceil(estimated_wait_seconds / 60)} minute${Math.ceil(estimated_wait_seconds / 60) > 1 ? 's' : ''}`;
    btnText = 'Start Live Chat';
    btnClass = 'btn-primary';
    btnDisabled = false;
  } else if (queue_size > 0) {
    statusColor = 'text-yellow-500';
    statusDot = 'bg-yellow-500';
    statusText = 'All agents currently busy';
    waitText = estimated_wait_seconds < 60
      ? 'Estimated wait: <1 minute'
      : `Estimated wait: ~${Math.ceil(estimated_wait_seconds / 60)} minutes`;
    btnText = 'Join Queue';
    btnClass = 'btn-primary';
    btnDisabled = false;
  } else {
    statusColor = 'text-red-500';
    statusDot = 'bg-red-500';
    statusText = 'No support agents currently available';
    waitText = 'Check back later or create a support ticket';
    btnText = 'No Agents Available';
    btnClass = 'btn-secondary opacity-60 cursor-not-allowed';
    btnDisabled = true;
  }

  container.innerHTML = `
    <div class="card p-6">
      <div class="flex items-center gap-2 mb-4">
        <span class="relative flex h-3 w-3">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full ${statusDot} opacity-75"></span>
          <span class="relative inline-flex rounded-full h-3 w-3 ${statusDot}"></span>
        </span>
        <span class="text-[14px] font-semibold ${statusColor}">LIVE SUPPORT</span>
      </div>
      <p class="text-[15px] font-medium text-text-primary dark:text-text-primary-dark mb-1">${statusText}</p>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-6">${waitText}</p>
      <button id="hs-start-chat" class="${btnClass} w-full py-3 text-[14px] font-medium rounded-xl" ${btnDisabled ? 'disabled' : ''}>
        ${btnText}
      </button>
    </div>
  `;

  if (!btnDisabled) {
    container.querySelector('#hs-start-chat').addEventListener('click', handleStartChat);
  }
}

function renderActiveChatCard(container) {
  container.innerHTML = `
    <div class="card p-6">
      <div class="flex items-center gap-2 mb-4">
        <span class="relative flex h-3 w-3">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
        </span>
        <span class="text-[14px] font-semibold text-green-500">ACTIVE CHAT</span>
      </div>
      <p class="text-[15px] font-medium text-text-primary dark:text-text-primary-dark mb-1">You have an active support chat</p>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-6">Continue your conversation with our support team</p>
      <button id="hs-return-chat" class="btn-primary w-full py-3 text-[14px] font-medium rounded-xl">
        Return to Chat
      </button>
    </div>
  `;
  container.querySelector('#hs-return-chat').addEventListener('click', () => navigate('live-chat'));
}

function renderQueueCard(container, chat) {
  container.innerHTML = `
    <div class="card p-6">
      <div class="flex items-center gap-2 mb-4">
        <span class="relative flex h-3 w-3">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-500 opacity-75"></span>
          <span class="relative inline-flex rounded-full h-3 w-3 bg-yellow-500"></span>
        </span>
        <span class="text-[14px] font-semibold text-yellow-500">IN QUEUE</span>
      </div>
      <p class="text-[15px] font-medium text-text-primary dark:text-text-primary-dark mb-1">Waiting for a support agent</p>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-6">You'll be connected when an agent becomes available</p>
      <button id="hs-return-queue" class="btn-primary w-full py-3 text-[14px] font-medium rounded-xl">
        View Queue Status
      </button>
    </div>
  `;
  container.querySelector('#hs-return-queue').addEventListener('click', () => navigate('live-chat'));
}

function renderHistoryLink(container) {
  const link = document.createElement('button');
  link.className = 'flex items-center justify-center gap-2 py-3 text-[13px] font-medium text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark transition-colors';
  link.innerHTML = `${historyIcon}<span>View Chat History</span>`;
  link.addEventListener('click', () => navigate('chat-history'));
  container.appendChild(link);
}

async function handleStartChat() {
  const btn = document.getElementById('hs-start-chat');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Connecting...';
  }

  try {
    const { data, error } = await supabase.rpc('support_start_live_chat');
    if (error) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Start Live Chat';
      }
      return;
    }
    navigate('live-chat');
  } catch {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Start Live Chat';
    }
  }
}

// =============================================================================
// Ticket list + popup
// =============================================================================

async function loadTicketList(page) {
  const section = page.querySelector('#hs-tickets-section');
  const summaryEl = page.querySelector('#hs-ticket-summary');
  const container = page.querySelector('#hs-tickets-content');

  section.classList.remove('hidden');

  // Fetch summary counts + ticket list in parallel
  const [{ data: summaryData }, { data: tickets, error }] = await Promise.all([
    supabase.rpc('support_get_user_ticket_summary'),
    supabase.rpc('support_get_user_tickets', { p_status: null, p_limit: 15, p_offset: 0 }),
  ]);

  const summary = summaryData?.[0] || { open_count: 0, waiting_count: 0, resolved_count: 0 };

  // Render summary counts
  summaryEl.classList.remove('hidden');
  summaryEl.innerHTML = `
    <div class="flex gap-3">
      <div class="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2 text-center flex-1">
        <p class="text-[16px] font-bold text-text-primary dark:text-text-primary-dark">${summary.open_count || 0}</p>
        <p class="text-[10px] font-medium text-text-secondary dark:text-text-secondary-dark">Open</p>
      </div>
      <div class="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2 text-center flex-1">
        <p class="text-[16px] font-bold text-yellow-500">${summary.waiting_count || 0}</p>
        <p class="text-[10px] font-medium text-text-secondary dark:text-text-secondary-dark">Waiting</p>
      </div>
      <div class="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2 text-center flex-1">
        <p class="text-[16px] font-bold text-green-500">${summary.resolved_count || 0}</p>
        <p class="text-[10px] font-medium text-text-secondary dark:text-text-secondary-dark">Resolved</p>
      </div>
    </div>
  `;

  if (error || !tickets || tickets.length === 0) {
    container.innerHTML = `
      <div class="card p-5 text-center">
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-3">No support tickets yet</p>
        <button id="hs-create-ticket" class="btn-primary px-4 py-2 text-[12px] font-medium rounded-xl">Create Ticket</button>
      </div>
    `;
    container.querySelector('#hs-create-ticket')?.addEventListener('click', () => navigate('create-ticket'));
    return;
  }

  container.innerHTML = '';
  tickets.forEach((t) => {
    const row = createTicketRow(t, page);
    container.appendChild(row);
  });

  // "View all" link if there might be more
  if (tickets.length >= 15) {
    const viewAll = document.createElement('button');
    viewAll.className = 'text-center text-[12px] font-medium text-action dark:text-action-dark hover:underline py-2';
    viewAll.textContent = 'View all tickets →';
    viewAll.addEventListener('click', () => navigate('my-tickets'));
    container.appendChild(viewAll);
  }
}

function createTicketRow(t, page) {
  const st = statusConfig[t.status] || statusConfig.OPEN;
  const row = document.createElement('button');
  row.className = 'card flex items-center gap-3 p-3.5 text-left transition-colors w-full hover:border-action/30 dark:hover:border-action-dark/30';
  row.setAttribute('aria-label', `Ticket ${t.ticket_number}: ${t.subject}`);

  row.innerHTML = `
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2 mb-0.5">
        <span class="text-[11px] font-mono font-semibold text-text-secondary dark:text-text-secondary-dark">${t.ticket_number}</span>
        <span class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${st.bg} ${st.color} whitespace-nowrap">${st.label}</span>
      </div>
      <p class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark truncate">${escapeHtml(t.subject)}</p>
    </div>
    <span class="text-[11px] text-text-secondary dark:text-text-secondary-dark flex-shrink-0">${formatDateShort(t.updated_at)}</span>
  `;

  row.addEventListener('click', () => openTicketPopup(t.id, page));
  return row;
}

// =============================================================================
// Ticket popup
// =============================================================================

async function openTicketPopup(ticketId, page) {
  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[100] flex items-end justify-center bg-black/50 backdrop-blur-sm md:items-center';
  overlay.innerHTML = `
    <div class="card w-full max-w-lg max-h-[85dvh] overflow-y-auto p-5 step-enter md:rounded-2xl rounded-t-2xl">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-[16px] font-semibold text-text-primary dark:text-text-primary-dark">Ticket Details</h2>
        <button id="popup-close" class="rounded-lg p-1.5 text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors" aria-label="Close">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div id="popup-body" class="flex items-center justify-center py-8"><div class="auth-spinner"></div></div>
    </div>
  `;

  document.body.appendChild(overlay);

  const closePopup = () => overlay.remove();
  overlay.querySelector('#popup-close').addEventListener('click', closePopup);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePopup(); });

  // Escape key closes popup
  const escHandler = (e) => { if (e.key === 'Escape') { closePopup(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);

  // Fetch latest ticket data
  const { data: ticket, error } = await supabase.rpc('support_get_user_ticket', { p_ticket_id: ticketId });

  if (error || !ticket) {
    overlay.querySelector('#popup-body').innerHTML = `<p class="text-[13px] text-red-600 dark:text-red-400 text-center py-4">Unable to load ticket</p>`;
    return;
  }

  // Mark as read
  await supabase.rpc('support_mark_ticket_read', { p_ticket_id: ticketId }).catch(() => {});

  const st = statusConfig[ticket.status] || statusConfig.OPEN;
  const body = overlay.querySelector('#popup-body');

  // Build popup content
  let html = `
    <!-- Header -->
    <div class="flex items-center gap-2 mb-3">
      <span class="text-[13px] font-mono font-bold text-text-primary dark:text-text-primary-dark">${ticket.ticket_number}</span>
      <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${st.bg} ${st.color}">${st.label}</span>
    </div>
    <h3 class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">${escapeHtml(ticket.subject)}</h3>
    <div class="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-secondary dark:text-text-secondary-dark mb-4">
      <span>Category: <span class="font-medium text-text-primary dark:text-text-primary-dark">${ticket.category}</span></span>
      <span>Created: ${formatDate(ticket.created_at)}</span>
    </div>
  `;

  // Linked transaction info
  if (ticket.deposit_info) {
    const di = ticket.deposit_info;
    const txSt = txStatusLabels[di.status] || di.status;
    const txColor = txStatusColors[di.status] || txStatusColors.PENDING;
    html += `
      <div class="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] p-3 mb-4">
        <p class="text-[11px] font-semibold text-text-secondary dark:text-text-secondary-dark uppercase tracking-wide mb-1.5">Deposit Transaction</p>
        <div class="flex items-center justify-between">
          <span class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">${di.amount} ${di.asset} via ${di.network}</span>
          <span class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${txColor}">${txSt}</span>
        </div>
        ${di.tx_hash ? `<p class="text-[11px] text-text-secondary dark:text-text-secondary-dark mt-1 truncate font-mono">TX: ${escapeHtml(di.tx_hash.slice(0, 16))}...</p>` : ''}
      </div>
    `;
  }

  if (ticket.sell_order_info) {
    const si = ticket.sell_order_info;
    const txSt = txStatusLabels[si.status] || si.status;
    const txColor = txStatusColors[si.status] || txStatusColors.PENDING;
    html += `
      <div class="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] p-3 mb-4">
        <p class="text-[11px] font-semibold text-text-secondary dark:text-text-secondary-dark uppercase tracking-wide mb-1.5">Sell Order</p>
        <div class="flex items-center justify-between">
          <span class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">${si.usdt_amount} USDT → ₹${si.inr_amount} INR</span>
          <span class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${txColor}">${txSt}</span>
        </div>
      </div>
    `;
  }

  // Description
  html += `
    <div class="mb-4">
      <p class="text-[11px] font-semibold text-text-secondary dark:text-text-secondary-dark uppercase tracking-wide mb-1.5">Description</p>
      <p class="text-[13px] text-text-primary dark:text-text-primary-dark whitespace-pre-wrap break-words">${escapeHtml(ticket.description)}</p>
    </div>
  `;

  // Messages / conversation
  const messages = ticket.messages || [];
  if (messages.length > 0) {
    html += `<p class="text-[11px] font-semibold text-text-secondary dark:text-text-secondary-dark uppercase tracking-wide mb-2">Conversation</p>`;
    html += `<div class="flex flex-col gap-2 mb-4">`;
    messages.forEach((m) => {
      const isUser = m.sender_type === 'user';
      const alignClass = isUser ? 'ml-auto' : 'mr-auto';
      const bgClass = isUser ? 'bg-action/10 dark:bg-action-dark/15' : 'bg-black/[0.04] dark:bg-white/[0.06]';
      const label = isUser ? 'You' : 'Support';
      const labelColor = isUser ? 'text-action dark:text-action-dark' : 'text-text-secondary dark:text-text-secondary-dark';

      html += `
        <div class="flex flex-col ${alignClass} max-w-[85%]">
          <div class="flex items-center gap-2 mb-0.5">
            <span class="text-[10px] font-medium ${labelColor}">${label}</span>
            <span class="text-[10px] text-text-secondary/60 dark:text-text-secondary-dark/60">${formatDateShort(m.created_at)}</span>
          </div>
          <div class="rounded-2xl ${bgClass} px-3 py-2">
            <p class="text-[13px] text-text-primary dark:text-text-primary-dark whitespace-pre-wrap break-words">${escapeHtml(m.body)}</p>
          </div>
        </div>
      `;
    });
    html += `</div>`;
  }

  body.innerHTML = html;
}

// =============================================================================
// Helpers
// =============================================================================

function formatDateShort(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
  div.textContent = str || '';
  return div.innerHTML;
}
