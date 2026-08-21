import { registerRoute, onLayoutChange } from '@/core/router';
import { createBottomNav, createTopBar, createDesktopSidebar } from '@/components/navigation';
import { createAdminLayout, updateAdminNav } from '@/layouts/admin';

import { renderHome } from '@/pages/home';
import { renderWallet } from '@/pages/wallet';
import { renderSell, setupSellInteractions } from '@/pages/sell';
import { renderDeposit } from '@/pages/deposit';
import { renderOrders } from '@/pages/orders';
import { renderProfile } from '@/pages/profile';
import { renderSignIn } from '@/pages/signin';
import { renderSignUp } from '@/pages/signup';
import { renderSecurity } from '@/pages/security';
import { renderPaymentMethods } from '@/pages/payment-methods';
import { renderPersonalDetails } from '@/pages/personal-details';

import { renderAdminDashboard } from '@/admin/dashboard';
import { renderAdminDeposits } from '@/admin/deposits';
import { renderAdminSellOrders } from '@/admin/sell-orders';
import { renderAdminSecurity, renderAdminSecurityContent } from '@/admin/security';
import { renderDepositMethods, renderDepositMethodsContent } from '@/admin/deposit-methods';
import { renderAdminProfile } from '@/admin/profile';
import { renderAdminPersonalDetails } from '@/admin/personal-details';
import { stopAdminBadges } from '@/admin/notifications';
import { renderNotifications } from '@/pages/notifications';
import { renderAdminNotifications } from '@/admin/notifications-page';
import { renderHelpSupport } from '@/pages/help-support';
import { renderLiveChat } from '@/pages/live-chat';
import { renderChatHistory } from '@/pages/chat-history';
import { renderAdminLiveChat, renderAdminHelpSupport } from '@/admin/live-chat';
import { renderAdminTickets } from '@/admin/tickets';
import { renderAdminUsers } from '@/admin/users';
import { renderMyTickets } from '@/pages/my-tickets';
import { renderCreateTicket } from '@/pages/create-ticket';
import { renderTicketDetail } from '@/pages/ticket-detail';
import { startChatPolling, stopChatPolling } from '@/lib/chat';

let currentLayout = null;
let adminState = false;

export function setAdminState(isAdmin) {
  adminState = isAdmin;
}

export function rebuildUserLayout() {
  currentLayout = null; // force rebuild
  setupUserLayout();
}

function setupUserLayout() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  app.className = 'flex min-h-dvh flex-col md:flex-row';

  const sidebar = createDesktopSidebar(adminState);
  app.appendChild(sidebar);

  const mainWrapper = document.createElement('div');
  mainWrapper.className = 'flex flex-1 flex-col md:ml-[240px]';

  const topBar = createTopBar();
  mainWrapper.appendChild(topBar);

  const content = document.createElement('div');
  content.id = 'page-content';
  content.className = 'flex flex-1 flex-col min-h-0 pb-20 md:pb-0';
  mainWrapper.appendChild(content);

  const bottomNav = createBottomNav(adminState);
  mainWrapper.appendChild(bottomNav);

  app.appendChild(mainWrapper);
}

function handleLayoutChange(layout) {
  if (currentLayout === layout) return;
  // Tear down the admin notification badge timer when leaving admin layout
  if (currentLayout === 'admin' && layout !== 'admin') {
    stopAdminBadges();
  }
  currentLayout = layout;
  if (layout === 'admin') {
    createAdminLayout();
  } else {
    setupUserLayout();
  }
}

function registerRoutes() {
  // User routes
  registerRoute('home', { render: renderHome });
  registerRoute('wallet', { render: renderWallet, protected: true });
  registerRoute('sell', { render: renderSell, onMount: setupSellInteractions, protected: true });
  registerRoute('deposit', { render: renderDeposit, protected: true });
  registerRoute('orders', { render: renderOrders, protected: true });
  registerRoute('profile', { render: renderProfile });
  registerRoute('signin', { render: renderSignIn });
  registerRoute('signup', { render: renderSignUp });
  registerRoute('security', { render: renderSecurity, protected: true });
  registerRoute('payment-methods', { render: renderPaymentMethods, protected: true });
  registerRoute('personal-details', { render: renderPersonalDetails, protected: true });
  registerRoute('notifications', { render: renderNotifications, protected: true });
  registerRoute('help-support', { render: renderHelpSupport, protected: true });
  registerRoute('live-chat', { render: renderLiveChat, protected: true });
  registerRoute('chat-history', { render: renderChatHistory, protected: true });
  registerRoute('my-tickets', { render: renderMyTickets, protected: true });
  registerRoute('create-ticket', { render: renderCreateTicket, protected: true });
  registerRoute('ticket-detail', { render: renderTicketDetail, protected: true });

  // Admin routes
  registerRoute('admin', {
    render: renderAdminDashboard,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
  registerRoute('admin/deposits', {
    render: renderAdminDeposits,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
  registerRoute('admin/sell-orders', {
    render: renderAdminSellOrders,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
  registerRoute('admin/users', {
    render: renderAdminUsers,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
  registerRoute('admin/settings', {
    render: renderAdminSettings,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
  registerRoute('admin/profile', {
    render: renderAdminProfile,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
  registerRoute('admin/personal-details', {
    render: renderAdminPersonalDetails,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
  registerRoute('admin/security', {
    render: renderAdminSecurity,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
  registerRoute('admin/deposit-methods', {
    render: renderDepositMethods,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
  registerRoute('admin/notifications', {
    render: renderAdminNotifications,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
  registerRoute('admin/live-chat', {
    render: renderAdminLiveChat,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
  registerRoute('admin/help-support', {
    render: renderAdminHelpSupport,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
  registerRoute('admin/tickets', {
    render: renderAdminTickets,
    admin: true,
    layout: 'admin',
    onMount: () => updateAdminNav(),
  });
}

function renderAdminPlaceholder(title, subtitle) {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col items-center justify-center px-5 pb-8 pt-8 md:px-8 lg:px-12';
  page.innerHTML = `
    <div class="card flex flex-col items-center py-16 px-8 text-center w-full max-w-sm">
      <div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
        <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11.42 15.17l-5.384 3.18.945-5.932L2.564 7.89l5.965-.52L11.42 2l2.89 5.37 5.966.52-4.418 4.528.944 5.932z"/></svg>
      </div>
      <p class="mt-4 text-[17px] font-semibold text-text-primary dark:text-text-primary-dark">${title}</p>
      <p class="mt-1 text-[14px] text-text-secondary dark:text-text-secondary-dark">${subtitle}</p>
    </div>
  `;
  return page;
}

function renderAdminSettings() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col px-5 pb-8 pt-8 md:px-8 lg:px-12';

  page.innerHTML = `
    <h1 class="page-title">Settings</h1>
    <p class="text-muted mt-1 mb-6">Admin configuration</p>
    <div class="flex gap-1 mb-6 border-b border-border-light dark:border-border-dark" role="tablist">
      <button class="settings-tab px-4 py-2.5 text-[13px] font-medium border-b-2 transition-colors" data-tab="security" role="tab">Security</button>
      <button class="settings-tab px-4 py-2.5 text-[13px] font-medium border-b-2 border-transparent text-text-secondary dark:text-text-secondary-dark transition-colors" data-tab="deposits" role="tab">Deposit Methods</button>
    </div>
    <div id="settings-tab-content"></div>
  `;

  const tabs = page.querySelectorAll('.settings-tab');
  const content = page.querySelector('#settings-tab-content');

  function activateTab(tabName) {
    tabs.forEach(t => {
      const isActive = t.dataset.tab === tabName;
      t.className = `settings-tab px-4 py-2.5 text-[13px] font-medium border-b-2 transition-colors ${
        isActive
          ? 'border-action text-text-primary dark:border-action-dark dark:text-text-primary-dark'
          : 'border-transparent text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark'
      }`;
    });

    content.innerHTML = '';
    if (tabName === 'security') {
      content.appendChild(renderAdminSecurityContent());
    } else if (tabName === 'deposits') {
      content.appendChild(renderDepositMethodsContent());
    }
  }

  tabs.forEach(t => {
    t.addEventListener('click', () => activateTab(t.dataset.tab));
  });

  // Default to security tab
  activateTab('security');
  return page;
}

export function initApp() {
  onLayoutChange(handleLayoutChange);
  registerRoutes();
  // NOTE: initRouter() is called separately from main.js after auth is ready
  // to prevent the initial route from rendering before currentUser is set
}
