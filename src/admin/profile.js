import { getUser, signOut, getDisplayUsername } from '@/core/auth';
import { navigate } from '@/core/router';

const personIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>`;
const shieldIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/></svg>`;
const bankIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21M3 5.25l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21"/></svg>`;
const bellIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"/></svg>`;
const paletteIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.098 19.902a3.75 3.75 0 005.304 0l6.401-6.402M6.75 21A3.75 3.75 0 013 17.25V4.125C3 3.504 3.504 3 4.125 3h5.25c.621 0 1.125.504 1.125 1.125V11.25a3.75 3.75 0 007.5 0V4.125C18 3.504 18.504 3 19.125 3h.75c.621 0 1.125.504 1.125 1.125v12.75c0 3.107-2.518 5.625-5.625 5.625H6.75z"/></svg>`;
const globeIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"/></svg>`;
const chatIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"/></svg>`;
const docIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/></svg>`;
const logoutIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9"/></svg>`;

// Admin profile menu: NO Payment Methods (user-only). Deposit Methods
// appears under Security (moved here from the former Settings page).
const menuSections = [
  {
    label: 'Account',
    items: [
      { icon: personIcon, label: 'Personal details', route: '' },
      { icon: shieldIcon, label: 'Security', route: 'admin/security' },
      { icon: bankIcon, label: 'Deposit Methods', route: 'admin/deposit-methods' },
      { icon: bellIcon, label: 'Notifications', route: 'admin/notifications' },
    ],
  },
  {
    label: 'Preferences',
    items: [
      { icon: paletteIcon, label: 'Appearance', route: '' },
    ],
  },
  {
    label: 'Support',
    items: [
      { icon: chatIcon, label: 'Help center', route: '' },
    ],
  },
];

export function renderAdminProfile() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col px-5 pb-8 pt-8 md:px-8 lg:px-12';

  const user = getUser();
  const displayName = getDisplayUsername() || 'Admin';

  page.innerHTML = `
    <h1 class="page-title">Profile</h1>
    <p class="text-muted mt-1 mb-8">Manage your admin account</p>

    <div class="card mb-6 flex items-center gap-4 p-5">
      <div class="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-action text-[20px] font-semibold text-white dark:bg-action-dark dark:text-background-dark">
        ${user?.user_metadata?.avatar_url
          ? `<img src="${user.user_metadata.avatar_url}" alt="" class="h-full w-full object-cover" />`
          : (displayName[0] || 'A').toUpperCase()}
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <p class="truncate text-[16px] font-semibold text-text-primary dark:text-text-primary-dark">${displayName}</p>
          <span class="flex-shrink-0 rounded-md bg-action/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-action dark:bg-action-dark/15 dark:text-action-dark">Admin</span>
        </div>
        <p class="mt-0.5 truncate text-[13px] text-text-secondary dark:text-text-secondary-dark">@${displayName}</p>
      </div>
    </div>

    <div id="admin-profile-menu"></div>

    <div class="mt-4">
      <button id="admin-signout-btn" class="flex w-full items-center justify-center gap-2.5 rounded-2xl px-4 py-3.5 text-[14px] font-medium text-red-500 transition-colors duration-150 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/10">
        ${logoutIcon}
        <span>Sign out</span>
      </button>
    </div>

    <div class="mt-8 mb-4">
      <p class="text-center text-[12px] text-text-secondary dark:text-text-secondary-dark">XReserve v1.1.0</p>
    </div>
  `;

  const menuContainer = page.querySelector('#admin-profile-menu');

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

  page.querySelector('#admin-signout-btn').addEventListener('click', handleAdminSignOut);

  return page;
}

async function handleAdminSignOut() {
  const btn = document.getElementById('admin-signout-btn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<div class="auth-spinner" style="width:16px;height:16px"></div><span>Signing out...</span>`;
  }
  try {
    await signOut();
    navigate('signin');
  } catch {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `${logoutIcon}<span>Sign out</span>`;
    }
  }
}
