import { supabase } from '@/lib/supabase';
import { isAuthenticated, getUser } from '@/core/auth';
import { navigate } from '@/core/router';
import { getDisplayUsername } from '@/core/auth';

// Clean, professional copy icon (two overlapping rectangles)
const copyIcon = `<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
// Check icon for copy feedback
const checkIcon = `<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>`;
// Gift icon for referral code card header
const giftIcon = `<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>`;
// Users icon for referrals card header
const usersIcon = `<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/></svg>`;
// Share icon
const shareIcon = `<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>`;

/**
 * Get the base URL for referral links.
 * Uses HTTPS in production, respects current origin in development.
 */
function getReferralBaseUrl() {
  const origin = window.location.origin;
  // Production: always use HTTPS
  if (origin.includes('railway.app') || origin.includes('xreserve')) {
    return 'https://xreserve.up.railway.app';
  }
  // Development: use current origin
  return origin;
}

export function renderReferrals() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  if (!isAuthenticated()) {
    navigate('signin');
    return page;
  }

  const displayName = getDisplayUsername() || 'User';

  page.innerHTML = `
    <button id="referrals-back-btn" class="mb-6 flex items-center gap-1.5 text-[14px] font-medium text-text-secondary dark:text-text-secondary-dark transition-colors hover:text-text-primary dark:hover:text-text-primary-dark">
      <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
      Back to Profile
    </button>

    <h1 class="page-title">Referrals</h1>
    <p class="text-muted mt-1 mb-8">Invite friends and track your referrals</p>

    <!-- Your Referral Code Card -->
    <div id="referral-code-card" class="card mb-6 p-5">
      <div class="flex items-center gap-2 mb-4">
        <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-action/[0.1] text-action dark:bg-action-dark/[0.15] dark:text-action-dark">
          ${giftIcon}
        </span>
        <h2 class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">Your Referral Code</h2>
      </div>
      
      <div id="referral-code-loading" class="flex items-center justify-center py-6">
        <div class="auth-spinner" style="width:24px;height:24px"></div>
      </div>

      <div id="referral-code-content" class="hidden">
        <div class="flex items-center gap-3 rounded-xl bg-black/[0.03] px-4 py-3.5 dark:bg-white/[0.06]">
          <span id="referral-code-text" class="flex-1 font-mono text-[20px] font-bold tracking-wider text-text-primary dark:text-text-primary-dark select-all"></span>
          <button id="copy-code-btn" class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-black/[0.06] hover:text-text-primary dark:hover:bg-white/[0.08] dark:text-text-secondary-dark dark:hover:text-text-primary-dark" title="Copy code">
            ${copyIcon}
          </button>
        </div>

        <div class="mt-4">
          <p class="text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark mb-2">Share your referral link</p>
          <div class="flex items-center gap-3 rounded-xl bg-black/[0.03] px-4 py-3 dark:bg-white/[0.06]">
            <span id="referral-link-text" class="flex-1 text-[13px] text-text-secondary dark:text-text-secondary-dark truncate select-all"></span>
            <button id="copy-link-btn" class="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-black/[0.06] hover:text-text-primary dark:hover:bg-white/[0.08] dark:text-text-secondary-dark dark:hover:text-text-primary-dark" title="Copy link">
              ${copyIcon}
            </button>
          </div>
        </div>

        <div class="mt-4 flex gap-2">
          <button id="share-link-btn" class="flex flex-1 items-center justify-center gap-2 rounded-xl bg-action px-4 py-3 text-[14px] font-medium text-white transition-opacity hover:opacity-90 dark:bg-action-dark dark:text-background-dark">
            ${shareIcon}
            <span>Share Link</span>
          </button>
        </div>
      </div>

      <div id="referral-code-error" class="hidden py-6 text-center">
        <p class="text-[14px] text-red-500 dark:text-red-400">Failed to load your referral code.</p>
        <button id="retry-code-btn" class="mt-3 text-[13px] font-medium text-action dark:text-action-dark underline">Try again</button>
      </div>
    </div>

    <!-- Referral Stats Card -->
    <div id="referral-stats-card" class="card mb-6 p-5">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-action/[0.1] text-action dark:bg-action-dark/[0.15] dark:text-action-dark">
            ${usersIcon}
          </span>
          <h2 class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">Your Referrals</h2>
        </div>
        <span id="referral-count" class="rounded-full bg-action/[0.1] px-3 py-1 text-[13px] font-semibold text-action dark:bg-action-dark/[0.15] dark:text-action-dark">0</span>
      </div>

      <div id="referral-stats-loading" class="flex items-center justify-center py-4">
        <div class="auth-spinner" style="width:20px;height:20px"></div>
      </div>

      <div id="referral-stats-content" class="hidden">
        <div id="referral-list" class="space-y-0"></div>
        <div id="referral-empty" class="hidden py-6 text-center">
          <p class="text-[14px] text-text-secondary dark:text-text-secondary-dark">You haven't referred anyone yet.</p>
          <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">Share your code to invite friends!</p>
        </div>
      </div>
    </div>

    <!-- How it works -->
    <div class="card p-5">
      <h2 class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark mb-3">How it works</h2>
      <div class="space-y-3">
        <div class="flex items-start gap-3">
          <span class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-action/[0.1] text-[12px] font-bold text-action dark:bg-action-dark/[0.15] dark:text-action-dark">1</span>
          <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Share your unique referral code with friends</p>
        </div>
        <div class="flex items-start gap-3">
          <span class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-action/[0.1] text-[12px] font-bold text-action dark:bg-action-dark/[0.15] dark:text-action-dark">2</span>
          <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Your friend enters the code when creating their account</p>
        </div>
        <div class="flex items-start gap-3">
          <span class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-action/[0.1] text-[12px] font-bold text-action dark:bg-action-dark/[0.15] dark:text-action-dark">3</span>
          <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">The referral is recorded and you can track it here</p>
        </div>
      </div>
    </div>
  `;

  // Back button
  page.querySelector('#referrals-back-btn').addEventListener('click', () => {
    navigate('profile');
  });

  // Load referral code
  loadReferralCode(page);

  // Load referral stats
  loadReferralStats(page);

  return page;
}

async function loadReferralCode(page) {
  const loadingEl = page.querySelector('#referral-code-loading');
  const contentEl = page.querySelector('#referral-code-content');
  const errorEl = page.querySelector('#referral-code-error');

  try {
    const { data, error } = await supabase.rpc('get_my_referral_code');
    
    if (error) throw error;
    if (!data) throw new Error('No referral code returned');

    const code = data;
    const baseUrl = getReferralBaseUrl();
    const referralLink = `${baseUrl}/#/signup?ref=${code}`;

    // Update UI
    page.querySelector('#referral-code-text').textContent = code;
    page.querySelector('#referral-link-text').textContent = referralLink;

    // Show content, hide loading
    loadingEl.classList.add('hidden');
    contentEl.classList.remove('hidden');

    // Copy code button
    page.querySelector('#copy-code-btn').addEventListener('click', async () => {
      await copyToClipboard(code, page.querySelector('#copy-code-btn'));
    });

    // Copy link button
    page.querySelector('#copy-link-btn').addEventListener('click', async () => {
      await copyToClipboard(referralLink, page.querySelector('#copy-link-btn'));
    });

    // Share button (Web Share API if available)
    page.querySelector('#share-link-btn').addEventListener('click', async () => {
      if (navigator.share) {
        try {
          await navigator.share({
            title: 'Join XReserve',
            text: `Sign up on XReserve using my referral code: ${code}`,
            url: referralLink,
          });
        } catch {
          // User cancelled or share failed, fallback to copy
          await copyToClipboard(referralLink, page.querySelector('#share-link-btn'));
        }
      } else {
        // Fallback: copy to clipboard
        await copyToClipboard(referralLink, page.querySelector('#share-link-btn'));
      }
    });

  } catch (err) {
    console.error('Failed to load referral code:', err);
    loadingEl.classList.add('hidden');
    errorEl.classList.remove('hidden');

    // Retry button
    const retryBtn = page.querySelector('#retry-code-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        errorEl.classList.add('hidden');
        loadingEl.classList.remove('hidden');
        loadReferralCode(page);
      });
    }
  }
}

async function loadReferralStats(page) {
  const loadingEl = page.querySelector('#referral-stats-loading');
  const contentEl = page.querySelector('#referral-stats-content');
  const countEl = page.querySelector('#referral-count');
  const listEl = page.querySelector('#referral-list');
  const emptyEl = page.querySelector('#referral-empty');

  try {
    const { data, error } = await supabase.rpc('get_my_referral_stats');
    
    if (error) throw error;

    const stats = data;
    const count = stats?.referral_count || 0;
    const referrals = stats?.referrals || [];

    countEl.textContent = count;
    loadingEl.classList.add('hidden');
    contentEl.classList.remove('hidden');

    if (referrals.length === 0) {
      emptyEl.classList.remove('hidden');
    } else {
      emptyEl.classList.add('hidden');
      listEl.innerHTML = '';

      referrals.forEach((ref, idx) => {
        if (idx > 0) {
          const divider = document.createElement('div');
          divider.className = 'divider';
          listEl.appendChild(divider);
        }

        const item = document.createElement('div');
        item.className = 'flex items-center gap-3 py-3';

        const referredAt = new Date(ref.referred_at);
        const dateStr = referredAt.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        });

        item.innerHTML = `
          <span class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-action/[0.1] text-[12px] font-semibold text-action dark:bg-action-dark/[0.15] dark:text-action-dark">
            #${idx + 1}
          </span>
          <div class="flex-1 min-w-0">
            <p class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">${ref.referred_username || 'Unknown'}</p>
            <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">${dateStr}</p>
          </div>
          <span class="text-[11px] font-mono text-text-secondary dark:text-text-secondary-dark">${ref.code_used}</span>
        `;

        listEl.appendChild(item);
      });
    }

  } catch (err) {
    console.error('Failed to load referral stats:', err);
    loadingEl.classList.add('hidden');
    contentEl.classList.remove('hidden');
    emptyEl.classList.remove('hidden');
    listEl.innerHTML = '';
  }
}

async function copyToClipboard(text, btn) {
  const originalHtml = btn.innerHTML;
  try {
    await navigator.clipboard.writeText(text);
    btn.innerHTML = checkIcon;
    setTimeout(() => {
      btn.innerHTML = originalHtml;
    }, 2000);
  } catch {
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      btn.innerHTML = checkIcon;
      setTimeout(() => {
        btn.innerHTML = originalHtml;
      }, 2000);
    } catch {
      console.error('Failed to copy to clipboard');
    }
    document.body.removeChild(textarea);
  }
}
