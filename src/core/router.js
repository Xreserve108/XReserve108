import { isAuthenticated, isAdmin, is2FAVerified } from '@/core/auth';
import { get2FAStatus } from '@/core/totp';
import { notifyRouteChange } from '@/lib/chat';

const routes = {};
let currentRoute = null;
let layoutHandler = null;

export function registerRoute(name, config) {
  routes[name] = config;
}

export function onLayoutChange(handler) {
  layoutHandler = handler;
}

export function navigate(routeName) {
  const baseName = routeName.split('?')[0];
  if (!routes[baseName]) {
    console.warn(`Route "${baseName}" not registered`);
    return;
  }
  const route = routes[baseName];
  if (route.protected && !isAuthenticated()) {
    currentRoute = 'signin';
    window.location.hash = 'signin';
    render();
    return;
  }
  if (route.admin) {
    isAdmin().then(async (isAdm) => {
      if (!isAdm) {
        currentRoute = 'home';
        window.location.hash = 'home';
        render();
        return;
      }
      // Mandatory admin 2FA: block all admin routes without 2FA
      const status = await get2FAStatus();
      if (!status.enabled) {
        currentRoute = 'security';
        window.location.hash = 'security';
        render();
        return;
      }
      currentRoute = routeName;
      window.location.hash = routeName;
      render();
    });
    return;
  }
  // Redirect admin away from home
  if (baseName === 'home') {
    isAdmin().then((isAdm) => {
      if (isAdm) {
        currentRoute = 'admin';
        window.location.hash = 'admin';
      } else {
        currentRoute = routeName;
        window.location.hash = routeName;
      }
      render();
    });
    return;
  }
  currentRoute = routeName;
  window.location.hash = routeName;
  render();
}

export function getCurrentRoute() {
  return currentRoute;
}

function render() {
  const baseName = (currentRoute || '').split('?')[0];
  const route = routes[baseName];

  // Switch layout before rendering
  if (layoutHandler && route) {
    layoutHandler(route.layout || 'user');
  }

  const container = document.getElementById('page-content');
  if (!route || !container) return;

  if (route.protected && !isAuthenticated()) {
    currentRoute = 'signin';
    window.location.hash = 'signin';
    const signInRoute = routes['signin'];
    if (signInRoute) {
      container.innerHTML = '';
      container.appendChild(signInRoute.render());
      if (signInRoute.onMount) signInRoute.onMount(container);
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    return;
  }

  if (route.admin) {
    isAdmin().then(async (isAdm) => {
      if (!isAdm) {
        currentRoute = 'home';
        window.location.hash = 'home';
        render();
        return;
      }
      // Mandatory admin 2FA: block all admin routes without 2FA
      const status = await get2FAStatus();
      if (!status.enabled) {
        currentRoute = 'security';
        window.location.hash = 'security';
        render();
        return;
      }
      renderPage(container, route);
    });
    return;
  }

  renderPage(container, route);
}

async function renderPage(container, route) {
  container.innerHTML = '';
  const page = await route.render();
  container.appendChild(page);

  if (route.onMount) {
    route.onMount(container);
  }

  // Let route-aware global UI (floating active-chat icon) react
  notifyRouteChange((currentRoute || '').split('?')[0]);

  window.scrollTo({ top: 0, behavior: 'instant' });
}

export function refreshCurrentPage() {
  render();
}

function isOAuthHash(hash) {
  return hash.includes('access_token=') || hash.includes('refresh_token=');
}

const adminRouteMap = {
  'admin': 'admin',
  'admin/deposits': 'admin/deposits',
  'admin/sell-orders': 'admin/sell-orders',
  'admin/users': 'admin/users',
  'admin/settings': 'admin/settings',
  'admin/profile': 'admin/profile',
  'admin/personal-details': 'admin/personal-details',
  'admin/security': 'admin/security',
  'admin/deposit-methods': 'admin/deposit-methods',
  'admin/notifications': 'admin/notifications',
  'admin/live-chat': 'admin/live-chat',
  'admin/help-support': 'admin/help-support',
};

function resolveHash(hash) {
  if (!hash || isOAuthHash(hash)) return 'home';
  if (adminRouteMap[hash] !== undefined) return adminRouteMap[hash];
  return hash;
}

async function redirectAdminFromHome(initial) {
  if (initial === 'home') {
    const isAdm = await isAdmin();
    if (isAdm) return 'admin';
  }
  return initial;
}

export function initRouter() {
  // Root URL (no hash) resolves to #home without adding a history entry
  // or firing an extra hashchange — all boot logic then runs through the
  // existing router architecture.
  if (!window.location.hash) {
    history.replaceState(null, '', '#home');
  }

  window.addEventListener('hashchange', () => {
    const rawHash = window.location.hash.slice(1);
    const baseName = rawHash.split('?')[0];
    let hash = resolveHash(baseName);

    if (hash !== currentRoute) {
      const route = routes[hash];
      if (route?.protected && !isAuthenticated()) {
        currentRoute = 'signin';
        window.location.hash = 'signin';
        render();
      } else if (route?.admin) {
        isAdmin().then(async (isAdm) => {
          if (isAdm) {
            // Mandatory admin 2FA enforcement
            const status = await get2FAStatus();
            if (!status.enabled) {
              currentRoute = 'security';
              window.location.hash = 'security';
              render();
              return;
            }
            currentRoute = rawHash;
          } else {
            currentRoute = 'home';
            window.location.hash = 'home';
          }
          render();
        });
        return;
      } else if (hash === 'home') {
        // Redirect admin away from home
        isAdmin().then((isAdm) => {
          if (isAdm) {
            currentRoute = 'admin';
            window.location.hash = 'admin';
          } else {
            currentRoute = rawHash || 'home';
          }
          render();
        });
        return;
      } else if (route) {
        currentRoute = rawHash;
      } else {
        currentRoute = 'home';
      }
      render();
    }
  });

  (async () => {
    const rawInitial = window.location.hash.slice(1);
    const baseInitial = rawInitial.split('?')[0];
    let initial = resolveHash(baseInitial);
    initial = await redirectAdminFromHome(initial);

    if (routes[initial]) {
      const route = routes[initial];
      if (route.protected && !isAuthenticated()) {
        currentRoute = 'signin';
      } else if (route.admin) {
        const isAdm = await isAdmin();
        if (isAdm) {
          // Mandatory admin 2FA enforcement
          const status = await get2FAStatus();
          if (!status.enabled) {
            currentRoute = 'security';
          } else {
            currentRoute = rawInitial;
          }
        } else {
          currentRoute = 'home';
        }
      } else {
        currentRoute = rawInitial || initial;
      }
    } else {
      currentRoute = 'home';
    }
    render();
  })();
}
