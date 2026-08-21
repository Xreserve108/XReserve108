import { navigate, getCurrentRoute } from '@/core/router';
import { toggleTheme, getTheme } from '@/core/theme';
import { getUser, getDisplayUsername } from '@/core/auth';
import { createBottomNav } from '@/components/navigation';
import { startAdminBadges, markUsersSeen } from '@/admin/notifications';

const adminNavItems = [
  { route: 'admin', label: 'Dashboard' },
  { route: 'admin/deposits', label: 'Deposits' },
  { route: 'admin/sell-orders', label: 'Sell Orders' },
  { route: 'admin/live-chat', label: 'Live Chat' },
  { route: 'admin/tickets', label: 'Tickets' },
  { route: 'admin/users', label: 'Users' },
];

const sunIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"/></svg>`;
const moonIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"/></svg>`;

export function createAdminLayout() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  app.className = 'flex min-h-dvh flex-col';

  const user = getUser();
  const userName = getDisplayUsername() || 'Admin';

  // Top bar
  const header = document.createElement('header');
  header.className = 'sticky top-0 z-40 flex items-center justify-between border-b border-border-light bg-surface-light/80 px-5 py-3 backdrop-blur-xl md:px-8 dark:border-border-dark dark:bg-surface-dark/80';
  header.innerHTML = `
    <a href="#admin" class="text-[15px] font-semibold tracking-[-0.01em] text-text-primary dark:text-text-primary-dark">XReserve <span class="text-text-secondary dark:text-text-secondary-dark font-normal">Admin</span></a>
    <div class="flex items-center gap-1">
      <button id="admin-theme-toggle" class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl p-3 text-text-secondary transition-colors duration-200 hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]" aria-label="Toggle theme">
        ${getTheme() === 'dark' ? sunIcon : moonIcon}
      </button>
      <a id="admin-account-btn" href="#admin/profile" class="flex min-h-[44px] items-center gap-2 rounded-xl px-2 py-2 text-text-secondary transition-colors duration-200 hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]" aria-label="Admin profile">
        <div id="admin-avatar" class="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-action text-[12px] font-semibold text-white dark:bg-action-dark dark:text-background-dark"></div>
        <span id="admin-user-name" class="hidden text-[13px] font-medium sm:inline"></span>
      </a>
    </div>
  `;

  // Safely set user data via textContent / DOM
  const avatarEl = header.querySelector('#admin-avatar');
  const nameEl = header.querySelector('#admin-user-name');
  if (user?.user_metadata?.avatar_url) {
    const img = document.createElement('img');
    img.src = user.user_metadata.avatar_url;
    img.alt = '';
    img.className = 'h-full w-full object-cover';
    avatarEl.textContent = '';
    avatarEl.appendChild(img);
  } else {
    avatarEl.textContent = (userName[0] || 'A').toUpperCase();
  }
  nameEl.textContent = userName;

  app.appendChild(header);

  // Desktop admin nav (horizontal tabs — visible md+)
  const nav = document.createElement('nav');
  nav.className = 'hidden border-b border-border-light bg-surface-light md:block dark:border-border-dark dark:bg-surface-dark';
  nav.setAttribute('aria-label', 'Admin navigation');
  nav.innerHTML = `<div class="flex gap-1 overflow-x-auto px-4 py-2 scrollbar-hide" id="admin-nav-list"></div>`;
  const list = nav.querySelector('#admin-nav-list');

  adminNavItems.forEach((item) => {
    const btn = document.createElement('button');
    const isActive = getCurrentRoute() === item.route;
    btn.className = `flex items-center gap-1.5 whitespace-nowrap rounded-xl px-4 py-2 text-[13px] font-medium transition-all duration-200 ${
      isActive
        ? 'tab-active'
        : 'text-text-secondary hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]'
    }`;
    btn.dataset.route = item.route;
    btn.innerHTML = `<span>${item.label}</span><span class="nav-badge hidden" data-nav-badge="${item.route}"></span>`;
    btn.addEventListener('click', () => navigate(item.route));
    list.appendChild(btn);
  });

  app.appendChild(nav);

  // Content
  const content = document.createElement('div');
  content.id = 'page-content';
  content.className = 'flex-1 pb-20 md:pb-0';
  app.appendChild(content);

  // Mobile bottom navigation
  const bottomNav = createBottomNav(true);
  app.appendChild(bottomNav);

  // Theme toggle
  header.querySelector('#admin-theme-toggle').addEventListener('click', () => {
    toggleTheme();
    header.querySelector('#admin-theme-toggle').innerHTML = getTheme() === 'dark' ? sunIcon : moonIcon;
  });

  // Start notification badge refresh loop (single guarded interval)
  startAdminBadges();
}

export function updateAdminNav() {
  // Users badge open-to-clear: entering the Users section marks new users
  // as seen (Deposits/Orders counts are never affected by this).
  if (getCurrentRoute() === 'admin/users') {
    markUsersSeen();
  }

  // Update desktop tabs
  const list = document.querySelector('#admin-nav-list');
  if (list) {
    const buttons = list.querySelectorAll('button');
    buttons.forEach((btn) => {
      const isActive = getCurrentRoute() === btn.dataset.route;
      btn.className = `flex items-center gap-1.5 whitespace-nowrap rounded-xl px-4 py-2 text-[13px] font-medium transition-all duration-200 ${
        isActive
          ? 'tab-active'
          : 'text-text-secondary hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]'
      }`;
    });
  }

  // Update mobile bottom nav
  const bottomList = document.querySelector('#bottom-nav-list');
  if (bottomList) {
    const items = bottomList.querySelectorAll('.nav-item');
    items.forEach((btn) => {
      const isActive = getCurrentRoute() === btn.dataset.route;
      btn.className = `nav-item flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-xl px-3 py-2.5 text-[11px] font-medium transition-all duration-200 ${
        isActive
          ? 'text-text-primary dark:text-text-primary-dark'
          : 'text-text-secondary dark:text-text-secondary-dark'
      }`;
    });
  }
}
