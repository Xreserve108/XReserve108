import { supabase } from '@/lib/supabase';
import { isAuthenticated, getUser } from '@/core/auth';
import { navigate } from '@/core/router';

const statusConfig = {
  OPEN:                { label: 'Open', color: 'text-blue-500', bg: 'bg-blue-500/10' },
  IN_PROGRESS:         { label: 'In Progress', color: 'text-blue-600', bg: 'bg-blue-600/10' },
  WAITING_FOR_USER:    { label: 'Waiting for You', color: 'text-yellow-500', bg: 'bg-yellow-500/10' },
  WAITING_FOR_SUPPORT: { label: 'Waiting for Support', color: 'text-yellow-600', bg: 'bg-yellow-600/10' },
  RESOLVED:            { label: 'Resolved', color: 'text-green-500', bg: 'bg-green-500/10' },
  CLOSED:              { label: 'Closed', color: 'text-text-secondary', bg: 'bg-black/[0.04]' },
};

export function renderTicketDetail() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  if (!isAuthenticated()) {
    navigate('signin');
    return page;
  }

  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const ticketId = params.get('id');

  if (!ticketId) {
    navigate('my-tickets');
    return page;
  }

  let ticket = null;
  let sending = false;

  page.innerHTML = `
    <button id="back-to-tickets" class="flex items-center gap-1.5 text-[13px] font-medium text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark transition-colors mb-4">
      <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
      Back to Tickets
    </button>

    <div id="ticket-detail-content">
      <div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>
    </div>
  `;

  page.querySelector('#back-to-tickets').addEventListener('click', () => navigate('my-tickets'));

  loadTicketDetail(ticketId, page);

  return page;
}

async function loadTicketDetail(ticketId, page) {
  const container = page.querySelector('#ticket-detail-content');
  const myUserId = getUser()?.id;

  const { data, error } = await supabase.rpc('support_get_user_ticket', {
    p_ticket_id: ticketId,
  });

  if (error || !data) {
    container.innerHTML = `
      <div class="card flex flex-col items-center py-16 text-center">
        <p class="text-[14px] text-red-600 dark:text-red-400">Ticket not found</p>
        <button id="retry-load" class="mt-4 btn-secondary px-4 py-2 text-[13px]">Retry</button>
      </div>
    `;
    container.querySelector('#retry-load')?.addEventListener('click', () => loadTicketDetail(ticketId, page));
    return;
  }

  ticket = data;

  // Mark messages as read
  await supabase.rpc('support_mark_ticket_read', { p_ticket_id: ticketId });

  const st = statusConfig[ticket.status] || statusConfig.OPEN;
  const canReply = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_SUPPORT'].includes(ticket.status);
  const canReopen = ticket.status === 'RESOLVED';

  container.innerHTML = `
    <!-- Ticket Header -->
    <div class="card p-5 mb-4">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-[12px] font-mono font-semibold text-text-secondary dark:text-text-secondary-dark">${ticket.ticket_number}</span>
            <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${st.bg} ${st.color}">${st.label}</span>
          </div>
          <h2 class="text-[16px] font-semibold text-text-primary dark:text-text-primary-dark">${escapeHtml(ticket.subject)}</h2>
        </div>
      </div>
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-secondary dark:text-text-secondary-dark">
        <span>Category: <span class="font-medium text-text-primary dark:text-text-primary-dark">${ticket.category}</span></span>
        <span>Priority: <span class="font-medium ${priorityColor(ticket.priority)}">${ticket.priority}</span></span>
        <span>Created: ${formatDate(ticket.created_at)}</span>
        <span>Updated: ${formatRelativeTime(ticket.updated_at)}</span>
      </div>
    </div>

    <!-- Conversation -->
    <div id="ticket-messages" class="flex flex-col gap-3 mb-4"></div>

    <!-- Reply area or status actions -->
    <div id="ticket-actions"></div>
  `;

  // Render messages
  const msgContainer = container.querySelector('#ticket-messages');
  const messages = ticket.messages || [];

  if (messages.length === 0) {
    msgContainer.innerHTML = `
      <div class="card p-6 text-center">
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">No messages yet</p>
      </div>
    `;
  } else {
    // Show initial description as first "message"
    const descMsg = {
      sender_type: 'user',
      body: ticket.description,
      created_at: ticket.created_at,
      is_description: true,
    };
    const allMessages = [descMsg, ...messages];
    allMessages.forEach((m) => msgContainer.appendChild(renderMessage(m, myUserId)));
  }

  // Render actions
  const actionsContainer = container.querySelector('#ticket-actions');

  if (canReply) {
    actionsContainer.innerHTML = `
      <div class="card p-4">
        <textarea id="ticket-reply" rows="3" maxlength="4000" placeholder="Type your reply..."
          class="w-full resize-none rounded-xl border border-border-light bg-surface-light px-3.5 py-2.5 text-[14px] text-text-primary placeholder:text-text-secondary/50 outline-none transition-colors focus:border-action dark:border-border-dark dark:bg-surface-dark dark:focus:border-action-dark dark:placeholder:text-text-secondary-dark/50 mb-3"></textarea>
        <div class="flex justify-end">
          <button id="send-reply" class="btn-primary rounded-xl px-5 py-2 text-[13px] font-medium">
            Send
          </button>
        </div>
      </div>
    `;

    actionsContainer.querySelector('#send-reply').addEventListener('click', async () => {
      const textarea = actionsContainer.querySelector('#ticket-reply');
      const body = textarea.value.trim();
      if (!body || sending) return;

      sending = true;
      const btn = actionsContainer.querySelector('#send-reply');
      btn.disabled = true;
      btn.textContent = 'Sending...';

      const { error } = await supabase.rpc('support_reply_to_ticket', {
        p_ticket_id: ticketId,
        p_body: body,
      });

      if (error) {
        sending = false;
        btn.disabled = false;
        btn.textContent = 'Send';
        textarea.value = '';
        return;
      }

      // Reload ticket detail
      loadTicketDetail(ticketId, page);
    });

  } else if (canReopen) {
    actionsContainer.innerHTML = `
      <div class="card p-4 flex items-center justify-between">
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">This ticket has been resolved</p>
        <button id="reopen-ticket" class="btn-secondary rounded-xl px-4 py-2 text-[13px] font-medium">
          Reopen Ticket
        </button>
      </div>
    `;

    actionsContainer.querySelector('#reopen-ticket').addEventListener('click', async () => {
      const btn = actionsContainer.querySelector('#reopen-ticket');
      btn.disabled = true;
      btn.textContent = 'Reopening...';

      const { error } = await supabase.rpc('support_reopen_ticket', { p_ticket_id: ticketId });

      if (error) {
        btn.disabled = false;
        btn.textContent = 'Reopen Ticket';
        return;
      }

      loadTicketDetail(ticketId, page);
    });
  } else if (ticket.status === 'CLOSED') {
    actionsContainer.innerHTML = `
      <div class="card p-4 text-center">
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">This ticket is closed</p>
      </div>
    `;
  }

  // Scroll to bottom of messages
  msgContainer.scrollTop = msgContainer.scrollHeight;
}

function renderMessage(msg, myUserId) {
  const isUser = msg.sender_type === 'user';
  const div = document.createElement('div');

  const alignClass = isUser ? 'ml-auto' : 'mr-auto';
  const bgClass = isUser
    ? 'bg-action/10 dark:bg-action-dark/15'
    : 'bg-black/[0.04] dark:bg-white/[0.06]';
  const label = isUser ? 'You' : 'Support';
  const labelColor = isUser
    ? 'text-action dark:text-action-dark'
    : 'text-text-secondary dark:text-text-secondary-dark';

  div.className = `flex flex-col ${alignClass} max-w-[85%] md:max-w-[70%]`;
  div.innerHTML = `
    <div class="flex items-center gap-2 mb-1">
      <span class="text-[11px] font-medium ${labelColor}">${label}</span>
      <span class="text-[11px] text-text-secondary/60 dark:text-text-secondary-dark/60">${formatRelativeTime(msg.created_at)}</span>
    </div>
    <div class="rounded-2xl ${bgClass} px-4 py-3">
      <p class="text-[14px] text-text-primary dark:text-text-primary-dark whitespace-pre-wrap break-words">${escapeHtml(msg.body)}</p>
    </div>
  `;

  return div;
}

function priorityColor(priority) {
  switch (priority) {
    case 'URGENT': return 'text-red-500';
    case 'HIGH': return 'text-orange-500';
    case 'LOW': return 'text-text-secondary';
    default: return 'text-text-primary dark:text-text-primary-dark';
  }
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return ''; }
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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
