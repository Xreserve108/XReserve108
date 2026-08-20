import { navigate, getCurrentRoute } from '@/core/router';
import { toggleTheme, getTheme } from '@/core/theme';
import { isAuthenticated } from '@/core/auth';
import { getWalletBalance } from '@/data/wallet-data';
import { TetherIcon } from '@/components/icons/TetherIcon';

const homeIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"/></svg>`;
const walletIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M20 7H4a2 2 0 00-2 2v6a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2 10h20"/><circle cx="17" cy="14.5" r="1.5" fill="currentColor" stroke="none"/></svg>`;
const sellIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"/></svg>`;
const ordersIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3.75 3H7.5c-2.485 0-4.5-2.015-4.5-4.5V8.25c0-2.485 2.015-4.5 4.5-4.5h9c2.485 0 4.5 2.015 4.5 4.5v8.25c0 2.485-2.015 4.5-4.5 4.5z"/></svg>`;
const profileIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>`;
const sunIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"/></svg>`;
const moonIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"/></svg>`;
const depositsIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v6m3-3H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
const usersIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"/></svg>`;
const settingsIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .807c-.008.378.137.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.806c.008-.378-.137-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`;

const userNavItems = [
  { route: 'home', label: 'Home', icon: homeIcon },
  { route: 'wallet', label: 'Wallet', icon: walletIcon },
  { route: 'sell', label: 'Sell', icon: sellIcon },
  { route: 'orders', label: 'Orders', icon: ordersIcon },
];

const dashboardIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z"/></svg>`;

const adminNavItems = [
  { route: 'admin', label: 'Dashboard', icon: dashboardIcon },
  { route: 'admin/deposits', label: 'Deposits', icon: depositsIcon },
  { route: 'admin/sell-orders', label: 'Orders', icon: ordersIcon },
  { route: 'admin/users', label: 'Users', icon: usersIcon },
];

export function createBottomNav(isAdmin = false) {
  const items = isAdmin ? adminNavItems : userNavItems;
  const nav = document.createElement('nav');
  nav.className = 'fixed bottom-0 left-0 right-0 z-50 md:hidden';
  nav.setAttribute('aria-label', isAdmin ? 'Admin navigation' : 'Main navigation');
  nav.innerHTML = `
    <div class="mx-4 mb-4 rounded-2xl border border-border-light bg-surface-light/90 px-2 py-2 shadow-elevated backdrop-blur-xl dark:border-border-dark dark:bg-surface-dark/90 dark:shadow-elevated-dark">
      <ul class="flex items-center justify-around" id="bottom-nav-list"></ul>
    </div>
  `;

  const list = nav.querySelector('#bottom-nav-list');
  items.forEach((item) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    const isActive = getCurrentRoute() === item.route;

    btn.className = `nav-item flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-xl px-3 py-2.5 text-[11px] font-medium transition-all duration-200 ${
      isActive
        ? 'text-text-primary dark:text-text-primary-dark'
        : 'text-text-secondary dark:text-text-secondary-dark'
    }`;
    btn.dataset.route = item.route;
    btn.innerHTML = `
      <span class="nav-icon relative transition-transform duration-200">${item.icon}<span class="nav-badge hidden" data-nav-badge="${item.route}"></span></span>
      <span>${item.label}</span>
    `;
    btn.addEventListener('click', () => {
      navigate(item.route);
      updateBottomNav();
    });

    li.appendChild(btn);
    list.appendChild(li);
  });

  // Hide bottom nav when keyboard is open (mobile)
  if (window.visualViewport) {
    const initialHeight = window.visualViewport.height;
    window.visualViewport.addEventListener('resize', () => {
      const currentHeight = window.visualViewport.height;
      // If viewport height shrinks by more than 100px, keyboard is likely open
      if (currentHeight < initialHeight - 100) {
        nav.style.display = 'none';
      } else {
        nav.style.display = '';
      }
    });
  }

  return nav;
}

function updateBottomNav() {
  const items = document.querySelectorAll('#bottom-nav-list .nav-item');
  items.forEach((btn) => {
    const isActive = getCurrentRoute() === btn.dataset.route;
    btn.className = `nav-item flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-xl px-3 py-2.5 text-[11px] font-medium transition-all duration-200 ${
      isActive
        ? 'text-text-primary dark:text-text-primary-dark'
        : 'text-text-secondary dark:text-text-secondary-dark'
    }`;
  });
}

export function createTopBar() {
  const header = document.createElement('header');
  header.className = 'sticky top-0 z-40 flex items-center justify-between px-5 py-4 md:px-8 bg-surface-light dark:bg-surface-dark';

  const signedIn = isAuthenticated();

  // Build right-side controls
  let rightControlsHTML = '';
  if (signedIn) {
    rightControlsHTML = `
      <div id="wallet-control" class="flex items-center gap-1">
        <div class="flex items-center gap-1.5 rounded-xl border border-border-light bg-surface-light/90 px-2 py-1.5 backdrop-blur-xl dark:border-border-dark dark:bg-surface-dark/90 overflow-hidden">
          ${TetherIcon({ className: 'h-[18px] w-[18px]' })}
          <span id="wallet-balance-text" class="text-[12px] font-semibold tabular-nums text-text-primary dark:text-text-primary-dark">--</span>
          <span class="text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark">USDT</span>
          <svg class="h-3 w-3 flex-shrink-0 opacity-40" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5"/></svg>
        </div>
      </div>
      <button id="theme-toggle" class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl p-3 text-text-secondary transition-colors duration-200 hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]" aria-label="Toggle theme">
        ${getTheme() === 'dark' ? sunIcon : moonIcon}
      </button>
      <a href="#profile" class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl p-3 text-text-secondary transition-colors duration-200 hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]" aria-label="Profile">
        ${profileIcon}
      </a>
    `;
  } else {
    rightControlsHTML = `
      <button id="theme-toggle" class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl p-3 text-text-secondary transition-colors duration-200 hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]" aria-label="Toggle theme">
        ${getTheme() === 'dark' ? sunIcon : moonIcon}
      </button>
      <a href="#signin" class="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl p-3 text-text-secondary transition-colors duration-200 hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]" aria-label="Sign in">
        ${profileIcon}
      </a>
    `;
  }

  header.innerHTML = `
    <a href="#home" class="text-[17px] font-semibold tracking-[-0.01em] text-text-primary dark:text-text-primary-dark">XReserve</a>
    <div class="flex items-center gap-1">
      ${rightControlsHTML}
    </div>
  `;

  header.querySelector('#theme-toggle').addEventListener('click', () => {
    toggleTheme();
    header.querySelector('#theme-toggle').innerHTML = getTheme() === 'dark' ? sunIcon : moonIcon;
  });

  // Fetch and display real balance for authenticated users
  if (signedIn) {
    updateWalletBalance(header);
  }

  return header;
}

async function updateWalletBalance(header) {
  const balanceEl = header.querySelector('#wallet-balance-text');
  if (!balanceEl) return;
  try {
    const balance = await getWalletBalance();
    if (balance && isFinite(balance.available)) {
      balanceEl.textContent = formatAmount(balance.available);
    }
  } catch {
    // Balance fetch failed — leave as "--"
  }
}

function formatAmount(num) {
  const n = Number(num);
  if (!isFinite(n) || n < 0) return '0.00';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export function createDesktopSidebar(isAdmin = false) {
  const items = isAdmin ? adminNavItems : userNavItems;
  const aside = document.createElement('aside');
  aside.className = 'hidden md:flex md:flex-col md:w-[240px] md:fixed md:inset-y-0 md:z-40 md:border-r md:border-border-light md:bg-surface-light/50 md:backdrop-blur-xl md:dark:border-border-dark md:dark:bg-surface-dark/50';

  aside.innerHTML = `
    <div class="flex h-16 items-center px-6">
      <a href="#${isAdmin ? 'admin' : 'home'}" class="text-[17px] font-semibold tracking-[-0.01em] text-text-primary dark:text-text-primary-dark">XReserve${isAdmin ? ' <span class="text-text-secondary dark:text-text-secondary-dark font-normal text-[13px]">Admin</span>' : ''}</a>
    </div>
    <nav class="flex-1 px-3 py-2" aria-label="${isAdmin ? 'Admin' : 'Main'} navigation">
      <ul class="space-y-0.5" id="desktop-nav-list"></ul>
    </nav>
    <div class="border-t border-border-light p-4 dark:border-border-dark">
      <button id="desktop-theme-toggle" class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium text-text-secondary transition-colors duration-200 hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]" aria-label="Toggle theme">
        ${getTheme() === 'dark' ? sunIcon : moonIcon}
        <span>Toggle theme</span>
      </button>
    </div>
  `;

  const list = aside.querySelector('#desktop-nav-list');
  items.forEach((item) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    const isActive = getCurrentRoute() === item.route;

    btn.className = `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all duration-200 ${
      isActive
        ? 'bg-black/[0.04] text-text-primary dark:bg-white/[0.08] dark:text-text-primary-dark'
        : 'text-text-secondary hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]'
    }`;
    btn.innerHTML = `${item.icon}<span class="flex-1 text-left">${item.label}</span><span class="nav-badge hidden" data-nav-badge="${item.route}"></span>`;
    btn.dataset.route = item.route;
    btn.addEventListener('click', () => {
      navigate(item.route);
      updateDesktopNav(aside);
    });

    li.appendChild(btn);
    list.appendChild(li);
  });

  aside.querySelector('#desktop-theme-toggle').addEventListener('click', () => {
    toggleTheme();
    const btn = aside.querySelector('#desktop-theme-toggle');
    const iconEl = btn.querySelector('svg');
    if (iconEl) {
      iconEl.outerHTML = getTheme() === 'dark' ? sunIcon : moonIcon;
    }
  });

  return aside;
}

function updateDesktopNav(aside) {
  const list = aside.querySelector('#desktop-nav-list');
  if (!list) return;
  const buttons = list.querySelectorAll('button');
  buttons.forEach((btn) => {
    const isActive = getCurrentRoute() === btn.dataset.route;
    btn.className = `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all duration-200 ${
      isActive
        ? 'bg-black/[0.04] text-text-primary dark:bg-white/[0.08] dark:text-text-primary-dark'
        : 'text-text-secondary hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]'
    }`;
  });
}
