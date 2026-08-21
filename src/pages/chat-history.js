import { supabase } from '@/lib/supabase';
import { isAuthenticated, getUser } from '@/core/auth';
import { navigate } from '@/core/router';

export function renderChatHistory() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  if (!isAuthenticated()) {
    navigate('signin');
    return page;
  }

  page.innerHTML = `
    <div class="flex items-center gap-3 mb-6">
      <button id="history-back" class="flex h-9 w-9 items-center justify-center rounded-xl text-text-secondary hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06] transition-colors">
        <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
      </button>
      <div>
        <h1 class="page-title">Chat History</h1>
        <p class="text-muted mt-0.5">Your past support conversations</p>
      </div>
    </div>
    <div id="history-list" class="flex flex-col gap-3">
      <div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>
    </div>
  `;

  page.querySelector('#history-back').addEventListener('click', () => navigate('help-support'));

  loadHistory(page);
  return page;
}

async function loadHistory(page) {
  const container = page.querySelector('#history-list');

  const { data, error } = await supabase.rpc('support_get_user_chat_history');

  if (error) {
    container.innerHTML = `
      <div class="card p-6 text-center">
        <p class="text-[14px] text-red-600 dark:text-red-400">Failed to load chat history</p>
      </div>
    `;
    return;
  }

  // Only show ended chats (active/waiting handled elsewhere)
  const endedChats = (data || []).filter(c => c.status === 'ENDED' || c.status === 'ABANDONED');

  if (endedChats.length === 0) {
    container.innerHTML = `
      <div class="card flex flex-col items-center py-16 text-center">
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06] mb-3">
          <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        </div>
        <p class="text-[14px] font-medium text-text-primary dark:text-text-primary-dark">No chat history</p>
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mt-1">Past support conversations will appear here</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  endedChats.forEach((chat) => container.appendChild(createChatCard(chat)));
}

function createChatCard(chat) {
  const card = document.createElement('button');
  card.className = 'card card-interactive flex flex-col p-4 text-left transition-colors';

  const date = formatDate(chat.created_at);
  const duration = chat.connected_at && chat.ended_at
    ? formatDuration(chat.connected_at, chat.ended_at)
    : '—';
  const msgCount = chat.message_count || 0;
  const statusLabel = chat.status === 'ENDED' ? 'Ended' : 'Abandoned';
  const statusColor = chat.status === 'ENDED'
    ? 'bg-text-secondary/10 text-text-secondary dark:bg-text-secondary-dark/10 dark:text-text-secondary-dark'
    : 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400';

  card.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <span class="text-[13px] font-semibold text-text-primary dark:text-text-primary-dark">Support Chat</span>
      <span class="rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColor}">${statusLabel}</span>
    </div>
    <div class="flex items-center gap-4 text-[12px] text-text-secondary dark:text-text-secondary-dark">
      <span>${date}</span>
      <span>${duration}</span>
      <span>${msgCount} message${msgCount !== 1 ? 's' : ''}</span>
    </div>
  `;

  card.addEventListener('click', () => openChatDetail(chat));
  return card;
}

async function openChatDetail(chat) {
  // Create a full-screen overlay with the chat conversation
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[80] flex flex-col bg-background dark:bg-background-dark';

  overlay.innerHTML = `
    <div class="flex items-center gap-3 px-5 py-4 border-b border-border-light dark:border-border-dark">
      <button class="flex h-9 w-9 items-center justify-center rounded-xl text-text-secondary hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06] transition-colors" id="detail-close">
        <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
      </button>
      <div class="flex-1 min-w-0">
        <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">Support Chat</p>
        <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">${formatDate(chat.created_at)} · ${chat.message_count || 0} messages</p>
      </div>
    </div>
    <div id="detail-messages" class="flex-1 overflow-y-auto px-5 py-4 space-y-3">
      <div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector('#detail-close').addEventListener('click', () => overlay.remove());

  // Load messages
  const { data: msgs, error } = await supabase.rpc('support_get_chat_history', {
    p_session_id: chat.session_id,
    p_limit: 200,
    p_offset: 0,
  });

  const msgContainer = overlay.querySelector('#detail-messages');
  if (error || !msgs) {
    msgContainer.innerHTML = '<p class="text-center text-[13px] text-text-secondary dark:text-text-secondary-dark py-8">Unable to load messages</p>';
    return;
  }

  msgContainer.innerHTML = '';
  const userId = getUser()?.id;

  msgs.forEach((msg) => {
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
    msgContainer.appendChild(bubble);
  });

  // Scroll to bottom
  requestAnimationFrame(() => {
    msgContainer.scrollTop = msgContainer.scrollHeight;
  });
}

// =============================================================================
// Helpers
// =============================================================================

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch {
    return '';
  }
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatDuration(start, end) {
  try {
    const ms = new Date(end) - new Date(start);
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return '<1 min';
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    const remMin = mins % 60;
    return `${hrs}h ${remMin}m`;
  } catch {
    return '—';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
