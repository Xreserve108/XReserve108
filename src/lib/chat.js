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
//
// Message integrity rules (enforced with the chat pages):
//   - The database is the source of truth.
//   - Every persisted message carries a stable UUID from the DB.
//   - All render paths deduplicate by message id.
//   - Exactly ONE message + ONE status subscription per open conversation.
//   - Channel names are unique per subscription instance, so re-opening a
//     chat never collides with a stale channel still present in the client.
// =============================================================================

let activeChat = null;       // { session_id, status, unread_count }
let realtimeCleanup = null;  // cleanup function for current Realtime subs
let pollTimer = null;
let iconEl = null;
let unreadCount = 0;
let chatFocused = false;
let visibilityHandler = null;
let channelSeq = 0;          // monotonic suffix → unique channel names
let chatHeartbeatTimer = null; // global session-presence heartbeat (60s)

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
  syncChatHeartbeat();
}

export function clearActiveChat() {
  activeChat = null;
  unreadCount = 0;
  updateIcon();
  syncChatHeartbeat();
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
  }
  updateIcon();
}

// Hide the floating button while the user is inside the chat page itself
// (it would be redundant there). Called by the router on every navigation.
export function notifyRouteChange(routeName) {
  updateIcon(routeName);
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
    'ring-1 ring-black/[0.06] dark:ring-white/[0.1]',
    'transition-all duration-200',
    'hover:scale-105 active:scale-95',
    'cursor-pointer',
    // Above the floating bottom nav (nav: mb-4 + card height ≈ 84px) + gap
    'bottom-28 right-4 md:bottom-8 md:right-8',
  ].join(' ');
  iconEl.setAttribute('aria-label', 'Return to active support chat');
  iconEl.innerHTML = `
    <svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path fill-rule="evenodd" d="M4.848 2.771A49.144 49.144 0 0112 2.25c2.43 0 4.817.178 7.152.52 1.978.292 3.348 2.024 3.348 3.97v6.02c0 1.946-1.37 3.678-3.348 3.97a48.901 48.901 0 01-3.476.383.39.39 0 00-.297.17l-2.755 4.133a.75.75 0 01-1.248 0l-2.755-4.133a.39.39 0 00-.297-.17 48.9 48.9 0 01-3.476-.384c-1.978-.29-3.348-2.024-3.348-3.97V6.741c0-1.946 1.37-3.678 3.348-3.97z" clip-rule="evenodd"/>
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

function updateIcon(routeName = getCurrentRoute()) {
  const icon = ensureIcon();
  const badge = icon.querySelector('#floating-chat-badge');

  const onChatPage = routeName === 'live-chat';
  if (activeChat && activeChat.status === 'ACTIVE' && !onChatPage) {
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
    syncChatHeartbeat();
  } catch {
    // Silent
  }
}

// -----------------------------------------------------------------------------
// Realtime subscriptions
// -----------------------------------------------------------------------------

// Creates exactly one message + one status subscription for the conversation.
// Any previous subscription is torn down first. Channel names carry a unique
// sequence suffix: supabase.channel() with a reused name returns a NEW
// unjoined instance while the old one keeps receiving events, which is the
// defect that made reopened conversations appear dead/empty.
export function subscribeToChat(sessionId, { onMessage, onStatus } = {}) {
  unsubscribeFromChat();

  // Cache the authenticated user ID for the duration of this subscription
  // so we can correctly identify own messages without calling getSession()
  // (which returns a Promise) inside the synchronous Realtime handler.
  const myUserId = getUser()?.id || null;
  const seq = ++channelSeq;

  const statusChannel = supabase
    .channel(`chat-status-${sessionId}-${seq}`)
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'support_chat_sessions', filter: `id=eq.${sessionId}` },
      (payload) => {
        const newStatus = payload.new?.status;
        if (newStatus === 'ENDED' || newStatus === 'ABANDONED') {
          activeChat = null;
          unreadCount = 0;
          updateIcon();
        }
        if (onStatus) {
          onStatus({ sessionId, status: newStatus });
        } else {
          window.dispatchEvent(new CustomEvent('xreserve:chat-status', {
            detail: { sessionId, status: newStatus },
          }));
        }
      }
    )
    .subscribe();

  const msgChannel = supabase
    .channel(`chat-msgs-${sessionId}-${seq}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'support_chat_messages', filter: `session_id=eq.${sessionId}` },
      (payload) => {
        const msg = payload.new;
        if (onMessage) {
          onMessage(msg);
        } else {
          window.dispatchEvent(new CustomEvent('xreserve:chat-message', {
            detail: msg,
          }));
        }
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
  stopChatHeartbeat();
  if (iconEl) {
    iconEl.style.display = 'none';
  }
}

// -----------------------------------------------------------------------------
// Global session-presence heartbeat
// -----------------------------------------------------------------------------
// Fires support_chat_heartbeat() every 60 s while an ACTIVE chat exists.
// Tied to the authenticated application session — NOT to the chat page mount.
// Survives navigation across all pages; stops only when the chat ends, the
// user signs out, or no ACTIVE chat remains.
// -----------------------------------------------------------------------------

/** Start / stop the heartbeat based on whether an ACTIVE chat exists. */
export function syncChatHeartbeat() {
  if (activeChat && activeChat.status === 'ACTIVE') {
    startChatHeartbeat();
  } else {
    stopChatHeartbeat();
  }
}

export function startChatHeartbeat() {
  if (chatHeartbeatTimer !== null) return; // already running
  // Fire immediately so the DB knows we're present right away
  supabase.rpc('support_chat_heartbeat').then(undefined, () => {});
  chatHeartbeatTimer = setInterval(() => {
    supabase.rpc('support_chat_heartbeat').then(undefined, () => {});
  }, 60000);
}

export function stopChatHeartbeat() {
  if (chatHeartbeatTimer !== null) {
    clearInterval(chatHeartbeatTimer);
    chatHeartbeatTimer = null;
  }
}
