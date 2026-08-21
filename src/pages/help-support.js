import { supabase } from '@/lib/supabase';
import { isAuthenticated, getUser, getDisplayUsername } from '@/core/auth';
import { navigate } from '@/core/router';
import { getActiveChat, startChatPolling } from '@/lib/chat';

const chatIcon = `<svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.068.157 2.148.279 3.238.36a37.5 37.5 0 003.604 0c1.09-.081 2.17-.203 3.238-.36C16.623 15.754 17.75 14.36 17.75 12.76v-.012a3.019 3.019 0 00-.783-2.052A14.47 14.47 0 0012.82 7.12a.75.75 0 00-.64 0 14.47 14.47 0 00-4.147 3.588A3.019 3.019 0 007.25 12.75v.012z"/></svg>`;
const historyIcon = `<svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
const ticketIcon = `<svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h7.5"/></svg>`;

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
        <div class="mb-3 flex items-center gap-2">
          <span class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">SUPPORT TICKETS</span>
        </div>
        <div id="hs-tickets-content" class="flex flex-col gap-3">
          <div class="flex items-center justify-center py-8"><div class="auth-spinner"></div></div>
        </div>
      </section>
    </div>
  `;

  loadAvailability(page);
  loadTicketSummary(page);
  return page;
}

async function loadAvailability(page) {
  const container = page.querySelector('#hs-chat-content');
  const activeChat = getActiveChat();

  // If user already has an active chat, show return option
  if (activeChat && activeChat.status === 'ACTIVE') {
    renderActiveChatCard(container);
    renderHistoryLink(container);
    return;
  }

  // If user has a waiting chat, show queue status
  if (activeChat && activeChat.status === 'WAITING') {
    renderQueueCard(container, activeChat);
    renderHistoryLink(container);
    return;
  }

  // Fetch availability
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
// Ticket summary section
// =============================================================================

async function loadTicketSummary(page) {
  const section = page.querySelector('#hs-tickets-section');
  const container = page.querySelector('#hs-tickets-content');

  section.classList.remove('hidden');

  const { data, error } = await supabase.rpc('support_get_user_ticket_summary');

  if (error) {
    container.innerHTML = `
      <div class="card p-5 text-center">
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Unable to load ticket summary</p>
      </div>
    `;
    return;
  }

  const summary = data?.[0] || { open_count: 0, waiting_count: 0, resolved_count: 0 };

  container.innerHTML = `
    <div class="card p-5">
      <div class="flex items-center gap-2 mb-4">
        <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 dark:bg-blue-500/15">
          <svg class="h-4 w-4 text-blue-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h7.5"/></svg>
        </span>
        <span class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">Your Tickets</span>
      </div>

      <div class="grid grid-cols-3 gap-3 mb-5">
        <div class="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2.5 text-center">
          <p class="text-[18px] font-bold text-text-primary dark:text-text-primary-dark">${summary.open_count || 0}</p>
          <p class="text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark">Open</p>
        </div>
        <div class="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2.5 text-center">
          <p class="text-[18px] font-bold text-yellow-500">${summary.waiting_count || 0}</p>
          <p class="text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark">Waiting</p>
        </div>
        <div class="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-3 py-2.5 text-center">
          <p class="text-[18px] font-bold text-green-500">${summary.resolved_count || 0}</p>
          <p class="text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark">Resolved</p>
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <button id="hs-view-tickets" class="btn-secondary w-full py-2.5 text-[13px] font-medium rounded-xl">
          View My Tickets
        </button>
        <button id="hs-create-ticket" class="btn-primary w-full py-2.5 text-[13px] font-medium rounded-xl">
          Create Ticket
        </button>
      </div>
    </div>
  `;

  container.querySelector('#hs-view-tickets').addEventListener('click', () => navigate('my-tickets'));
  container.querySelector('#hs-create-ticket').addEventListener('click', () => navigate('create-ticket'));
}
