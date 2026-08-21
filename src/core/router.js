import { isAuthenticated, isAdmin, is2FAVerified } from '@/core/auth';
import { get2FAStatus } from '@/core/totp';

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
  if (!routes[routeName]) {
    console.warn(`Route "${routeName}" not registered`);
    return;
  }
  const route = routes[routeName];
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
  if (routeName === 'home') {
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
  const route = routes[currentRoute];

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
  window.addEventListener('hashchange', () => {
    let hash = resolveHash(window.location.hash.slice(1));

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
            currentRoute = hash;
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
            currentRoute = hash;
          }
          render();
        });
        return;
      } else if (route) {
        currentRoute = hash;
      } else {
        currentRoute = 'home';
      }
      render();
    }
  });

  (async () => {
    let initial = resolveHash(window.location.hash.slice(1));
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
            currentRoute = initial;
          }
        } else {
          currentRoute = 'home';
        }
      } else {
        currentRoute = initial;
      }
    } else {
      currentRoute = 'home';
    }
    render();
  })();
}
