import { signInWithUsername, isAuthenticated, signOut } from '@/core/auth';
import { navigate } from '@/core/router';
import { normalizeUsername } from '@/core/username';
import { get2FAStatus } from '@/core/totp';
import { TotpDialog } from '@/components/TotpDialog';

export function renderSignIn() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col items-center justify-center px-5 pb-24 md:pb-8';

  if (isAuthenticated()) {
    navigate('home');
    return page;
  }

  page.innerHTML = `
    <div class="w-full max-w-[360px] text-center">
      <div class="mx-auto mb-8 flex h-14 w-14 items-center justify-center rounded-2xl bg-action dark:bg-action-dark">
        <svg class="h-6 w-6 text-white dark:text-background-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>
      </div>

      <h1 class="page-title mb-2">Welcome to XReserve</h1>
      <p class="text-muted mb-8">Sign in to access your USDT wallet, deposit funds, and sell for INR.</p>

      <form id="username-signin-form" class="space-y-4">
        <div class="text-left">
          <label for="signin-username" class="mb-1.5 block text-[13px] font-medium text-text-primary dark:text-text-primary-dark">Username</label>
          <input 
            id="signin-username" 
            type="text" 
            autocomplete="username"
            class="input-field w-full" 
            placeholder="Enter your username"
            required
          />
        </div>

        <div class="text-left">
          <label for="signin-password" class="mb-1.5 block text-[13px] font-medium text-text-primary dark:text-text-primary-dark">Password</label>
          <input 
            id="signin-password" 
            type="password" 
            autocomplete="current-password"
            class="input-field w-full" 
            placeholder="Enter your password"
            required
          />
        </div>

        <button id="username-signin-btn" type="submit" class="btn-primary flex w-full items-center justify-center gap-2 min-h-[48px]">
          <span>Sign In</span>
        </button>
      </form>

      <div id="signin-error" class="hidden mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-600 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-400">
        <p id="signin-error-msg"></p>
      </div>

      <p class="mt-8 text-[13px] text-text-secondary dark:text-text-secondary-dark">
        Don't have an account? <a href="#signup" class="font-medium text-action hover:underline dark:text-action-dark">Sign up</a>
      </p>

      <p class="mt-6 text-[12px] leading-relaxed text-text-secondary dark:text-text-secondary-dark">
        By signing in, you agree to the terms of service.
      </p>
    </div>
  `;

  setupSignInHandlers(page);
  return page;
}

function setupSignInHandlers(page) {
  const usernameForm = page.querySelector('#username-signin-form');
  if (usernameForm) {
    usernameForm.addEventListener('submit', handleUsernameSignIn);
  }
}

async function handleUsernameSignIn(e) {
  e.preventDefault();
  
  const btn = document.getElementById('username-signin-btn');
  const usernameInput = document.getElementById('signin-username');
  const passwordInput = document.getElementById('signin-password');
  
  if (!btn || btn.disabled) return;
  
  const username = normalizeUsername(usernameInput?.value || '');
  const password = passwordInput?.value || '';
  
  if (!username || !password) {
    showError('Please enter username and password');
    return;
  }
  
  btn.disabled = true;
  btn.innerHTML = `<div class="auth-spinner"></div><span>Signing in...</span>`;
  hideError();
  
  try {
    await signInWithUsername(username, password);
    
    // Check 2FA status and enforce verification
    try {
      const status = await get2FAStatus();
      if (status.enabled) {
        // 2FA is enabled — require verification before granting access
        btn.innerHTML = `<div class="auth-spinner"></div><span>Verifying 2FA...</span>`;
        try {
          await TotpDialog({
            title: 'Two-Factor Authentication',
            message: 'Verify your identity to continue.',
            allowRecovery: true,
          });
        } catch {
          // User cancelled or failed 2FA — sign out
          await signOut();
          btn.disabled = false;
          btn.innerHTML = '<span>Sign In</span>';
          showError('Two-factor authentication failed. Please try again.');
          return;
        }
      }
    } catch {
      // 2FA status check failed — sign out for security
      await signOut();
      btn.disabled = false;
      btn.innerHTML = '<span>Sign In</span>';
      showError('Security check failed. Please try again.');
      return;
    }
    
    // All verification complete — show success state
    btn.innerHTML = `
      <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
      </svg>
      <span>Login Successful</span>
    `;
    btn.classList.add('btn-success');
    btn.classList.remove('btn-primary');
    
    // Wait for success animation, then navigate
    await new Promise(resolve => setTimeout(resolve, 800));
    navigate('home');
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove('btn-success');
    btn.classList.add('btn-primary');
    btn.innerHTML = '<span>Sign In</span>';
    
    // Generic error to prevent username enumeration
    showError('Invalid username or password');
  }
}

function showError(msg) {
  const el = document.getElementById('signin-error');
  const msgEl = document.getElementById('signin-error-msg');
  if (el && msgEl) {
    msgEl.textContent = msg;
    el.classList.remove('hidden');
  }
}

function hideError() {
  const el = document.getElementById('signin-error');
  if (el) el.classList.add('hidden');
}
