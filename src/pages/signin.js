import { signInWithUsername, isAuthenticated, signOut, setLogin2faPending, completeLogin2FA } from '@/core/auth';
import { navigate } from '@/core/router';
import { normalizeUsername } from '@/core/username';
import { get2FAStatus, begin2FAEnrollment, confirm2FAEnrollment, renderQRCode } from '@/core/totp';
import { signInWithPasskey, establishPasskeyLoginAssurance, browserSupportsPasskeys, listPasskeys, registerPasskeyMandatory } from '@/core/passkey';
import { TotpDialog } from '@/components/TotpDialog';
import { supabase } from '@/lib/supabase';

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
    // Block currentUser from being set until 2FA is resolved
    setLogin2faPending(true);

    await signInWithUsername(username, password);
    
    // Check 2FA status and enforce verification
    try {
      // Check TOTP status
      const status = await get2FAStatus();
      const hasTotp = status.enabled;

      // Check passkey status — fail-closed only if TOTP is also unknown
      let hasPasskey = false;
      let passkeyCheckFailed = false;
      if (browserSupportsPasskeys()) {
        try {
          const passkeys = await listPasskeys();
          if (!Array.isArray(passkeys)) {
            throw new Error('Invalid passkey state');
          }
          hasPasskey = passkeys.length > 0;
        } catch {
          passkeyCheckFailed = true;
          // hasPasskey remains false
        }
      }

      // If TOTP is not enabled AND passkey check failed → fail closed (no 2FA method confirmed)
      if (!hasTotp && passkeyCheckFailed) {
        throw new Error('Security state lookup failed');
      }

      if (hasTotp || hasPasskey) {
        // 2FA is enabled — require verification before granting access
        btn.innerHTML = `<div class="auth-spinner"></div><span>Verifying 2FA...</span>`;

        try {
          if (hasTotp && hasPasskey) {
            // Both methods available — show choice dialog
            await showLogin2FAChoice();
          } else if (hasPasskey) {
            // Passkey only — replace session then establish login assurance
            // SECURITY: Capture the user who authenticated with password BEFORE
            // the passkey ceremony replaces the session.
            const { data: { session: _prePasskeySession } } = await supabase.auth.getSession();
            const _originalUserId = _prePasskeySession?.user?.id;

            const passkeyData = await signInWithPasskey();

            // Cross-account protection: the passkey ceremony creates a new session
            // for the credential owner. If that doesn't match the password user,
            // a different account's passkey was used — reject immediately.
            // Fail-closed: if either user ID is missing, reject for safety.
            const _passkeyUserId = passkeyData?.session?.user?.id;
            if (!_originalUserId || !_passkeyUserId || _passkeyUserId !== _originalUserId) {
              await signOut().catch(() => {});
              throw new Error('Passkey does not belong to this account');
            }

            await establishPasskeyLoginAssurance();
          } else {
            // TOTP only — Edge Function establishes login assurance
            await TotpDialog({
              title: 'Two-Factor Authentication',
              message: 'Enter the 6-digit code from your authenticator app.',
              allowRecovery: true,
              mode: 'login',
              scope: 'login',
            });
          }
        } catch {
          // User cancelled LOGIN 2FA — sign out
          try { await signOut(); } catch { /* session may already be cleared */ }
          btn.disabled = false;
          btn.innerHTML = '<span>Sign In</span>';
          showError('2FA authentication is required. Login failed. Please login again.');
          return;
        }
      } else {
        // Case D: ZERO 2FA factors — mandatory 2FA setup before access
        try {
          await requireMandatory2FASetup(btn);
        } catch {
          try { await signOut(); } catch { /* session may already be cleared */ }
          btn.disabled = false;
          btn.innerHTML = '<span>Sign In</span>';
          showError('Two-factor authentication is required. Please login again.');
          return;
        }
      }
    } catch {
      // 2FA status check failed — sign out for security
      setLogin2faPending(false);
      await signOut();
      btn.disabled = false;
      btn.innerHTML = '<span>Sign In</span>';
      showError('Security check failed. Please try again.');
      return;
    }
    
    // All verification complete — populate currentUser and rebuild authenticated shell
    await completeLogin2FA();
    
    // Show success state
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
    setLogin2faPending(false);
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

/**
 * Login 2FA choice dialog — user picks Authenticator or Passkey.
 * Non-dismissable: outside click does nothing, Escape does nothing.
 * Cancel signs out.
 */
function showLogin2FAChoice() {
  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4';
    // Block outside click
    overlay.addEventListener('click', (e) => { if (e.target === overlay) return; });

    const modal = document.createElement('div');
    modal.className = 'card w-full max-w-sm p-6 step-enter';
    modal.innerHTML = `
      <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Two-Factor Authentication</h2>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">Choose how to verify your identity.</p>
      <div class="space-y-3">
        <button id="login-choose-totp" class="btn-secondary w-full text-left flex items-center gap-3 p-4">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-black/[0.04] dark:bg-white/[0.06]">
            <svg class="h-5 w-5 mt-0.5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-6 18.75h9m-9 0v-1.5m9 1.5v-1.5m-9 0h9"/></svg>
          </div>
          <div>
            <p class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">Authenticator Code</p>
            <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Enter 6-digit code from your app</p>
          </div>
        </button>
        <button id="login-choose-passkey" class="btn-secondary w-full text-left flex items-center gap-3 p-4">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-black/[0.04] dark:bg-white/[0.06]">
            <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25c2.25-1.5 3-3.75 3-5.25m3.75 0v-3m-3.75 3V12"/></svg>
          </div>
          <div>
            <p class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">Passkey</p>
            <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Use fingerprint, face recognition, or PIN</p>
          </div>
        </button>
      </div>
      <button id="login-2fa-cancel" class="btn-secondary w-full mt-4 text-red-600 dark:text-red-400">Cancel</button>
      <div id="login-2fa-error" class="hidden mt-3 rounded-xl bg-red-500/10 px-4 py-2.5 text-[13px] font-medium text-red-600 dark:text-red-400"></div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Block Escape
    const escHandler = (e) => { if (e.key === 'Escape') e.stopPropagation(); };
    document.addEventListener('keydown', escHandler, true);

    function cleanup() {
      document.removeEventListener('keydown', escHandler, true);
      overlay.remove();
    }

    const cancelBtn = modal.querySelector('#login-2fa-cancel');
    const errorEl = modal.querySelector('#login-2fa-error');
    const totpBtn = modal.querySelector('#login-choose-totp');
    const passkeyBtn = modal.querySelector('#login-choose-passkey');

    cancelBtn.addEventListener('click', async () => {
      cleanup();
      try { await signOut(); } catch { /* session may already be cleared */ }
      reject(new Error('cancelled'));
    });

    // ── TOTP choice ──
    totpBtn.addEventListener('click', async () => {
      cleanup();
      try {
        await TotpDialog({
          title: 'Authenticator Code',
          message: 'Enter the 6-digit code from your authenticator app.',
          allowRecovery: true,
          mode: 'login',
          scope: 'login',
        });
        resolve();
      } catch {
        reject(new Error('cancelled'));
      }
    });

    // ── Passkey choice ──
    passkeyBtn.addEventListener('click', async () => {
      passkeyBtn.disabled = true;
      passkeyBtn.innerHTML = `<div class="auth-spinner"></div><span>Verifying...</span>`;
      try {
        // SECURITY: Capture the user who authenticated with password BEFORE
        // the passkey ceremony replaces the session.
        const { data: { session: _prePasskeySession } } = await supabase.auth.getSession();
        const _originalUserId = _prePasskeySession?.user?.id;

        // Replace session with passkey-authenticated session
        const passkeyData = await signInWithPasskey();

        // Cross-account protection: the passkey ceremony creates a new session
        // for the credential owner. If that doesn't match the password user,
        // a different account's passkey was used — reject immediately.
        // Fail-closed: if either user ID is missing, reject for safety.
        const _passkeyUserId = passkeyData?.session?.user?.id;
        if (!_originalUserId || !_passkeyUserId || _passkeyUserId !== _originalUserId) {
          await signOut().catch(() => {});
          throw new Error('Passkey does not belong to this account');
        }

        // Establish login assurance (passkey ceremony is the proof)
        await establishPasskeyLoginAssurance();
        cleanup();
        resolve();
      } catch (err) {
        errorEl.textContent = err.message || 'Passkey verification failed';
        errorEl.classList.remove('hidden');
        passkeyBtn.disabled = false;
        passkeyBtn.innerHTML = `
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-black/[0.04] dark:bg-white/[0.06]">
            <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25c2.25-1.5 3-3.75 3-5.25m3.75 0v-3m-3.75 3V12"/></svg>
          </div>
          <div>
            <p class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">Passkey</p>
            <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Use fingerprint, face recognition, or PIN</p>
          </div>
        `;
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Mandatory 2FA Setup — Legacy zero-2FA users (Case D)
// ─────────────────────────────────────────────────────────────
// Non-dismissable overlay requiring TOTP or Passkey enrollment
// before granting normal application access.

async function requireMandatory2FASetup(btn) {
  return new Promise(async (resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) return; });

    const modal = document.createElement('div');
    modal.className = 'card w-full max-w-sm p-6 step-enter';
    const supportsPasskey = browserSupportsPasskeys();

    modal.innerHTML = `
      <div id="mandatory-method-select">
        <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Set Up Two-Factor Authentication</h2>
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">Your account requires two-factor authentication. Choose a method to continue.</p>
        <div class="space-y-3">
          <button id="mandatory-choose-authenticator" class="btn-secondary w-full text-left flex items-center gap-3 p-4">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-black/[0.04] dark:bg-white/[0.06]">
              <svg class="h-5 w-5 mt-0.5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-6 18.75h9m-9 0v-1.5m9 1.5v-1.5m-9 0h9"/></svg>
            </div>
            <div>
              <p class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">Authenticator App</p>
              <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Use Google Authenticator, Authy, or similar</p>
            </div>
          </button>
          ${supportsPasskey ? `
          <button id="mandatory-choose-passkey" class="btn-secondary w-full text-left flex items-center gap-3 p-4">
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-black/[0.04] dark:bg-white/[0.06]">
              <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25c2.25-1.5 3-3.75 3-5.25m3.75 0v-3m-3.75 3V12"/></svg>
            </div>
            <div>
              <p class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">Passkey</p>
              <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Use fingerprint, face recognition, or device PIN</p>
            </div>
          </button>
          ` : ''}
        </div>
        <button id="mandatory-cancel" class="btn-secondary w-full mt-4 text-red-600 dark:text-red-400">Cancel &amp; Sign Out</button>
      </div>
      <div id="mandatory-enroll-container" class="hidden"></div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const methodSelect = modal.querySelector('#mandatory-method-select');
    const enrollContainer = modal.querySelector('#mandatory-enroll-container');
    const cancelBtn = modal.querySelector('#mandatory-cancel');

    const escHandler = (e) => { if (e.key === 'Escape') e.stopPropagation(); };
    document.addEventListener('keydown', escHandler, true);

    async function handleCancel() {
      document.removeEventListener('keydown', escHandler, true);
      overlay.remove();
      reject(new Error('mandatory 2FA setup cancelled'));
    }

    cancelBtn.addEventListener('click', handleCancel);

    const authBtn = modal.querySelector('#mandatory-choose-authenticator');
    if (authBtn) {
      authBtn.addEventListener('click', async () => {
        methodSelect.classList.add('hidden');
        enrollContainer.classList.remove('hidden');
        try {
          // Await actual enrollment completion (user enters code + confirms)
          await new Promise((enrollResolve, enrollReject) => {
            runMandatoryTotpEnrollment(enrollContainer, enrollResolve, enrollReject);
          });
          document.removeEventListener('keydown', escHandler, true);
          overlay.remove();
          resolve();
        } catch (err) {
          enrollContainer.classList.add('hidden');
          methodSelect.classList.remove('hidden');
          const errorEl = methodSelect.querySelector('#mandatory-method-error');
          if (errorEl) {
            errorEl.textContent = err.message || 'Setup failed';
            errorEl.classList.remove('hidden');
          }
        }
      });
    }

    const passkeyBtn = modal.querySelector('#mandatory-choose-passkey');
    if (passkeyBtn) {
      passkeyBtn.addEventListener('click', async () => {
        methodSelect.classList.add('hidden');
        enrollContainer.classList.remove('hidden');
        try {
          // Await actual enrollment completion (user clicks Create + succeeds)
          await new Promise((enrollResolve, enrollReject) => {
            runMandatoryPasskeyEnrollment(enrollContainer, enrollResolve, enrollReject);
          });
          document.removeEventListener('keydown', escHandler, true);
          overlay.remove();
          resolve();
        } catch (err) {
          enrollContainer.classList.add('hidden');
          methodSelect.classList.remove('hidden');
          const errorEl = methodSelect.querySelector('#mandatory-method-error');
          if (errorEl) {
            errorEl.textContent = err.message || 'Setup failed';
            errorEl.classList.remove('hidden');
          }
        }
      });
    }
  });
}

async function runMandatoryTotpEnrollment(container, onComplete, onError) {
  container.innerHTML = `
    <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Authenticator Setup</h2>
    <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">Scan the QR code with your authenticator app.</p>
    <div class="flex justify-center mb-4">
      <div id="mandatory-qr-container" class="flex items-center justify-center" style="min-height: 200px;">
        <div class="auth-spinner"></div>
      </div>
    </div>
    <div class="card p-3 mb-4 bg-black/[0.03] dark:bg-white/[0.04]">
      <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark mb-1">Secret Key</p>
      <p id="mandatory-secret-key" class="font-mono text-[14px] text-text-primary dark:text-text-primary-dark break-all select-all">Loading...</p>
    </div>
    <label class="label" for="mandatory-totp-code">Verification Code</label>
    <input type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code"
      class="input-field text-center text-[20px] tracking-[0.3em] font-mono" placeholder="000000" id="mandatory-totp-code" />
    <div id="mandatory-enroll-error" class="hidden mt-2 text-[13px] text-red-600 dark:text-red-400"></div>
    <div class="flex gap-3 mt-4">
      <button id="mandatory-enroll-back" class="btn-secondary flex-1">Back</button>
      <button id="mandatory-enroll-confirm" class="btn-primary flex-1" disabled>Enable 2FA</button>
    </div>
  `;

  const qrContainer = container.querySelector('#mandatory-qr-container');
  const secretKeyEl = container.querySelector('#mandatory-secret-key');
  const input = container.querySelector('#mandatory-totp-code');
  const confirmBtn = container.querySelector('#mandatory-enroll-confirm');
  const backBtn = container.querySelector('#mandatory-enroll-back');
  const errorEl = container.querySelector('#mandatory-enroll-error');

  const { secret, qr_uri } = await begin2FAEnrollment();
  secretKeyEl.textContent = secret;
  await renderQRCode(qrContainer, qr_uri);

  input.addEventListener('input', () => {
    errorEl.classList.add('hidden');
    confirmBtn.disabled = input.value.trim().length < 6;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click();
  });
  backBtn.addEventListener('click', () => { throw new Error('back'); });

  confirmBtn.addEventListener('click', async () => {
    const code = input.value.trim();
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = `<div class="auth-spinner"></div><span>Verifying...</span>`;
    try {
      // verify-2fa-setup Edge Function establishes login assurance
      const result = await confirm2FAEnrollment(code);
      if (result.success) {
        confirmBtn.innerHTML = `
          <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
          <span>2FA Enabled</span>
        `;
        confirmBtn.classList.add('btn-success');
        confirmBtn.classList.remove('btn-primary');
        await new Promise(r => setTimeout(r, 800));
        // Signal completion to the awaiting caller
        if (onComplete) onComplete();
      }
    } catch (err) {
      errorEl.textContent = err.message || 'Invalid code';
      errorEl.classList.remove('hidden');
      confirmBtn.disabled = false;
      confirmBtn.classList.remove('btn-success');
      confirmBtn.classList.add('btn-primary');
      confirmBtn.innerHTML = '<span>Enable 2FA</span>';
      input.value = '';
      input.focus();
      if (onError) onError(err);
    }
  });

  input.focus();
}

async function runMandatoryPasskeyEnrollment(container, onComplete, onError) {
  container.innerHTML = `
    <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Passkey Setup</h2>
    <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">Register a passkey using your device's fingerprint, face recognition, or PIN.</p>
    <div class="card p-4 mb-4 bg-black/[0.03] dark:bg-white/[0.04]">
      <div class="flex items-center gap-3 mb-2">
        <svg class="h-6 w-6 text-action dark:text-action-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25c2.25-1.5 3-3.75 3-5.25m3.75 0v-3m-3.75 3V12"/></svg>
        <p class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">Your device will prompt you to verify</p>
      </div>
      <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">This could be Touch ID, Face ID, Windows Hello, or a security key.</p>
    </div>
    <div id="mandatory-passkey-error" class="hidden mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-600 dark:text-red-400"></div>
    <div class="flex gap-3">
      <button id="mandatory-passkey-back" class="btn-secondary flex-1">Back</button>
      <button id="mandatory-register-passkey" class="btn-primary flex-1">Create Passkey</button>
    </div>
  `;

  const registerBtn = container.querySelector('#mandatory-register-passkey');
  const backBtn = container.querySelector('#mandatory-passkey-back');
  const errorEl = container.querySelector('#mandatory-passkey-error');

  backBtn.addEventListener('click', () => { throw new Error('back'); });

  registerBtn.addEventListener('click', async () => {
    registerBtn.disabled = true;
    registerBtn.innerHTML = `<div class="auth-spinner"></div><span>Creating...</span>`;
    errorEl.classList.add('hidden');
    try {
      // registerPasskeyMandatory establishes login assurance internally
      await registerPasskeyMandatory();
      registerBtn.innerHTML = `
        <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
        </svg>
        <span>Passkey Created</span>
      `;
      registerBtn.classList.add('btn-success');
      registerBtn.classList.remove('btn-primary');
      await new Promise(r => setTimeout(r, 800));
      // Signal completion to the awaiting caller
      if (onComplete) onComplete();
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to create passkey';
      errorEl.classList.remove('hidden');
      registerBtn.disabled = false;
      registerBtn.classList.remove('btn-success');
      registerBtn.classList.add('btn-primary');
      registerBtn.innerHTML = '<span>Create Passkey</span>';
      if (onError) onError(err);
    }
  });
}
