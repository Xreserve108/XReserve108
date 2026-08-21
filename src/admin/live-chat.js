import { supabase } from '@/lib/supabase';
import { getUser } from '@/core/auth';
import { navigate } from '@/core/router';
import { startChatHeartbeat, stopChatHeartbeat } from '@/lib/chat';

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
          <svg class="h-5 w-5 text-green-500" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.678 3.348-3.97z" clip-rule="evenodd"/></svg>
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

// =============================================================================
// Admin Live Chat Center
// =============================================================================
// Message integrity (mirrors the user page):
//   - DB is the source of truth; history is fetched on every conversation open.
//   - Sending: optimistic bubble (temp id) -> RPC -> swap in persisted id;
//     Realtime dedups by id.
//   - Channels use unique names per open and are ALWAYS removed when the
//     conversation closes or the admin navigates away.
// =============================================================================

export function renderAdminLiveChat() {
  const page = document.createElement('main');
  page.className = 'page-enter flex flex-1 flex-col min-h-0 overflow-hidden';

  let refreshTimer = null;
  let currentView = 'dashboard'; // 'dashboard' | 'conversation'
  let activeSessionId = null;
  let cleanupConversation = null; // removes the current Realtime channels
  let destroyed = false;

  page.innerHTML = `
    <div id="chat-center-content" class="flex min-h-0 flex-1 flex-col"></div>
  `;

  renderDashboard(page);
  refreshTimer = setInterval(() => {
    if (!destroyed && currentView === 'dashboard') renderDashboard(page);
  }, REFRESH_MS);

  // Cleanup when page element is removed from DOM (navigation away):
  // stop the refresh loop AND tear down any open conversation's channels.
  const pageObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.removedNodes) {
        if (n === page) {
          destroyed = true;
          if (refreshTimer) clearInterval(refreshTimer);
          if (cleanupConversation) cleanupConversation();
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
    if (destroyed) return;
    const container = page.querySelector('#chat-center-content');

    const [statsRes, waitingRes, activeRes] = await Promise.all([
      supabase.rpc('support_admin_get_chat_stats'),
      supabase.rpc('support_admin_get_waiting_chats'),
      supabase.rpc('support_admin_get_active_chats'),
    ]);
    if (destroyed || currentView !== 'dashboard') return;

    const stats = statsRes.data?.[0] || { active_count: 0, waiting_count: 0, available_agents: 0 };
    const waiting = waitingRes.data || [];
    const active = activeRes.data || [];

    container.innerHTML = `
      <div class="mb-6">
        <h1 class="page-title">Live Chat</h1>
        <p class="text-muted mt-1">Manage support chat sessions</p>
      </div>
      <div class="mb-6 grid grid-cols-3 gap-3">
        <div class="card p-4 text-center">
          <p class="text-[22px] font-bold text-green-500">${stats.active_count}</p>
          <p class="mt-1 text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark">Active</p>
        </div>
        <div class="card p-4 text-center">
          <p class="text-[22px] font-bold text-yellow-500">${stats.waiting_count}</p>
          <p class="mt-1 text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark">Waiting</p>
        </div>
        <div class="card p-4 text-center">
          <p class="text-[22px] font-bold text-text-primary dark:text-text-primary-dark">${stats.available_agents}</p>
          <p class="mt-1 text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark">Agents</p>
        </div>
      </div>

      <div class="mb-4">
        <h2 class="mb-3 text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">Waiting Chats</h2>
        <div id="waiting-list" class="flex flex-col gap-2"></div>
      </div>

      <div>
        <h2 class="mb-3 text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">Active Chats</h2>
        <div id="active-list" class="flex flex-col gap-2"></div>
      </div>
    `;

    const waitingList = container.querySelector('#waiting-list');
    const activeList = container.querySelector('#active-list');

    if (waiting.length === 0) {
      waitingList.innerHTML = '<p class="py-4 text-center text-[13px] text-text-secondary dark:text-text-secondary-dark">No waiting chats</p>';
    } else {
      waiting.forEach((chat) => waitingList.appendChild(createWaitingCard(chat, page)));
    }

    if (active.length === 0) {
      activeList.innerHTML = '<p class="py-4 text-center text-[13px] text-text-secondary dark:text-text-secondary-dark">No active chats</p>';
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
      <div class="min-w-0 flex-1">
        <p class="truncate text-[14px] font-medium text-text-primary dark:text-text-primary-dark">${escapeHtml(chat.username)}</p>
        <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Waiting: ${waitLabel}</p>
      </div>
      <button class="accept-btn btn-primary rounded-lg px-4 py-2 text-[12px] font-medium">Accept</button>
    `;

    card.querySelector('.accept-btn').addEventListener('click', async () => {
      const btn = card.querySelector('.accept-btn');
      btn.disabled = true;
      btn.textContent = 'Connecting...';

      const { data: sessionId, error } = await supabase.rpc('support_accept_chat');
      if (destroyed) return;
      if (error || !sessionId) {
        btn.disabled = false;
        btn.textContent = 'Accept';
        return;
      }

      openConversation(page, sessionId, chat.username);
    });

    return card;
  }

  function createActiveCard(chat, page) {
    const card = document.createElement('div');
    card.className = 'card card-interactive flex cursor-pointer items-center justify-between p-4';

    const duration = chat.connected_at
      ? formatDurationFromNow(chat.connected_at)
      : '—';

    card.innerHTML = `
      <div class="min-w-0 flex-1">
        <p class="truncate text-[14px] font-medium text-text-primary dark:text-text-primary-dark">${escapeHtml(chat.username)}</p>
        <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Duration: ${duration}${chat.unread_count > 0 ? ` · ${chat.unread_count} unread` : ''}</p>
      </div>
      <svg class="h-4 w-4 flex-shrink-0 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>
    `;

    card.addEventListener('click', () => {
      openConversation(page, chat.session_id, chat.username);
    });

    return card;
  }

  // ===========================================================================
  // Conversation View — professional chat shell
  // ===========================================================================

  function openConversation(page, sessionId, username) {
    // Tear down any previously open conversation first
    if (cleanupConversation) cleanupConversation();

    currentView = 'conversation';
    activeSessionId = sessionId;
    // Admin has an ACTIVE chat — start global presence heartbeat.
    // This runs across admin page navigation until the conversation closes.
    startChatHeartbeat();
    renderConversation(page, sessionId, username);
  }

  function closeConversation() {
    if (cleanupConversation) cleanupConversation();
    cleanupConversation = null;
    stopChatHeartbeat(); // admin closed conversation → stop presence heartbeat
    currentView = 'dashboard';
    activeSessionId = null;
    if (!destroyed) renderDashboard(page);
  }

  async function renderConversation(page, sessionId, username) {
    const container = page.querySelector('#chat-center-content');
    let sending = false;
    let messages = [];
    const seenIds = new Set();
    let convDestroyed = false;

    // Unique channel names per open — reusing a name would create a fresh
    // unjoined channel instance while any stale one keeps receiving events.
    const seq = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    container.innerHTML = `
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border-light bg-surface-light dark:border-border-dark dark:bg-surface-dark">
        <div class="flex flex-shrink-0 items-center gap-2 border-b border-border-light px-3 py-2.5 dark:border-border-dark md:px-4">
          <button id="conv-back" aria-label="Back to chat list" class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
          </button>
          <div class="min-w-0 flex-1">
            <p class="truncate text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">Chat with ${escapeHtml(username || 'User')}</p>
            <p id="conv-status" class="text-[12px] text-green-500">Active</p>
          </div>
          <button id="conv-end" class="flex-shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-medium text-red-500 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/10">End Chat</button>
        </div>
        <div id="conv-messages" class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 md:px-6" role="log" aria-label="Chat messages">
          <div class="flex flex-1 items-center justify-center py-12"><div class="auth-spinner"></div></div>
        </div>
        <div class="flex-shrink-0 border-t border-border-light px-3 pt-2.5 pb-2 dark:border-border-dark md:px-4">
          <div class="flex items-end gap-2">
            <textarea id="conv-input" rows="1" placeholder="Type your reply..." aria-label="Reply" class="input-field max-h-[120px] min-w-0 flex-1 resize-none py-2.5 text-[14px] leading-relaxed" maxlength="4000"></textarea>
            <button id="conv-send" aria-label="Send reply" class="flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-xl bg-action text-white transition-all hover:opacity-90 disabled:opacity-40 dark:bg-action-dark dark:text-background-dark" disabled>
              <svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;

    const msgContainer = container.querySelector('#conv-messages');
    const input = container.querySelector('#conv-input');
    const sendBtn = container.querySelector('#conv-send');

    container.querySelector('#conv-back').addEventListener('click', closeConversation);

    // ------------------------------------------------------------------
    // Message state — every path funnels through addMessage (id dedup)
    // ------------------------------------------------------------------

    function addMessage(msg) {
      if (!msg || !msg.id || seenIds.has(msg.id)) return false;
      seenIds.add(msg.id);
      messages.push(msg);
      return true;
    }

    // ------------------------------------------------------------------
    // Load persisted history (source of truth)
    // ------------------------------------------------------------------

    const { data: msgs, error } = await supabase.rpc('support_get_chat_history', {
      p_session_id: sessionId,
      p_limit: 100,
      p_offset: 0,
    });
    if (destroyed || convDestroyed || currentView !== 'conversation' || activeSessionId !== sessionId) return;

    if (error) {
      console.error('[admin-live-chat] support_get_chat_history FAILED', {
        session_id: sessionId,
        error_message: error.message,
        error_details: error.details,
        error_hint: error.hint,
        error_code: error.code,
      });
      msgContainer.innerHTML = `
        <div class="flex flex-1 flex-col items-center justify-center py-12 text-center">
          <p class="text-[13px] text-red-600 dark:text-red-400">Unable to load conversation history.</p>
          <p class="mt-1 text-[11px] text-text-secondary dark:text-text-secondary-dark">Error: ${escapeHtml(error.message || 'unknown')}</p>
          <p class="mt-1 text-[11px] text-text-secondary dark:text-text-secondary-dark">Session: ${sessionId || 'none'}</p>
          <button id="conv-retry" class="btn-secondary mt-3 px-4 py-2 text-[12px]">Retry</button>
        </div>
      `;
      msgContainer.querySelector('#conv-retry')?.addEventListener('click', () => {
        closeConversation();
        openConversation(page, sessionId, username);
      });
      return;
    }

    messages = msgs || [];
    messages.forEach((m) => seenIds.add(m.id));

    msgContainer.innerHTML = '';

    if (messages.length === 0) {
      // Empty conversation — normal state, not an error
      msgContainer.innerHTML = `
        <div data-empty-state class="py-8 text-center">
          <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06] mx-auto">
            <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.678 3.348-3.97z" clip-rule="evenodd"/></svg>
          </div>
          <p class="text-[13px] font-medium text-text-secondary dark:text-text-secondary-dark">No messages yet</p>
          <p class="mt-0.5 text-[11px] text-text-secondary/60 dark:text-text-secondary-dark/60">Send a message to start the conversation</p>
        </div>
      `;
    } else {
      messages.forEach((m) => appendMsg(msgContainer, m));
    }
    scrollToBottom(msgContainer);

    // Mark as read
    supabase.rpc('support_mark_chat_read', { p_session_id: sessionId });

    // ------------------------------------------------------------------
    // Input handling
    // ------------------------------------------------------------------

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

    // ------------------------------------------------------------------
    // End chat — confirmation dialog
    // ------------------------------------------------------------------

    container.querySelector('#conv-end').addEventListener('click', () => {
      const overlay = document.createElement('div');
      overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm';
      overlay.innerHTML = `
        <div class="card w-full max-w-sm p-6 text-center">
          <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
            <svg class="h-6 w-6 text-red-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>
          </div>
          <p class="mb-1 text-[16px] font-semibold text-text-primary dark:text-text-primary-dark">End this chat?</p>
          <p class="mb-6 text-[13px] text-text-secondary dark:text-text-secondary-dark">The user will be disconnected and the conversation is cleared once the session ends.</p>
          <div class="flex gap-3">
            <button id="admin-end-cancel" class="btn-secondary flex-1 py-2.5 text-[13px]">Keep Chat</button>
            <button id="admin-end-confirm" class="flex-1 rounded-xl bg-red-500 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-700">End Chat</button>
          </div>
        </div>
      `;
      container.appendChild(overlay);

      overlay.querySelector('#admin-end-cancel').addEventListener('click', () => overlay.remove());
      overlay.querySelector('#admin-end-confirm').addEventListener('click', async () => {
        const confirmBtn = overlay.querySelector('#admin-end-confirm');
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Ending...';

        const { error: endErr } = await supabase.rpc('support_end_chat', { p_session_id: sessionId });
        if (destroyed || convDestroyed) return;
        if (endErr) {
          // RPC failed — keep chat open, show error, do not alter state
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'End Chat';
          overlay.remove();
          return;
        }

        overlay.remove();
        closeConversation();
      });
    });

    // ------------------------------------------------------------------
    // Realtime — exactly one message + one status subscription
    // ------------------------------------------------------------------

    const msgChannel = supabase
      .channel(`admin-chat-${sessionId}-${seq}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'support_chat_messages', filter: `session_id=eq.${sessionId}` },
        (payload) => {
          if (convDestroyed || payload.new.session_id !== sessionId) return;
          if (!addMessage(payload.new)) return; // duplicate id → skip
          appendMsg(msgContainer, payload.new);
          scrollToBottom(msgContainer);
          if (payload.new.sender_id !== getUser()?.id) {
            supabase.rpc('support_mark_chat_read', { p_session_id: sessionId });
          }
        }
      )
      .subscribe();

    const statusChannel = supabase
      .channel(`admin-chat-status-${sessionId}-${seq}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'support_chat_sessions', filter: `id=eq.${sessionId}` },
        (payload) => {
          if (convDestroyed) return;
          if (payload.new?.status === 'ENDED') {
            handleSessionEnded();
          }
        }
      )
      .on('postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'support_chat_sessions', filter: `id=eq.${sessionId}` },
        () => {
          if (convDestroyed) return;
          handleSessionEnded();
        }
      )
      .subscribe();

    function handleSessionEnded() {
      if (convDestroyed) return;
      // Disable composer immediately
      const inp = container.querySelector('#conv-input');
      const snd = container.querySelector('#conv-send');
      if (inp) { inp.disabled = true; inp.placeholder = 'Chat ended'; }
      if (snd) snd.disabled = true;
      // Update status indicator
      const statusEl = container.querySelector('#conv-status');
      if (statusEl) {
        statusEl.textContent = 'Session ended';
        statusEl.className = 'text-[12px] text-text-secondary dark:text-text-secondary-dark';
      }
      // Tear down and return to dashboard
      closeConversation();
    }

    cleanupConversation = () => {
      convDestroyed = true;
      supabase.removeChannel(msgChannel);
      supabase.removeChannel(statusChannel);
      cleanupConversation = null;
    };

    // ------------------------------------------------------------------
    // Send — optimistic bubble, then swap in the persisted id
    // ------------------------------------------------------------------

    async function handleAdminSend() {
      const body = input.value.trim();
      if (!body || sending) return;

      sending = true;
      input.value = '';
      input.style.height = 'auto';
      sendBtn.disabled = true;

      const tempId = 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      const optimistic = {
        id: tempId,
        session_id: sessionId,
        sender_id: getUser()?.id,
        sender_type: 'admin',
        body,
        created_at: new Date().toISOString(),
      };
      addMessage(optimistic);
      appendMsg(msgContainer, optimistic);
      scrollToBottom(msgContainer);

      const removeOptimistic = () => {
        seenIds.delete(tempId);
        messages = messages.filter((m) => m.id !== tempId);
        const el = msgContainer.querySelector(`[data-msg-id="${tempId}"]`);
        if (el) el.remove();
      };

      try {
        const { data: msgId, error: sendErr } = await supabase.rpc('support_send_chat_message', {
          p_session_id: sessionId,
          p_body: body,
        });
        if (convDestroyed) return;
        if (sendErr || !msgId) {
          removeOptimistic();
          input.value = body;
          sendBtn.disabled = false;
          return;
        }
        // Swap temp id → persisted id so the Realtime INSERT dedups
        seenIds.delete(tempId);
        seenIds.add(msgId);
        const m = messages.find((x) => x.id === tempId);
        if (m) m.id = msgId;
        const el = msgContainer.querySelector(`[data-msg-id="${tempId}"]`);
        if (el) el.dataset.msgId = msgId;
      } catch {
        if (convDestroyed) return;
        removeOptimistic();
        input.value = body;
        sendBtn.disabled = false;
      } finally {
        sending = false;
        sendBtn.disabled = !input.value.trim();
      }
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  function appendMsg(container, msg) {
    // Clear empty-state placeholder if present (first message arriving)
    const emptyState = container.querySelector('[data-empty-state]');
    if (emptyState) emptyState.remove();

    const isAdmin = msg.sender_type === 'admin';
    const time = formatTime(msg.created_at);

    const bubble = document.createElement('div');
    bubble.className = `flex ${isAdmin ? 'justify-end' : 'justify-start'}`;
    if (msg.id) bubble.dataset.msgId = msg.id;
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
