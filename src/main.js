import '@/styles/app.css';
import 'lenis/dist/lenis.css';

import { initTheme } from '@/core/theme';
import { initLenis } from '@/core/smooth-scroll';
import { initAuth, onAuthStateChange, isAdmin, signOut, openAuthGate, is2FAVerified } from '@/core/auth';
import { initApp, setAdminState, rebuildUserLayout } from '@/app';
import { navigate, refreshCurrentPage, getCurrentRoute, initRouter } from '@/core/router';
import { getWalletBalance, startWalletHeartbeat, stopWalletHeartbeat } from '@/data/wallet-data';
import { startChatPolling, stopChatPolling } from '@/lib/chat';
import { supabase } from '@/lib/supabase';

// Track last known admin status for logout cleanup (agent OFFLINE)
let lastKnownIsAdmin = false;

function formatAmount(num) {
  const n = Number(num);
  if (!isFinite(n) || n < 0) return '0.00';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

initTheme();
initLenis();

// Show loading state while auth initializes
const appEl = document.getElementById('app');
appEl.innerHTML = `
  <div class="flex min-h-dvh flex-col items-center justify-center">
    <div class="auth-spinner mb-4"></div>
    <p class="text-sm text-text-secondary dark:text-text-secondary-dark">Loading XReserve...</p>
  </div>
`;

(async () => {
  // Initialize app shell (layout + router) before auth gate
  // This ensures navigation works even if user cancels 2FA
  initApp();

  // Listen for auth changes after sign-in/sign-out so the header and layout
  // rebuild with the correct authenticated state (e.g., wallet control).
  setupAuthListener();

  await initAuth();

  // Get session for layout/navigation logic below
  const { data: { session } } = await supabase.auth.getSession();

  // Open the auth gate — currentUser is now set, listeners fire
  await openAuthGate();

  // Initialize router AFTER auth is ready so the initial render
  // has the correct authentication state
  initRouter();

  // Check admin status early so nav/layout can use it
  const isAdm = await isAdmin();
  setAdminState(isAdm);

  // Propagate initial auth state now that gate is open
  if (session) {
    onAuthStateChange(() => {}); // ensure listener is registered
    // Rebuild layout with authenticated state (wallet control, etc.)
    rebuildUserLayout();
    // Manually trigger navigation based on current state
    const hash = window.location.hash.slice(1);
    if (isAdm) {
      if (!hash || hash === 'home') {
        navigate('admin');
      } else {
        refreshCurrentPage();
      }
    } else {
      if (hash === 'signin') {
        navigate('home');
      } else if (hash && hash.startsWith('admin')) {
        navigate('home');
      } else {
        refreshCurrentPage();
      }
    }
  }

  // If admin on home, redirect to admin dashboard
  if (isAdm) {
    const hash = window.location.hash.slice(1);
    if (!hash || hash === 'home') {
      navigate('admin');
    }
  }
})();

function setupAuthListener() {
  onAuthStateChange(async (event) => {
    const route = getCurrentRoute();
    if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
      const isAdm = await isAdmin();
      setAdminState(isAdm);
      lastKnownIsAdmin = isAdm;
      // Start the global wallet heartbeat for authenticated users.
      // Safe to call on both events — startWalletHeartbeat() guards against
      // duplicate intervals. The heartbeat runs for all authenticated users
      // including admins (admin layout has no wallet pill, but the calls
      // are harmless no-ops in that context).
      startWalletHeartbeat();
      // Start chat polling for floating icon (non-admin users only)
      if (!isAdm) startChatPolling();
      // Always rebuild layout so the wallet control appears for non-admin users too
      rebuildUserLayout();
      if (isAdm) {
        if (route === 'signin' || route === 'home') {
          navigate('admin');
        } else {
          // Admin on any other route (admin/* or user routes): render current page
          refreshCurrentPage();
        }
      } else {
        if (route === 'signin') {
          navigate('home');
        } else if (route && route.startsWith('admin')) {
          // Non-admin on admin route: redirect to home
          navigate('home');
        } else {
          // Non-admin on user route: render current page
          refreshCurrentPage();
        }
      }
    } else if (event === 'SESSION_REFRESHED') {
      // Token refresh or session restoration with same user
      // Don't rebuild layout - just refresh wallet balance
      const balanceEl = document.getElementById('wallet-balance-text');
      if (balanceEl) {
        try {
          const balance = await getWalletBalance();
          if (balance && isFinite(balance.available)) {
            balanceEl.textContent = formatAmount(balance.available);
          }
        } catch {
          // Balance fetch failed — leave as is
        }
      }
    } else if (event === 'SIGNED_OUT') {
      // If admin was logged in, attempt to mark agent OFFLINE
      // (best-effort; the RPC will fail silently if session is already gone)
      if (lastKnownIsAdmin) {
        try {
          await supabase.rpc('support_set_agent_status', { p_status: 'OFFLINE' });
        } catch { /* session may already be cleared */ }
        lastKnownIsAdmin = false;
      }
      // Stop the global wallet heartbeat — no longer authenticated
      stopWalletHeartbeat();
      stopChatPolling();
      setAdminState(false);
      if (route && route !== 'home' && route !== 'signin' && route !== 'profile') {
        navigate('home');
      } else if (route === 'profile' || route === 'wallet' || route === 'sell' || route === 'deposit' || route === 'orders') {
        refreshCurrentPage();
      }
    }
  });
}
