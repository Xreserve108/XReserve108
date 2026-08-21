import { supabase } from '@/lib/supabase';
import { isAuthenticated, getUser } from '@/core/auth';
import { navigate, getCurrentRoute } from '@/core/router';

// =============================================================================
// Live Chat — shared state, floating icon, Realtime subscriptions
// =============================================================================
// Single module managing:
//   - Active chat detection (polling for authenticated users)
//   - Floating chat icon lifecycle (create/show/hide/unread badge)
//   - Realtime subscriptions for live message delivery
//   - Focus tracking (suppress unread badge while viewing chat)
// =============================================================================

let activeChat = null;       // { session_id, status, unread_count }
let realtimeCleanup = null;  // cleanup function for current Realtime subs
let pollTimer = null;
let iconEl = null;
let unreadCount = 0;
let chatFocused = false;
let visibilityHandler = null;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export function getActiveChat() {
  return activeChat;
}

export function setActiveChatData(data) {
  activeChat = data;
  unreadCount = data?.unread_count || 0;
  updateIcon();
}

export function clearActiveChat() {
  activeChat = null;
  unreadCount = 0;
  updateIcon();
}

export function incrementUnread() {
  if (!chatFocused) {
    unreadCount++;
    updateIcon();
  }
}

export function setChatFocused(focused) {
  chatFocused = focused;
  if (focused) {
    unreadCount = 0;
    updateIcon();
  }
}

// -----------------------------------------------------------------------------
// Floating icon management
// -----------------------------------------------------------------------------

function ensureIcon() {
  if (iconEl) return iconEl;
  iconEl = document.createElement('button');
  iconEl.id = 'floating-chat-icon';
  iconEl.className = [
    'fixed z-[60] flex items-center justify-center',
    'h-12 w-12 rounded-full',
    'bg-action text-white',
    'dark:bg-action-dark dark:text-background-dark',
    'shadow-elevated dark:shadow-elevated-dark',
    'transition-all duration-200',
    'hover:scale-105 active:scale-95',
    'cursor-pointer',
    // Position: above bottom nav, right side
    'bottom-24 md:bottom-8 right-5',
  ].join(' ');
  iconEl.setAttribute('aria-label', 'Return to active support chat');
  iconEl.innerHTML = `
    <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.068.157 2.148.279 3.238.36a37.5 37.5 0 003.604 0c1.09-.081 2.17-.203 3.238-.36C16.623 15.754 17.75 14.36 17.75 12.76v-.012a3.019 3.019 0 00-.783-2.052A14.47 14.47 0 0012.82 7.12a.75.75 0 00-.64 0 14.47 14.47 0 00-4.147 3.588A3.019 3.019 0 007.25 12.75v.012z"/>
    </svg>
    <span id="floating-chat-badge" class="hidden absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">0</span>
  `;
  iconEl.addEventListener('click', () => {
    if (activeChat) navigate('live-chat');
  });
  iconEl.style.display = 'none';
  document.body.appendChild(iconEl);
  return iconEl;
}

function updateIcon() {
  const icon = ensureIcon();
  const badge = icon.querySelector('#floating-chat-badge');

  if (activeChat && activeChat.status === 'ACTIVE') {
    icon.style.display = 'flex';
    if (unreadCount > 0) {
      badge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  } else {
    icon.style.display = 'none';
  }
}

// -----------------------------------------------------------------------------
// Active chat polling
// -----------------------------------------------------------------------------

async function checkActiveChat() {
  if (!isAuthenticated()) {
    activeChat = null;
    updateIcon();
    return;
  }
  try {
    const { data, error } = await supabase.rpc('support_get_user_active_chat');
    if (error) return;
    if (data && data.length > 0) {
      const row = data[0];
      activeChat = {
        session_id: row.session_id,
        status: row.status,
        unread_count: row.unread_count || 0,
      };
      unreadCount = activeChat.unread_count;
    } else {
      activeChat = null;
      unreadCount = 0;
    }
    updateIcon();
  } catch {
    // Silent
  }
}

// -----------------------------------------------------------------------------
// Realtime subscriptions
// -----------------------------------------------------------------------------

export function subscribeToChat(sessionId) {
  unsubscribeFromChat();

  // Cache the authenticated user ID for the duration of this subscription
  // so we can correctly identify own messages without calling getSession()
  // (which returns a Promise) inside the synchronous Realtime handler.
  const myUserId = getUser()?.id || null;

  const statusChannel = supabase
    .channel(`chat-status-${sessionId}`)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'support_chat_sessions', filter: `id=eq.${sessionId}` },
      (payload) => {
        const newStatus = payload.new?.status;
        if (newStatus === 'ENDED' || newStatus === 'ABANDONED') {
          activeChat = null;
          unreadCount = 0;
          updateIcon();
        }
        // Dispatch custom event for chat pages to handle
        window.dispatchEvent(new CustomEvent('xreserve:chat-status', {
          detail: { sessionId, status: newStatus },
        }));
      }
    )
    .subscribe();

  const msgChannel = supabase
    .channel(`chat-msgs-${sessionId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'support_chat_messages', filter: `session_id=eq.${sessionId}` },
      (payload) => {
        const msg = payload.new;
        // Dispatch for chat page to render
        window.dispatchEvent(new CustomEvent('xreserve:chat-message', {
          detail: msg,
        }));
        // Update unread if not focused AND message is from the other party
        if (!chatFocused && myUserId && msg.sender_id !== myUserId) {
          incrementUnread();
        }
      }
    )
    .subscribe();

  realtimeCleanup = () => {
    supabase.removeChannel(statusChannel);
    supabase.removeChannel(msgChannel);
    realtimeCleanup = null;
  };
}

export function unsubscribeFromChat() {
  if (realtimeCleanup) {
    realtimeCleanup();
    realtimeCleanup = null;
  }
}

// -----------------------------------------------------------------------------
// Start / Stop
// -----------------------------------------------------------------------------

export function startChatPolling() {
  if (pollTimer !== null) return;
  checkActiveChat();
  pollTimer = setInterval(checkActiveChat, 20000);

  visibilityHandler = () => {
    if (!document.hidden) checkActiveChat();
  };
  document.addEventListener('visibilitychange', visibilityHandler);
}

export function stopChatPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  unsubscribeFromChat();
  if (iconEl) {
    iconEl.style.display = 'none';
  }
}
