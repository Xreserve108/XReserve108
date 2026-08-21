import { supabase } from '@/lib/supabase';
import { isAuthenticated, getUser, getDisplayUsername } from '@/core/auth';
import { navigate } from '@/core/router';
import {
  getActiveChat, setActiveChatData, clearActiveChat,
  subscribeToChat, unsubscribeFromChat, setChatFocused,
  startChatPolling,
} from '@/lib/chat';

export function renderLiveChat() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-4 md:px-8 md:pb-8 lg:px-12';

  if (!isAuthenticated()) {
    navigate('signin');
    return page;
  }

  startChatPolling();

  // State
  let sessionId = null;
  let chatStatus = null;
  let messages = [];
  let sending = false;
  let connected = false;

  page.innerHTML = `
    <div class="flex items-center gap-3 mb-4">
      <button id="chat-back" class="flex h-9 w-9 items-center justify-center rounded-xl text-text-secondary hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06] transition-colors">
        <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
      </button>
      <div class="flex-1 min-w-0">
        <h1 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark truncate">Live Support</h1>
        <p id="chat-status-text" class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Connecting...</p>
      </div>
    </div>
    <div id="chat-body" class="flex-1 flex flex-col">
      <div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>
    </div>
  `;

  page.querySelector('#chat-back').addEventListener('click', () => navigate('help-support'));

  // Initialize
  initChat();

  return page;

  // ===========================================================================
  // Init
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
      // Try to start a new chat
      const { data, error } = await supabase.rpc('support_start_live_chat');
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
  // Load messages & render active chat
  // ===========================================================================

  async function loadAndRenderActive() {
    connected = true;
    setChatFocused(true);
    updateStatusText('Connected to Support', 'green');

    // Load message history
    const { data: msgs, error } = await supabase.rpc('support_get_chat_history', {
      p_session_id: sessionId,
      p_limit: 100,
      p_offset: 0,
    });

    if (!error && msgs) {
      messages = msgs;
    }

    // Mark as read
    await supabase.rpc('support_mark_chat_read', { p_session_id: sessionId });

    renderChatUI();
    subscribeToChat(sessionId);

    // Listen for realtime events
    window.addEventListener('xreserve:chat-message', handleNewMessage);
    window.addEventListener('xreserve:chat-status', handleStatusChange);
  }

  function handleNewMessage(e) {
    if (e.detail.session_id !== sessionId) return;
    messages.push(e.detail);
    appendMessage(e.detail);
    scrollToBottom();
    // Mark as read
    supabase.rpc('support_mark_chat_read', { p_session_id: sessionId });
  }

  function handleStatusChange(e) {
    if (e.detail.sessionId !== sessionId) return;
    if (e.detail.status === 'ENDED') {
      chatStatus = 'ENDED';
      renderEnded();
    }
  }

  // ===========================================================================
  // Render chat UI
  // ===========================================================================

  function renderChatUI() {
    const body = page.querySelector('#chat-body');
    body.innerHTML = `
      <div id="chat-messages" class="flex-1 overflow-y-auto px-1 py-4 space-y-3" style="min-height:0"></div>
      <div id="chat-input-area" class="mt-auto pt-3 pb-2">
        <div class="flex items-end gap-2">
          <textarea id="chat-input" rows="1" placeholder="Type your message..." class="input-field flex-1 resize-none py-2.5 text-[14px] leading-relaxed" maxlength="4000"></textarea>
          <button id="chat-send" class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-action text-white dark:bg-action-dark dark:text-background-dark transition-all hover:opacity-90 disabled:opacity-40" disabled>
            <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"/></svg>
          </button>
        </div>
        <div class="flex items-center justify-between mt-2">
          <button id="chat-end-btn" class="text-[12px] font-medium text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 transition-colors py-1">
            End Chat
          </button>
          <span id="chat-typing" class="text-[11px] text-text-secondary dark:text-text-secondary-dark"></span>
        </div>
      </div>
    `;

    const msgContainer = body.querySelector('#chat-messages');
    messages.forEach((m) => appendMessageTo(msgContainer, m));
    scrollToBottom();

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

    // End chat
    body.querySelector('#chat-end-btn').addEventListener('click', handleEndChat);
  }

  function appendMessage(msg) {
    const container = page.querySelector('#chat-messages');
    if (container) appendMessageTo(container, msg);
  }

  function appendMessageTo(container, msg) {
    const userId = getUser()?.id;
    const isUser = msg.sender_id === userId;
    const time = formatTime(msg.created_at);

    const bubble = document.createElement('div');
    bubble.className = `flex ${isUser ? 'justify-end' : 'justify-start'}`;
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
      <div class="flex-1 flex flex-col items-center justify-center text-center py-12">
        <div class="flex h-16 w-16 items-center justify-center rounded-full bg-yellow-500/10 mb-4">
          <svg class="h-7 w-7 text-yellow-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        </div>
        <p class="text-[16px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Waiting for an agent</p>
        <p id="queue-position-text" class="text-[14px] text-text-secondary dark:text-text-secondary-dark mb-6">Checking position...</p>
        <div class="auth-spinner"></div>
      </div>
    `;

    // Poll queue position
    updateQueuePosition();
    const queueInterval = setInterval(async () => {
      if (chatStatus !== 'WAITING' || !page.isConnected) {
        clearInterval(queueInterval);
        return;
      }
      // Check if chat became active
      const { data } = await supabase.rpc('support_get_user_active_chat');
      if (data && data.length > 0 && data[0].status === 'ACTIVE') {
        clearInterval(queueInterval);
        chatStatus = 'ACTIVE';
        sessionId = data[0].session_id;
        setActiveChatData({ session_id: sessionId, status: 'ACTIVE', unread_count: 0 });
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
    const el = page.querySelector('#queue-position-text');
    if (el && pos != null) {
      el.textContent = `Your position: ${pos}`;
    }
  }

  // ===========================================================================
  // Ended view
  // ===========================================================================

  function renderEnded() {
    setChatFocused(false);
    unsubscribeFromChat();
    clearActiveChat();
    updateStatusText('Chat ended', 'gray');

    const inputArea = page.querySelector('#chat-input-area');
    if (inputArea) {
      inputArea.innerHTML = `
        <div class="card flex flex-col items-center py-8 text-center">
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06] mb-3">
            <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          </div>
          <p class="text-[14px] font-medium text-text-primary dark:text-text-primary-dark">Chat has ended</p>
          <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mt-1 mb-4">Thank you for contacting support</p>
          <button id="ended-back-btn" class="btn-secondary px-6 py-2 text-[13px]">Back to Help & Support</button>
        </div>
      `;
      inputArea.querySelector('#ended-back-btn').addEventListener('click', () => navigate('help-support'));
    }
  }

  function renderError(msg) {
    const body = page.querySelector('#chat-body');
    body.innerHTML = `
      <div class="flex-1 flex flex-col items-center justify-center text-center py-12">
        <p class="text-[14px] text-red-600 dark:text-red-400 mb-4">${escapeHtml(msg)}</p>
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

    // Optimistic: show message immediately
    const userId = getUser()?.id;
    const optimistic = {
      id: 'pending-' + Date.now(),
      session_id: sessionId,
      sender_id: userId,
      sender_type: 'user',
      body,
      created_at: new Date().toISOString(),
    };
    appendMessage(optimistic);
    scrollToBottom();

    try {
      const { data: msgId, error } = await supabase.rpc('support_send_chat_message', {
        p_session_id: sessionId,
        p_body: body,
      });
      if (error) {
        // Remove optimistic message and show error
        const bubbles = page.querySelectorAll('#chat-messages > div:last-child');
        if (bubbles.length) bubbles[bubbles.length - 1].remove();
        input.value = body;
        sendBtn.disabled = false;
      }
    } catch {
      const bubbles = page.querySelectorAll('#chat-messages > div:last-child');
      if (bubbles.length) bubbles[bubbles.length - 1].remove();
      input.value = body;
      sendBtn.disabled = false;
    } finally {
      sending = false;
      sendBtn.disabled = !input.value.trim();
    }
  }

  async function handleEndChat() {
    // Show confirmation dialog
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4';
    overlay.innerHTML = `
      <div class="card w-full max-w-sm p-6 text-center">
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10 mx-auto mb-3">
          <svg class="h-6 w-6 text-red-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>
        </div>
        <p class="text-[16px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">End this chat?</p>
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-6">You will no longer be connected to the support agent.</p>
        <div class="flex gap-3">
          <button id="end-cancel" class="btn-secondary flex-1 py-2.5 text-[13px]">Keep Chat</button>
          <button id="end-confirm" class="flex-1 rounded-xl bg-red-500 py-2.5 text-[13px] font-medium text-white hover:bg-red-600 transition-colors dark:bg-red-600 dark:hover:bg-red-700">End Chat</button>
        </div>
      </div>
    `;
    page.appendChild(overlay);

    overlay.querySelector('#end-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#end-confirm').addEventListener('click', async () => {
      overlay.remove();
      await supabase.rpc('support_end_chat', { p_session_id: sessionId });
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
