import { supabase } from '@/lib/supabase';
import { isAuthenticated, getUser } from '@/core/auth';
import { navigate } from '@/core/router';
import {
  getActiveChat, setActiveChatData, clearActiveChat,
  subscribeToChat, unsubscribeFromChat, setChatFocused,
  startChatPolling, syncChatHeartbeat,
} from '@/lib/chat';

// =============================================================================
// User Live Chat page
// =============================================================================
// Layout: deliberate flex-column chat shell (header / messages / composer).
//   - The shell is position:fixed on mobile so the composer is always pinned
//     above the bottom navigation + device safe area, regardless of page
//     scroll or animated backgrounds. On md+ (no bottom nav) it becomes a
//     normal in-flow flex column filling the viewport.
// Message integrity:
//   - DB is the source of truth; every persisted message has a stable UUID.
//   - Sending: optimistic bubble (temp id) -> RPC -> swap in persisted id.
//     Realtime then delivers the same id and is skipped by the dedup set.
//   - Every append path (history / RPC / Realtime) checks seenIds first.
//   - Exactly one Realtime subscription; torn down on unmount.
// =============================================================================

export function renderLiveChat() {
  const page = document.createElement('main');
  page.className = 'page-enter flex flex-1 flex-col min-h-0';

  if (!isAuthenticated()) {
    navigate('signin');
    return page;
  }

  startChatPolling();

  // State
  let sessionId = null;
  let chatStatus = null;
  let messages = [];
  const seenIds = new Set();
  let sending = false;
  let queueInterval = null;
  let destroyed = false;

  page.innerHTML = `
    <div id="chat-shell" class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border-light bg-surface-light md:border-border-light md:bg-surface-light dark:border-border-dark dark:bg-surface-dark">
      <div class="flex flex-shrink-0 items-center gap-2 border-b border-border-light bg-surface-light/90 px-3 py-2.5 backdrop-blur-xl dark:border-border-dark dark:bg-surface-dark/90 md:px-4">
        <button id="chat-back" aria-label="Back to Help and Support" class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
        </button>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">Live Support</h1>
          <p id="chat-status-text" class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Connecting...</p>
        </div>
        <button id="chat-end-btn" class="flex-shrink-0 rounded-lg px-3 py-1.5 text-[12px] font-medium text-red-500 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/10">End Chat</button>
      </div>
      <div id="chat-body" class="flex min-h-0 flex-1 flex-col">
        <div class="flex flex-1 items-center justify-center py-12"><div class="auth-spinner"></div></div>
      </div>
    </div>
  `;

  page.querySelector('#chat-back').addEventListener('click', () => navigate('help-support'));

  // Teardown when the page element leaves the DOM (navigation away):
  // remove the Realtime subscription and timers. Messages stay in the DB.
  const pageObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.removedNodes) {
        if (n === page) {
          destroyed = true;
          if (queueInterval) clearInterval(queueInterval);
          unsubscribeFromChat();
          setChatFocused(false);
          pageObserver.disconnect();
          return;
        }
      }
    }
  });
  pageObserver.observe(document.body, { childList: true, subtree: true });

  // Initialize
  initChat();

  return page;

  // ===========================================================================
  // Init — resolve the actual session, then load persisted history
  // ===========================================================================

  async function initChat() {
    const active = getActiveChat();

    if (active && (active.status === 'ACTIVE' || active.status === 'WAITING')) {
      sessionId = active.session_id;
      chatStatus = active.status;
      if (chatStatus === 'ACTIVE') {
        await loadAndRenderActive();
      } else {
        renderQueue();
      }
    } else {
      // No cached session — ask the DB (returns an existing session if one
      // is already ACTIVE/WAITING, otherwise creates one).
      const { data, error } = await supabase.rpc('support_start_live_chat');
      if (destroyed) return;
      if (error || !data || data.length === 0) {
        renderError('Unable to start chat. Please try again.');
        return;
      }
      const row = data[0];
      sessionId = row.session_id;
      chatStatus = row.status;
      setActiveChatData({ session_id: sessionId, status: chatStatus, unread_count: 0 });

      if (chatStatus === 'ACTIVE') {
        await loadAndRenderActive();
      } else {
        renderQueue();
      }
    }
  }

  // ===========================================================================
  // Load persisted messages & render active chat
  // ===========================================================================

  async function loadAndRenderActive() {
    setChatFocused(true);
    updateStatusText('Connected to Support', 'green');

    // Persisted history is the source of truth — never JS memory
    const { data: msgs, error } = await supabase.rpc('support_get_chat_history', {
      p_session_id: sessionId,
      p_limit: 100,
      p_offset: 0,
    });
    if (destroyed) return;

    if (error) {
      console.error('[live-chat] support_get_chat_history FAILED', {
        session_id: sessionId,
        error_message: error.message,
        error_details: error.details,
        error_hint: error.hint,
        error_code: error.code,
      });
      renderError(`Unable to load conversation: ${error.message || 'unknown error'}. Please try again.`);
      return;
    }

    messages = msgs || [];
    seenIds.clear();
    messages.forEach((m) => seenIds.add(m.id));

    renderChatUI();

    // Show empty-state hint if no messages yet
    if (messages.length === 0) {
      const msgContainer = page.querySelector('#chat-messages');
      if (msgContainer) {
        msgContainer.innerHTML = `
          <div data-empty-state class="py-8 text-center">
            <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">No messages yet — say hello!</p>
          </div>
        `;
      }
    }

    scrollToBottom();

    // Mark as read
    supabase.rpc('support_mark_chat_read', { p_session_id: sessionId });

    // Exactly one Realtime subscription with direct callbacks (no global
    // window listeners to leak across page mounts).
    subscribeToChat(sessionId, {
      onMessage: handleRealtimeMessage,
      onStatus: handleRealtimeStatus,
    });
  }

  function handleRealtimeMessage(msg) {
    if (destroyed || msg.session_id !== sessionId) return;
    if (!addMessage(msg)) return; // duplicate id → skip
    appendMessage(msg);
    scrollToBottom();
    if (msg.sender_id !== getUser()?.id) {
      supabase.rpc('support_mark_chat_read', { p_session_id: sessionId });
    }
  }

  function handleRealtimeStatus({ sessionId: sid, status }) {
    if (destroyed || sid !== sessionId) return;
    if (status === 'ENDED' || status === 'ABANDONED') {
      chatStatus = 'ENDED';
      renderEnded();
    }
  }

  // ===========================================================================
  // Message state — every path funnels through addMessage (id dedup)
  // ===========================================================================

  function addMessage(msg) {
    if (!msg || !msg.id || seenIds.has(msg.id)) return false;
    seenIds.add(msg.id);
    messages.push(msg);
    return true;
  }

  // ===========================================================================
  // Render chat UI (flex column: messages flex-1, composer pinned bottom)
  // ===========================================================================

  function renderChatUI() {
    const body = page.querySelector('#chat-body');
    body.innerHTML = `
      <div id="chat-messages" class="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 md:px-6" role="log" aria-label="Chat messages"></div>
      <div id="chat-input-area" class="flex-shrink-0 border-t border-border-light bg-surface-light px-3 pt-2.5 pb-2 dark:border-border-dark dark:bg-surface-dark md:px-4">
        <div class="flex items-end gap-2">
          <textarea id="chat-input" rows="1" placeholder="Type your message..." aria-label="Message" class="input-field max-h-[120px] min-w-0 flex-1 resize-none py-2.5 text-[14px] leading-relaxed" maxlength="4000"></textarea>
          <button id="chat-send" aria-label="Send message" class="flex h-[42px] w-[42px] flex-shrink-0 items-center justify-center rounded-xl bg-action text-white transition-all hover:opacity-90 disabled:opacity-40 dark:bg-action-dark dark:text-background-dark" disabled>
            <svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>
          </button>
        </div>
      </div>
    `;

    const msgContainer = body.querySelector('#chat-messages');
    messages.forEach((m) => appendMessageTo(msgContainer, m));

    // Input handling
    const input = body.querySelector('#chat-input');
    const sendBtn = body.querySelector('#chat-send');

    input.addEventListener('input', () => {
      sendBtn.disabled = !input.value.trim() || sending;
      // Auto-resize
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (input.value.trim() && !sending) handleSend();
      }
    });

    sendBtn.addEventListener('click', () => {
      if (input.value.trim() && !sending) handleSend();
    });

    // End chat (button is in the header)
    page.querySelector('#chat-end-btn').addEventListener('click', handleEndChat);
  }

  function appendMessage(msg) {
    const container = page.querySelector('#chat-messages');
    if (container) appendMessageTo(container, msg);
  }

  function appendMessageTo(container, msg) {
    // Clear empty-state placeholder if present
    const emptyState = container.querySelector('[data-empty-state]');
    if (emptyState) emptyState.remove();

    const userId = getUser()?.id;
    const isUser = msg.sender_id === userId;
    const time = formatTime(msg.created_at);

    const bubble = document.createElement('div');
    bubble.className = `flex ${isUser ? 'justify-end' : 'justify-start'}`;
    if (msg.id) bubble.dataset.msgId = msg.id;
    bubble.innerHTML = `
      <div class="max-w-[80%] ${isUser
        ? 'rounded-2xl rounded-br-md bg-action px-3.5 py-2.5 text-white dark:bg-action-dark dark:text-background-dark'
        : 'rounded-2xl rounded-bl-md bg-black/[0.04] px-3.5 py-2.5 text-text-primary dark:bg-white/[0.08] dark:text-text-primary-dark'
      }">
        <p class="text-[14px] leading-relaxed break-words whitespace-pre-wrap">${escapeHtml(msg.body)}</p>
        <p class="mt-1 text-[10px] ${isUser ? 'text-white/60 dark:text-background-dark/50' : 'text-text-secondary/60 dark:text-text-secondary-dark/60'}">${time}</p>
      </div>
    `;
    container.appendChild(bubble);
  }

  function scrollToBottom() {
    const container = page.querySelector('#chat-messages');
    if (container) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  }

  // ===========================================================================
  // Queue view
  // ===========================================================================

  function renderQueue() {
    updateStatusText('Waiting for an agent...', 'yellow');
    const body = page.querySelector('#chat-body');
    body.innerHTML = `
      <div class="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <div class="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-yellow-500/10">
          <svg class="h-7 w-7 text-yellow-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        </div>
        <p class="mb-1 text-[16px] font-semibold text-text-primary dark:text-text-primary-dark">Waiting for an agent</p>
        <p id="queue-position-text" class="mb-6 text-[14px] text-text-secondary dark:text-text-secondary-dark">Checking position...</p>
        <div class="auth-spinner"></div>
      </div>
    `;

    // Poll queue position / promotion to ACTIVE
    updateQueuePosition();
    if (queueInterval) clearInterval(queueInterval);
    queueInterval = setInterval(async () => {
      if (destroyed || chatStatus !== 'WAITING' || !page.isConnected) {
        clearInterval(queueInterval);
        queueInterval = null;
        return;
      }
      const { data } = await supabase.rpc('support_get_user_active_chat');
      if (destroyed) return;
      if (data && data.length > 0 && data[0].status === 'ACTIVE') {
        clearInterval(queueInterval);
        queueInterval = null;
        chatStatus = 'ACTIVE';
        sessionId = data[0].session_id;
        setActiveChatData({ session_id: sessionId, status: 'ACTIVE', unread_count: 0 });
        // syncChatHeartbeat is called inside setActiveChatData
        await loadAndRenderActive();
        return;
      }
      updateQueuePosition();
    }, 5000);
  }

  async function updateQueuePosition() {
    const { data: pos } = await supabase.rpc('support_get_user_queue_position', {
      p_session_id: sessionId,
    });
    if (destroyed) return;
    const el = page.querySelector('#queue-position-text');
    if (el && pos != null) {
      el.textContent = `Your position: ${pos}`;
    }
  }

  // ===========================================================================
  // Ended view — once the session ends, everything about the chat is cleared:
  // local messages, subscription, active-chat state (the server purges the
  // persisted session + messages in the same transaction).
  // ===========================================================================

  function renderEnded() {
    setChatFocused(false);
    unsubscribeFromChat();
    clearActiveChat();
    // syncChatHeartbeat is called inside clearActiveChat → stops heartbeat

    // Wipe local conversation state — no history is kept after the session ends
    messages = [];
    seenIds.clear();
    sessionId = null;
    if (queueInterval) {
      clearInterval(queueInterval);
      queueInterval = null;
    }
    updateStatusText('Chat ended', 'gray');

    // Hide End Chat button — session is no longer active
    const endBtn = page.querySelector('#chat-end-btn');
    if (endBtn) endBtn.style.display = 'none';

    const body = page.querySelector('#chat-body');
    if (!body) return;
    body.innerHTML = `
      <div class="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <div class="card flex w-full max-w-sm flex-col items-center py-8">
          <div class="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
            <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </div>
          <p class="text-[14px] font-medium text-text-primary dark:text-text-primary-dark">Chat has ended</p>
          <p class="mb-5 mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">The conversation has been cleared. Thank you for contacting support.</p>
          <button id="ended-back-btn" class="btn-secondary px-6 py-2 text-[13px]">Back to Help & Support</button>
        </div>
      </div>
    `;
    body.querySelector('#ended-back-btn').addEventListener('click', () => navigate('help-support'));
  }

  function renderError(msg) {
    const body = page.querySelector('#chat-body');
    body.innerHTML = `
      <div class="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
        <p class="mb-4 text-[14px] text-red-600 dark:text-red-400">${escapeHtml(msg)}</p>
        <button id="chat-error-back" class="btn-secondary px-6 py-2 text-[13px]">Back</button>
      </div>
    `;
    body.querySelector('#chat-error-back').addEventListener('click', () => navigate('help-support'));
  }

  // ===========================================================================
  // Actions
  // ===========================================================================

  async function handleSend() {
    const input = page.querySelector('#chat-input');
    const sendBtn = page.querySelector('#chat-send');
    const body = input.value.trim();
    if (!body || sending) return;

    sending = true;
    input.value = '';
    input.style.height = 'auto';
    sendBtn.disabled = true;

    // Optimistic bubble with a TEMPORARY id — replaced by the persisted id
    // once the RPC returns. The Realtime event carries the persisted id and
    // is skipped by the dedup set, so the message renders exactly once.
    const tempId = 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const optimistic = {
      id: tempId,
      session_id: sessionId,
      sender_id: getUser()?.id,
      sender_type: 'user',
      body,
      created_at: new Date().toISOString(),
    };
    addMessage(optimistic);
    appendMessage(optimistic);
    scrollToBottom();

    const removeOptimistic = () => {
      seenIds.delete(tempId);
      messages = messages.filter((m) => m.id !== tempId);
      const el = page.querySelector(`[data-msg-id="${tempId}"]`);
      if (el) el.remove();
    };

    try {
      const { data: msgId, error } = await supabase.rpc('support_send_chat_message', {
        p_session_id: sessionId,
        p_body: body,
      });
      if (destroyed) return;
      if (error || !msgId) {
        removeOptimistic();
        input.value = body;
        sendBtn.disabled = false;
        return;
      }
      // Swap temp id → persisted id. Realtime INSERT with the same persisted
      // id is then recognized as already rendered.
      seenIds.delete(tempId);
      seenIds.add(msgId);
      const m = messages.find((x) => x.id === tempId);
      if (m) m.id = msgId;
      const el = page.querySelector(`[data-msg-id="${tempId}"]`);
      if (el) el.dataset.msgId = msgId;
    } catch {
      if (destroyed) return;
      removeOptimistic();
      input.value = body;
      sendBtn.disabled = false;
    } finally {
      sending = false;
      const inp = page.querySelector('#chat-input');
      const btn = page.querySelector('#chat-send');
      if (inp && btn) btn.disabled = !inp.value.trim();
    }
  }

  async function handleEndChat() {
    // Defensive guard: prevent second end-chat request after session already ended
    if (chatStatus === 'ENDED' || !sessionId) return;

    // Confirmation dialog
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="card w-full max-w-sm p-6 text-center">
        <div class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
          <svg class="h-6 w-6 text-red-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>
        </div>
        <p class="mb-1 text-[16px] font-semibold text-text-primary dark:text-text-primary-dark">End this chat?</p>
        <p class="mb-6 text-[13px] text-text-secondary dark:text-text-secondary-dark">You will be disconnected and the conversation is cleared once the session ends.</p>
        <div class="flex gap-3">
          <button id="end-cancel" class="btn-secondary flex-1 py-2.5 text-[13px]">Keep Chat</button>
          <button id="end-confirm" class="flex-1 rounded-xl bg-red-500 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-red-600 dark:bg-red-600 dark:hover:bg-red-700">End Chat</button>
        </div>
      </div>
    `;
    page.appendChild(overlay);

    overlay.querySelector('#end-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#end-confirm').addEventListener('click', async () => {
      overlay.remove();
      const { error } = await supabase.rpc('support_end_chat', { p_session_id: sessionId });
      if (destroyed) return;
      if (error) return; // keep chat open on failure
      chatStatus = 'ENDED';
      renderEnded();
    });
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  function updateStatusText(text, color) {
    const el = page.querySelector('#chat-status-text');
    if (!el) return;
    const colors = {
      green: 'text-green-500',
      yellow: 'text-yellow-500',
      gray: 'text-text-secondary dark:text-text-secondary-dark',
      red: 'text-red-500',
    };
    el.textContent = text;
    el.className = `text-[12px] ${colors[color] || colors.gray}`;
  }
}

// =============================================================================
// Shared helpers
// =============================================================================

function formatTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
