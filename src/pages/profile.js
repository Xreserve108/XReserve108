import { getUser, isAuthenticated, signOut, getDisplayUsername } from '@/core/auth';
import { navigate } from '@/core/router';

const personIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>`;
const shieldIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/></svg>`;
const bankIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21M3 5.25l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21"/></svg>`;
const bellIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"/></svg>`;
const chatIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/></svg>`;
const logoutIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"/></svg>`;

const menuSections = [
  {
    label: 'Account',
    items: [
      { icon: personIcon, label: 'Personal details', route: 'personal-details' },
      { icon: shieldIcon, label: 'Security', route: 'security' },
      { icon: bankIcon, label: 'Payment methods', route: 'payment-methods' },
      { icon: bellIcon, label: 'Notifications', route: 'notifications' },
    ],
  },
  {
    label: 'Support',
    items: [
      { icon: chatIcon, label: 'Help & Support', route: 'help-support' },
    ],
  },
];

export function renderProfile() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  const user = getUser();
  const signedIn = isAuthenticated();
  const displayName = getDisplayUsername() || 'User';

  page.innerHTML = `
    <h1 class="page-title">Profile</h1>
    <p class="text-muted mt-1 mb-8">Manage your account and preferences</p>

    <div id="profile-user-card" class="card mb-6 flex items-center gap-4 p-5">
      ${signedIn ? `
        <div class="flex h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-action text-[20px] font-semibold text-white dark:bg-action-dark dark:text-background-dark">
          ${user.user_metadata?.avatar_url
            ? `<img src="${user.user_metadata.avatar_url}" alt="" class="h-full w-full object-cover" />`
            : (displayName[0] || '?').toUpperCase()}
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[16px] font-semibold text-text-primary dark:text-text-primary-dark truncate">${displayName}</p>
          <p class="mt-0.5 text-[13px] text-text-secondary dark:text-text-secondary-dark truncate">@${displayName}</p>
        </div>
      ` : `
        <div class="flex h-14 w-14 items-center justify-center rounded-full bg-black/[0.04] text-[18px] font-semibold text-text-primary dark:bg-white/[0.08] dark:text-text-primary-dark">
          ?
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[16px] font-semibold text-text-primary dark:text-text-primary-dark">Not signed in</p>
          <p class="mt-0.5 text-[13px] text-text-secondary dark:text-text-secondary-dark">Sign in to access your wallet</p>
        </div>
        <a href="#signin" class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl text-text-secondary dark:text-text-secondary-dark">
          <svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>
        </a>
      `}
    </div>

    <div id="profile-menu"></div>

    ${signedIn ? `
      <div class="mt-4">
        <button id="signout-btn" class="flex w-full items-center justify-center gap-2.5 rounded-2xl px-4 py-3.5 text-[14px] font-medium text-red-500 transition-colors duration-150 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/10">
          ${logoutIcon}
          <span>Sign out</span>
        </button>
      </div>
    ` : ''}

    <div class="mt-8 mb-4">
      <p class="text-center text-[12px] text-text-secondary dark:text-text-secondary-dark">XReserve v1.1.0</p>
    </div>
  `;

  const menuContainer = page.querySelector('#profile-menu');

  menuSections.forEach((section, sIdx) => {
    if (sIdx > 0) {
      const spacer = document.createElement('div');
      spacer.className = 'my-2';
      menuContainer.appendChild(spacer);
    }

    const sectionLabel = document.createElement('p');
    sectionLabel.className = 'mb-2 px-1 text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark';
    sectionLabel.textContent = section.label;
    menuContainer.appendChild(sectionLabel);

    const card = document.createElement('div');
    card.className = 'card overflow-hidden';

    section.items.forEach((item, i) => {
      if (i > 0) {
        const divider = document.createElement('div');
        divider.className = 'divider';
        card.appendChild(divider);
      }

      const btn = document.createElement('button');
      btn.className = 'flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors duration-150 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]';
      btn.innerHTML = `
        <span class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-black/[0.04] text-text-secondary dark:bg-white/[0.06] dark:text-text-secondary-dark">${item.icon}</span>
        <span class="flex-1 text-[14px] font-medium text-text-primary dark:text-text-primary-dark">${item.label}</span>
        <svg class="h-4 w-4 flex-shrink-0 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>
      `;
      if (item.route) {
        btn.addEventListener('click', () => { navigate(item.route); });
      }
      card.appendChild(btn);
    });

    menuContainer.appendChild(card);
  });

  const signOutBtn = page.querySelector('#signout-btn');
  if (signOutBtn) {
    signOutBtn.addEventListener('click', handleSignOut);
  }

  return page;
}

async function handleSignOut() {
  const btn = document.getElementById('signout-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="auth-spinner" style="width:16px;height:16px"></div><span>Signing out...</span>`;
  }
  try {
    await signOut();
    // Clear any authenticated route hash and do a full reload so the app
    // boots fresh in the unauthenticated state
    window.history.replaceState(null, '', window.location.pathname);
    window.location.reload();
  } catch {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `${logoutIcon}<span>Sign out</span>`;
    }
  }
}
