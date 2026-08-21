import { supabase } from '@/lib/supabase';
import { getUser, getDisplayUsername } from '@/core/auth';
import { navigate } from '@/core/router';

const REFRESH_MS = 8000;

// =============================================================================
// Admin Help & Support hub — links to Live Chat center
// =============================================================================

export function renderAdminHelpSupport() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col px-5 pb-8 pt-8 md:px-8 lg:px-12';

  page.innerHTML = `
    <h1 class="page-title">Help & Support</h1>
    <p class="text-muted mt-1 mb-8">Manage support channels</p>
    <div class="flex flex-col gap-4">
      <button id="admin-go-live-chat" class="card card-interactive flex items-center gap-4 p-5 text-left transition-colors">
        <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-green-500/10 dark:bg-green-500/15">
          <svg class="h-5 w-5 text-green-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.068.157 2.148.279 3.238.36a37.5 37.5 0 003.604 0c1.09-.081 2.17-.203 3.238-.36C16.623 15.754 17.75 14.36 17.75 12.76v-.012a3.019 3.019 0 00-.783-2.052A14.47 14.47 0 0012.82 7.12a.75.75 0 00-.64 0 14.47 14.47 0 00-4.147 3.588A3.019 3.019 0 007.25 12.75v.012z"/></svg>
        </div>
        <div class="flex-1">
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">Live Chat Center</p>
          <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Manage live support sessions</p>
        </div>
        <svg class="h-4 w-4 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>
      </button>
      <button id="admin-go-tickets" class="card card-interactive flex items-center gap-4 p-5 text-left transition-colors">
        <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10 dark:bg-blue-500/15">
          <svg class="h-5 w-5 text-blue-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h7.5"/></svg>
        </div>
        <div class="flex-1">
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">Support Tickets</p>
          <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Manage user support requests</p>
        </div>
        <svg class="h-4 w-4 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>
      </button>
    </div>
  `;

  page.querySelector('#admin-go-live-chat').addEventListener('click', () => navigate('admin/live-chat'));
  page.querySelector('#admin-go-tickets').addEventListener('click', () => navigate('admin/tickets'));
  return page;
}

export function renderAdminLiveChat() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col px-5 pb-8 pt-8 md:px-8 lg:px-12';

  let refreshTimer = null;
  let currentView = 'dashboard'; // 'dashboard' | 'conversation'
  let activeSessionId = null;

  page.innerHTML = `
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="page-title">Live Chat</h1>
        <p class="text-muted mt-1">Manage support chat sessions</p>
      </div>
    </div>
    <div id="chat-center-content"></div>
  `;

  // Agent status is managed globally by the admin layout.
  // Render dashboard and start periodic refresh.
  renderDashboard(page);
  refreshTimer = setInterval(() => {
    if (currentView === 'dashboard') renderDashboard(page);
  }, REFRESH_MS);

  // Cleanup when page element is removed from DOM (navigation away)
  const pageObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.removedNodes) {
        if (n === page) {
          if (refreshTimer) clearInterval(refreshTimer);
          pageObserver.disconnect();
          return;
        }
      }
    }
  });
  pageObserver.observe(document.body, { childList: true, subtree: true });

  return page;

  // ===========================================================================
  // Dashboard
  // ===========================================================================

  async function renderDashboard(page) {
    const container = page.querySelector('#chat-center-content');

    // Fetch stats, waiting chats, active chats in parallel
    const [statsRes, waitingRes, activeRes] = await Promise.all([
      supabase.rpc('support_admin_get_chat_stats'),
      supabase.rpc('support_admin_get_waiting_chats'),
      supabase.rpc('support_admin_get_active_chats'),
    ]);

    const stats = statsRes.data?.[0] || { active_count: 0, waiting_count: 0, available_agents: 0 };
    const waiting = waitingRes.data || [];
    const active = activeRes.data || [];

    container.innerHTML = `
      <div class="grid grid-cols-3 gap-3 mb-6">
        <div class="card p-4 text-center">
          <p class="text-[22px] font-bold text-green-500">${stats.active_count}</p>
          <p class="text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark mt-1">Active</p>
        </div>
        <div class="card p-4 text-center">
          <p class="text-[22px] font-bold text-yellow-500">${stats.waiting_count}</p>
          <p class="text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark mt-1">Waiting</p>
        </div>
        <div class="card p-4 text-center">
          <p class="text-[22px] font-bold text-text-primary dark:text-text-primary-dark">${stats.available_agents}</p>
          <p class="text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark mt-1">Agents</p>
        </div>
      </div>

      <div class="mb-4">
        <h2 class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark mb-3">Waiting Chats</h2>
        <div id="waiting-list" class="flex flex-col gap-2"></div>
      </div>

      <div>
        <h2 class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark mb-3">Active Chats</h2>
        <div id="active-list" class="flex flex-col gap-2"></div>
      </div>
    `;

    const waitingList = container.querySelector('#waiting-list');
    const activeList = container.querySelector('#active-list');

    if (waiting.length === 0) {
      waitingList.innerHTML = '<p class="text-[13px] text-text-secondary dark:text-text-secondary-dark py-4 text-center">No waiting chats</p>';
    } else {
      waiting.forEach((chat) => waitingList.appendChild(createWaitingCard(chat, page)));
    }

    if (active.length === 0) {
      activeList.innerHTML = '<p class="text-[13px] text-text-secondary dark:text-text-secondary-dark py-4 text-center">No active chats</p>';
    } else {
      active.forEach((chat) => activeList.appendChild(createActiveCard(chat, page)));
    }
  }

  function createWaitingCard(chat, page) {
    const card = document.createElement('div');
    card.className = 'card flex items-center justify-between p-4';

    const waitMin = Math.floor((chat.wait_seconds || 0) / 60);
    const waitLabel = waitMin < 1 ? '<1 min' : `${waitMin} min`;

    card.innerHTML = `
      <div class="flex-1 min-w-0">
        <p class="text-[14px] font-medium text-text-primary dark:text-text-primary-dark truncate">${escapeHtml(chat.username)}</p>
        <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Waiting: ${waitLabel}</p>
      </div>
      <button class="btn-primary px-4 py-2 text-[12px] font-medium rounded-lg accept-btn">Accept</button>
    `;

    card.querySelector('.accept-btn').addEventListener('click', async () => {
      const btn = card.querySelector('.accept-btn');
      btn.disabled = true;
      btn.textContent = 'Connecting...';

      const { data: sessionId, error } = await supabase.rpc('support_accept_chat');
      if (error || !sessionId) {
        btn.disabled = false;
        btn.textContent = 'Accept';
        return;
      }

      // Open conversation view
      activeSessionId = sessionId;
      currentView = 'conversation';
      renderConversation(page, sessionId, chat.username);
    });

    return card;
  }

  function createActiveCard(chat, page) {
    const card = document.createElement('div');
    card.className = 'card card-interactive flex items-center justify-between p-4 cursor-pointer';

    const duration = chat.connected_at
      ? formatDurationFromNow(chat.connected_at)
      : '—';

    card.innerHTML = `
      <div class="flex-1 min-w-0">
        <p class="text-[14px] font-medium text-text-primary dark:text-text-primary-dark truncate">${escapeHtml(chat.username)}</p>
        <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Duration: ${duration}${chat.unread_count > 0 ? ` · ${chat.unread_count} unread` : ''}</p>
      </div>
      <svg class="h-4 w-4 text-text-secondary dark:text-text-secondary-dark flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>
    `;

    card.addEventListener('click', () => {
      activeSessionId = chat.session_id;
      currentView = 'conversation';
      renderConversation(page, chat.session_id, chat.username);
    });

    return card;
  }

  // ===========================================================================
  // Conversation View
  // ===========================================================================

  async function renderConversation(page, sessionId, username) {
    const container = page.querySelector('#chat-center-content');
    let sending = false;
    let messages = [];

    container.innerHTML = `
      <div class="flex items-center gap-3 mb-4">
        <button id="conv-back" class="flex h-9 w-9 items-center justify-center rounded-xl text-text-secondary hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06] transition-colors">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
        </button>
        <div class="flex-1 min-w-0">
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark truncate">Chat with ${escapeHtml(username || 'User')}</p>
          <p id="conv-status" class="text-[12px] text-green-500">Active</p>
        </div>
        <button id="conv-end" class="rounded-lg px-3 py-1.5 text-[12px] font-medium text-red-500 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/10 transition-colors">End Chat</button>
      </div>
      <div id="conv-messages" class="flex-1 overflow-y-auto space-y-3 mb-4" style="min-height:300px;max-height:calc(100dvh - 380px)"></div>
      <div id="conv-input-area">
        <div class="flex items-end gap-2">
          <textarea id="conv-input" rows="1" placeholder="Type your reply..." class="input-field flex-1 resize-none py-2.5 text-[14px] leading-relaxed" maxlength="4000"></textarea>
          <button id="conv-send" class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-action text-white dark:bg-action-dark dark:text-background-dark transition-all hover:opacity-90 disabled:opacity-40" disabled>
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>
          </button>
        </div>
      </div>
    `;

    // Back button
    container.querySelector('#conv-back').addEventListener('click', () => {
      currentView = 'dashboard';
      activeSessionId = null;
      cleanupConversation();
      renderDashboard(page);
    });

    // Load messages
    const { data: msgs, error } = await supabase.rpc('support_get_chat_history', {
      p_session_id: sessionId,
      p_limit: 100,
      p_offset: 0,
    });

    if (!error && msgs) messages = msgs;

    // Mark as read
    await supabase.rpc('support_mark_chat_read', { p_session_id: sessionId });

    const msgContainer = container.querySelector('#conv-messages');
    renderMessages(msgContainer, messages);

    // Input handling
    const input = container.querySelector('#conv-input');
    const sendBtn = container.querySelector('#conv-send');

    input.addEventListener('input', () => {
      sendBtn.disabled = !input.value.trim() || sending;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (input.value.trim() && !sending) handleAdminSend();
      }
    });

    sendBtn.addEventListener('click', () => {
      if (input.value.trim() && !sending) handleAdminSend();
    });

    // End chat — with confirmation dialog
    container.querySelector('#conv-end').addEventListener('click', () => {
      const overlay = document.createElement('div');
      overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4';
      overlay.innerHTML = `
        <div class="card w-full max-w-sm p-6 text-center">
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 mx-auto mb-3">
            <svg class="h-6 w-6 text-red-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>
          </div>
          <p class="text-[16px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">End this chat?</p>
          <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-6">The user will no longer be connected to this support agent.</p>
          <div class="flex gap-3">
            <button id="admin-end-cancel" class="btn-secondary flex-1 py-2.5 text-[13px]">Keep Chat</button>
            <button id="admin-end-confirm" class="flex-1 rounded-xl bg-red-500 py-2.5 text-[13px] font-medium text-white hover:bg-red-600 transition-colors dark:bg-red-600 dark:hover:bg-red-700">End Chat</button>
          </div>
        </div>
      `;
      container.appendChild(overlay);

      overlay.querySelector('#admin-end-cancel').addEventListener('click', () => overlay.remove());
      overlay.querySelector('#admin-end-confirm').addEventListener('click', async () => {
        const confirmBtn = overlay.querySelector('#admin-end-confirm');
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Ending...';

        const { error } = await supabase.rpc('support_end_chat', { p_session_id: sessionId });
        if (error) {
          // RPC failed — keep chat open, show error, do not alter state
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'End Chat';
          overlay.remove();
          return;
        }

        overlay.remove();
        currentView = 'dashboard';
        activeSessionId = null;
        cleanupConversation();
        renderDashboard(page);
      });
    });

    // Realtime for new messages
    const msgChannel = supabase
      .channel(`admin-chat-${sessionId}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'support_chat_messages', filter: `session_id=eq.${sessionId}` },
        (payload) => {
          messages.push(payload.new);
          appendMsg(msgContainer, payload.new);
          scrollToBottom(msgContainer);
        }
      )
      .subscribe();

    const statusChannel = supabase
      .channel(`admin-chat-status-${sessionId}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'support_chat_sessions', filter: `id=eq.${sessionId}` },
        (payload) => {
          if (payload.new?.status === 'ENDED') {
            currentView = 'dashboard';
            activeSessionId = null;
            cleanupConversation();
            renderDashboard(page);
          }
        }
      )
      .subscribe();

    function cleanupConversation() {
      supabase.removeChannel(msgChannel);
      supabase.removeChannel(statusChannel);
    }

    async function handleAdminSend() {
      const body = input.value.trim();
      if (!body || sending) return;

      sending = true;
      input.value = '';
      input.style.height = 'auto';
      sendBtn.disabled = true;

      // Optimistic
      const userId = getUser()?.id;
      const optimistic = {
        id: 'pending-' + Date.now(),
        session_id: sessionId,
        sender_id: userId,
        sender_type: 'admin',
        body,
        created_at: new Date().toISOString(),
      };
      appendMsg(msgContainer, optimistic);
      scrollToBottom(msgContainer);

      const { error } = await supabase.rpc('support_send_chat_message', {
        p_session_id: sessionId,
        p_body: body,
      });

      if (error) {
        const bubbles = msgContainer.querySelectorAll(':scope > div:last-child');
        if (bubbles.length) bubbles[bubbles.length - 1].remove();
        input.value = body;
        sendBtn.disabled = false;
      }

      sending = false;
      sendBtn.disabled = !input.value.trim();
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  function renderMessages(container, msgs) {
    container.innerHTML = '';
    const userId = getUser()?.id;
    msgs.forEach((m) => appendMsg(container, m));
    scrollToBottom(container);
  }

  function appendMsg(container, msg) {
    const userId = getUser()?.id;
    const isAdmin = msg.sender_type === 'admin';
    const time = formatTime(msg.created_at);

    const bubble = document.createElement('div');
    bubble.className = `flex ${isAdmin ? 'justify-end' : 'justify-start'}`;
    bubble.innerHTML = `
      <div class="max-w-[80%] ${isAdmin
        ? 'rounded-2xl rounded-br-md bg-action px-3.5 py-2.5 text-white dark:bg-action-dark dark:text-background-dark'
        : 'rounded-2xl rounded-bl-md bg-black/[0.04] px-3.5 py-2.5 text-text-primary dark:bg-white/[0.08] dark:text-text-primary-dark'
      }">
        <p class="text-[14px] leading-relaxed break-words whitespace-pre-wrap">${escapeHtml(msg.body)}</p>
        <p class="mt-1 text-[10px] ${isAdmin ? 'text-white/60 dark:text-background-dark/50' : 'text-text-secondary/60 dark:text-text-secondary-dark/60'}">${time}</p>
      </div>
    `;
    container.appendChild(bubble);
  }

  function scrollToBottom(container) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function formatDurationFromNow(start) {
  try {
    const ms = Date.now() - new Date(start).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return '<1 min';
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  } catch { return '—'; }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
