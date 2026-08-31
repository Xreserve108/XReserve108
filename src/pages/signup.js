import { signUpWithUsername, isAuthenticated, signOut } from '@/core/auth';
import { navigate } from '@/core/router';
import { validateUsername } from '@/core/username';
import { supabase } from '@/lib/supabase';
import { get2FAStatus, begin2FAEnrollment, confirm2FAEnrollment, renderQRCode } from '@/core/totp';
import { registerPasskeySignup, browserSupportsPasskeys } from '@/core/passkey';

export function renderSignUp() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col items-center justify-center px-5 pb-24 md:pb-8';

  if (isAuthenticated()) {
    navigate('home');
    return page;
  }

  // Detect referral code from URL hash (e.g., #/signup?ref=CODE)
  const refCode = detectReferralCode();

  page.innerHTML = `
    <div class="w-full max-w-[360px] text-center">
      <div class="mx-auto mb-8 flex h-14 w-14 items-center justify-center rounded-2xl bg-action dark:bg-action-dark">
        <svg class="h-6 w-6 text-white dark:text-background-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/></svg>
      </div>

      <h1 class="page-title mb-2">Create Account</h1>
      <p class="text-muted mb-8">Sign up to access your USDT wallet, deposit funds, and sell for INR.</p>

      <form id="signup-form" class="space-y-4">
        <div class="text-left">
          <label for="signup-username" class="mb-1.5 block text-[13px] font-medium text-text-primary dark:text-text-primary-dark">Username</label>
          <input 
            id="signup-username" 
            type="text" 
            autocomplete="username"
            class="input-field w-full" 
            placeholder="e.g. john_doe"
            required
          />
          <p id="username-hint" class="mt-1 text-[11px] text-text-secondary dark:text-text-secondary-dark">3-24 characters, letters, numbers, dots, underscores only</p>
        </div>

        <div class="text-left">
          <label for="signup-password" class="mb-1.5 block text-[13px] font-medium text-text-primary dark:text-text-primary-dark">Password</label>
          <input 
            id="signup-password" 
            type="password" 
            autocomplete="new-password"
            class="input-field w-full" 
            placeholder="Minimum 6 characters"
            required
            minlength="6"
          />
        </div>

        <div class="text-left">
          <label for="signup-confirm-password" class="mb-1.5 block text-[13px] font-medium text-text-primary dark:text-text-primary-dark">Confirm Password</label>
          <input 
            id="signup-confirm-password" 
            type="password" 
            autocomplete="new-password"
            class="input-field w-full" 
            placeholder="Re-enter your password"
            required
          />
        </div>

        <div class="text-left">
          <label for="signup-referral-code" class="mb-1.5 block text-[13px] font-medium text-text-primary dark:text-text-primary-dark">Referral Code <span class="font-normal text-text-secondary dark:text-text-secondary-dark">(optional)</span></label>
          <input 
            id="signup-referral-code" 
            type="text" 
            class="input-field w-full font-mono uppercase tracking-wider" 
            placeholder="e.g. AB12CD34"
            maxlength="8"
            value="${refCode || ''}"
          />
        </div>

        <button id="signup-btn" type="submit" class="btn-primary flex w-full items-center justify-center gap-2 min-h-[48px]">
          <span>Create Account</span>
        </button>
      </form>

      <div id="signup-error" class="hidden mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-600 dark:border-red-800/50 dark:bg-red-900/20 dark:text-red-400">
        <p id="signup-error-msg"></p>
      </div>

      <p class="mt-8 text-[13px] text-text-secondary dark:text-text-secondary-dark">
        Already have an account? <a href="#signin" class="font-medium text-action hover:underline dark:text-action-dark">Sign in</a>
      </p>

      <p class="mt-6 text-[12px] leading-relaxed text-text-secondary dark:text-text-secondary-dark">
        By signing up, you agree to the terms of service.
      </p>
    </div>
  `;

  setupSignUpHandlers(page);
  return page;
}

/**
 * Detect referral code from URL hash.
 * Supports format: #/signup?ref=CODE or #signup?ref=CODE
 */
function detectReferralCode() {
  try {
    const hash = window.location.hash.slice(1); // Remove #
    const queryPart = hash.split('?')[1];
    if (!queryPart) return null;
    
    const params = new URLSearchParams(queryPart);
    const ref = params.get('ref');
    
    // Validate format: 8 alphanumeric chars
    if (ref && typeof ref === 'string' && ref.length === 8 && /^[A-Za-z0-9]+$/.test(ref)) {
      return ref.toUpperCase();
    }
  } catch {
    // Ignore parsing errors
  }
  return null;
}

function setupSignUpHandlers(page) {
  const form = page.querySelector('#signup-form');
  if (form) {
    form.addEventListener('submit', handleSignUp);
  }
  
  // Real-time username validation
  const usernameInput = page.querySelector('#signup-username');
  const usernameHint = page.querySelector('#username-hint');
  if (usernameInput && usernameHint) {
    usernameInput.addEventListener('input', () => {
      const result = validateUsername(usernameInput.value);
      if (usernameInput.value.length === 0) {
        usernameHint.textContent = '3-24 characters, letters, numbers, dots, underscores only';
        usernameHint.className = 'mt-1 text-[11px] text-text-secondary dark:text-text-secondary-dark';
      } else if (!result.valid) {
        usernameHint.textContent = result.error;
        usernameHint.className = 'mt-1 text-[11px] text-red-500 dark:text-red-400';
      } else {
        usernameHint.textContent = '✓ Username available';
        usernameHint.className = 'mt-1 text-[11px] text-green-600 dark:text-green-400';
      }
    });
  }
}

async function handleSignUp(e) {
  e.preventDefault();
  
  const btn = document.getElementById('signup-btn');
  const usernameInput = document.getElementById('signup-username');
  const passwordInput = document.getElementById('signup-password');
  const confirmPasswordInput = document.getElementById('signup-confirm-password');
  
  if (!btn || btn.disabled) return;
  
  const username = usernameInput?.value || '';
  const password = passwordInput?.value || '';
  const confirmPassword = confirmPasswordInput?.value || '';
  
  // Capture referral code early (before 2FA modal may remove the form from DOM)
  const referralInput = document.getElementById('signup-referral-code');
  const referralCode = referralInput?.value?.trim()?.toUpperCase() || '';
  
  // Validate username
  const usernameValidation = validateUsername(username);
  if (!usernameValidation.valid) {
    showError(usernameValidation.error);
    return;
  }
  
  // Validate password
  if (password.length < 6) {
    showError('Password must be at least 6 characters');
    return;
  }
  
  // Validate password match
  if (password !== confirmPassword) {
    showError('Passwords do not match');
    return;
  }
  
  btn.disabled = true;
  btn.innerHTML = `<div class="auth-spinner"></div><span>Creating account...</span>`;
  hideError();
  
  try {
    // Check username availability first
    const { data: isAvailable } = await supabase.rpc('check_username_available', {
      p_username: username.trim()
    });
    
    if (!isAvailable) {
      showError('Username is already taken');
      btn.disabled = false;
      btn.innerHTML = '<span>Create Account</span>';
      return;
    }
    
    // Sign up
    await signUpWithUsername(username, password);
    
    // Show account created success
    btn.innerHTML = `
      <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
      </svg>
      <span>Account Created</span>
    `;
    btn.classList.add('btn-success');
    btn.classList.remove('btn-primary');
    
    // Wait briefly for success animation
    await new Promise(resolve => setTimeout(resolve, 600));
    
    // Check if 2FA is enabled - if not, force setup
    try {
      const status = await get2FAStatus();
      if (!status.enabled) {
        // 2FA not enabled - force enrollment before allowing navigation
        await enforce2FASetup();
      }
    } catch {
      // Fail closed: if status check or enrollment fails, sign out for security
      try { await signOut(); } catch { /* session may already be cleared */ }
      showError('Security check failed. Please try again.');
      btn.disabled = false;
      btn.classList.remove('btn-success');
      btn.classList.add('btn-primary');
      btn.innerHTML = '<span>Create Account</span>';
      return;
    }
    
    // Show final success before navigation
    btn.innerHTML = `
      <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
      </svg>
      <span>Welcome to XReserve</span>
    `;
    
    // Attempt referral code redemption (non-blocking)
    // This must NOT break signup - failures are logged but don't prevent navigation
    try {
      if (referralCode && referralCode.length === 8 && /^[A-Z0-9]{8}$/.test(referralCode)) {
        const { error } = await supabase.rpc('redeem_referral_code', {
          p_code: referralCode,
        });
        if (error) {
          console.warn('Referral redemption failed:', error.message);
        }
      }
    } catch (refErr) {
      // Non-blocking: log but don't show error or prevent navigation
      console.warn('Referral redemption error:', refErr);
    }
    
    // Wait for success animation, then navigate
    await new Promise(resolve => setTimeout(resolve, 800));
    navigate('home');
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove('btn-success');
    btn.classList.add('btn-primary');
    btn.innerHTML = '<span>Create Account</span>';
    
    // Map Supabase errors to user-friendly messages
    let errorMessage = 'Failed to create account. Please try again.';
    if (err.message?.includes('already registered')) {
      errorMessage = 'Username is already taken';
    } else if (err.message?.includes('Password')) {
      errorMessage = err.message;
    }
    
    showError(errorMessage);
  }
}

function showError(msg) {
  const el = document.getElementById('signup-error');
  const msgEl = document.getElementById('signup-error-msg');
  if (el && msgEl) {
    msgEl.textContent = msg;
    el.classList.remove('hidden');
  }
}

function hideError() {
  const el = document.getElementById('signup-error');
  if (el) el.classList.add('hidden');
}

/**
 * Enforce 2FA setup immediately after signup.
 * Blocks navigation until 2FA is enabled or user cancels (signs out).
 * User must choose Authenticator OR Passkey. No skip/dismiss allowed.
 */
async function enforce2FASetup() {
  return new Promise(async (resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4';
    // Block outside click and Escape
    overlay.addEventListener('click', (e) => { if (e.target === overlay) return; });

    const modal = document.createElement('div');
    modal.className = 'card w-full max-w-sm p-6 step-enter';

    const supportsPasskey = browserSupportsPasskeys();

    modal.innerHTML = `
      <div id="method-select">
        <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Set Up Two-Factor Authentication</h2>
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">Choose how to protect your account with two-factor authentication.</p>
        <div class="space-y-3">
          <button id="choose-authenticator" class="btn-secondary w-full text-left flex items-center gap-3 p-4">
            <div class="flex h-10 w-10 shrink-0 items-center justify-start pl-2 rounded-xl bg-black/[0.04] dark:bg-white/[0.06]">
              <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">Authenticator App</p>
              <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Use Google Authenticator, Authy, or similar</p>
            </div>
          </button>
          ${supportsPasskey ? `
          <button id="choose-passkey" class="btn-secondary w-full text-left flex items-center gap-3 p-4">
            <div class="flex h-10 w-10 shrink-0 items-center justify-start pl-2 rounded-xl bg-black/[0.04] dark:bg-white/[0.06]">
              <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M7.864 4.243A7.5 7.5 0 0119.5 12c0 2.07-.84 3.94-2.197 5.303m-2.197-5.303A4.5 4.5 0 0012 7.5a4.5 4.5 0 00-3.106 4.5m6.212 0A7.478 7.478 0 0112 16.5a7.478 7.478 0 01-3.106-4.5m6.212 0c.39.39.72.84.97 1.337M8.894 12A4.486 4.486 0 0112 7.5a4.486 4.486 0 013.106 4.5m-6.212 0c-.39.39-.72.84-.97 1.337M12 16.5v1.5m-3.536-1.06A7.478 7.478 0 014.5 12c0-1.04.213-2.03.597-2.933"/></svg>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">Passkey</p>
              <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Use fingerprint, face recognition, or device PIN</p>
            </div>
          </button>
          ` : ''}
        </div>
        <button id="cancel-setup" class="btn-secondary w-full mt-4 text-red-600 dark:text-red-400">Cancel &amp; Sign Out</button>
      </div>
      <div id="enroll-container" class="hidden"></div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const methodSelect = modal.querySelector('#method-select');
    const enrollContainer = modal.querySelector('#enroll-container');
    const cancelBtn = modal.querySelector('#cancel-setup');

    // Block Escape key
    const escHandler = (e) => { if (e.key === 'Escape') e.stopPropagation(); };
    document.addEventListener('keydown', escHandler, true);

    async function handleCancel() {
      document.removeEventListener('keydown', escHandler, true);
      overlay.remove();
      await signOut();
      reject(new Error('2FA setup cancelled'));
    }

    cancelBtn.addEventListener('click', handleCancel);

    // ── Authenticator choice ──
    const authBtn = modal.querySelector('#choose-authenticator');
    if (authBtn) {
      authBtn.addEventListener('click', async () => {
        methodSelect.classList.add('hidden');
        enrollContainer.classList.remove('hidden');
        try {
          await runTotpEnrollment(enrollContainer, overlay, resolve, reject, escHandler);
        } catch (err) {
          document.removeEventListener('keydown', escHandler, true);
          overlay.remove();
          await signOut();
          reject(err);
        }
      });
    }

    // ── Passkey choice ──
    const passkeyBtn = modal.querySelector('#choose-passkey');
    if (passkeyBtn) {
      passkeyBtn.addEventListener('click', async () => {
        methodSelect.classList.add('hidden');
        enrollContainer.classList.remove('hidden');
        try {
          await runPasskeyEnrollment(enrollContainer, overlay, resolve, reject, escHandler);
        } catch (err) {
          document.removeEventListener('keydown', escHandler, true);
          overlay.remove();
          await signOut();
          reject(err);
        }
      });
    }
  });
}

/**
 * TOTP enrollment flow (existing behavior, extracted).
 */
async function runTotpEnrollment(container, overlay, resolve, reject, escHandler) {
  container.innerHTML = `
    <div id="enroll-step-1">
      <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Authenticator Setup</h2>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">Scan the QR code with your authenticator app.</p>
      <div class="flex justify-center mb-4">
        <div id="qr-container" class="flex items-center justify-center" style="min-height: 200px;">
          <div class="auth-spinner"></div>
        </div>
      </div>
      <div class="card p-3 mb-4 bg-black/[0.03] dark:bg-white/[0.04]">
        <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark mb-1">Secret Key</p>
        <p id="secret-key" class="font-mono text-[14px] text-text-primary dark:text-text-primary-dark break-all select-all">Loading...</p>
      </div>
      <label class="label" for="totp-code">Verification Code</label>
      <input type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code"
        class="input-field text-center text-[20px] tracking-[0.3em] font-mono" placeholder="000000" id="totp-code" />
      <div id="enroll-error" class="hidden mt-2 text-[13px] text-red-600 dark:text-red-400"></div>
      <div class="flex gap-3 mt-4">
        <button id="back-to-methods" class="btn-secondary flex-1">Back</button>
        <button id="confirm-enroll" class="btn-primary flex-1" disabled>Enable 2FA</button>
      </div>
    </div>
    <div id="enroll-step-2" class="hidden">
      <div class="text-center py-6">
        <div class="mb-4 flex justify-center">
          <div class="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
            <svg class="h-8 w-8 text-green-600 dark:text-green-400 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          </div>
        </div>
        <h3 class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark mb-2">2FA Enabled Successfully</h3>
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">Your account is now protected with two-factor authentication.</p>
        <div class="card p-3 bg-black/[0.03] dark:bg-white/[0.04]">
          <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark mb-2">Recovery Codes</p>
          <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark mb-2">Save these codes in a safe place. Each code can only be used once.</p>
          <div id="recovery-codes" class="font-mono text-[13px] text-text-primary dark:text-text-primary-dark space-y-1"></div>
        </div>
        <button id="continue-btn" class="btn-primary w-full mt-4">Continue</button>
      </div>
    </div>
  `;

  const qrContainer = container.querySelector('#qr-container');
  const secretKeyEl = container.querySelector('#secret-key');
  const input = container.querySelector('#totp-code');
  const confirmBtn = container.querySelector('#confirm-enroll');
  const backBtn = container.querySelector('#back-to-methods');
  const errorEl = container.querySelector('#enroll-error');
  const step1 = container.querySelector('#enroll-step-1');
  const step2 = container.querySelector('#enroll-step-2');
  const recoveryCodesEl = container.querySelector('#recovery-codes');
  const continueBtn = container.querySelector('#continue-btn');

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

  backBtn.addEventListener('click', () => {
    container.classList.add('hidden');
    container.closest('.card').querySelector('#method-select').classList.remove('hidden');
  });

  confirmBtn.addEventListener('click', async () => {
    const code = input.value.trim();
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = `<div class="auth-spinner"></div><span>Verifying...</span>`;

    try {
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

        await new Promise(r => setTimeout(r, 600));

        step1.classList.add('hidden');
        step2.classList.remove('hidden');

        if (result.recovery_codes && result.recovery_codes.length > 0) {
          recoveryCodesEl.innerHTML = result.recovery_codes.map(c =>
            `<div class="select-all">${c}</div>`
          ).join('');
        }

        continueBtn.addEventListener('click', () => {
          continueBtn.innerHTML = `
            <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
            <span>Setup Complete</span>
          `;
          continueBtn.classList.add('btn-success');
          continueBtn.classList.remove('btn-primary');
          continueBtn.disabled = true;

          setTimeout(() => {
            document.removeEventListener('keydown', escHandler, true);
            overlay.remove();
            resolve();
          }, 600);
        });
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
    }
  });

  input.focus();
}

/**
 * Passkey enrollment flow (signup-time).
 */
async function runPasskeyEnrollment(container, overlay, resolve, reject, escHandler) {
  container.innerHTML = `
    <div id="passkey-step-1">
      <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Passkey Setup</h2>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">Register a passkey using your device's fingerprint, face recognition, or PIN.</p>
      <div class="card p-4 mb-4 bg-black/[0.03] dark:bg-white/[0.04]">
        <div class="flex items-center gap-3 mb-2">
          <svg class="h-6 w-6 text-action dark:text-action-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25c2.25-1.5 3-3.75 3-5.25m3.75 0v-3m-3.75 3V12"/></svg>
          <p class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">Your device will prompt you to verify</p>
        </div>
        <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">This could be Touch ID, Face ID, Windows Hello, or a security key.</p>
      </div>
      <div id="passkey-error" class="hidden mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-[13px] font-medium text-red-600 dark:text-red-400"></div>
      <div class="flex gap-3">
        <button id="back-to-methods" class="btn-secondary flex-1">Back</button>
        <button id="register-passkey-btn" class="btn-primary flex-1">Create Passkey</button>
      </div>
    </div>
    <div id="passkey-step-2" class="hidden">
      <div class="text-center py-6">
        <div class="mb-4 flex justify-center">
          <div class="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
            <svg class="h-8 w-8 text-green-600 dark:text-green-400 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
          </div>
        </div>
        <h3 class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark mb-2">Passkey Registered</h3>
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">Your account is now protected with passkey authentication.</p>
        <button id="continue-btn" class="btn-primary w-full">Continue</button>
      </div>
    </div>
  `;

  const registerBtn = container.querySelector('#register-passkey-btn');
  const backBtn = container.querySelector('#back-to-methods');
  const errorEl = container.querySelector('#passkey-error');
  const step1 = container.querySelector('#passkey-step-1');
  const step2 = container.querySelector('#passkey-step-2');
  const continueBtn = container.querySelector('#continue-btn');

  backBtn.addEventListener('click', () => {
    container.classList.add('hidden');
    container.closest('.card').querySelector('#method-select').classList.remove('hidden');
  });

  registerBtn.addEventListener('click', async () => {
    registerBtn.disabled = true;
    registerBtn.innerHTML = `<div class="auth-spinner"></div><span>Creating...</span>`;
    errorEl.classList.add('hidden');

    try {
      await registerPasskeySignup();

      registerBtn.innerHTML = `
        <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
        </svg>
        <span>Passkey Created</span>
      `;
      registerBtn.classList.add('btn-success');
      registerBtn.classList.remove('btn-primary');

      await new Promise(r => setTimeout(r, 600));

      step1.classList.add('hidden');
      step2.classList.remove('hidden');

      continueBtn.addEventListener('click', () => {
        continueBtn.innerHTML = `
          <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
          <span>Setup Complete</span>
        `;
        continueBtn.classList.add('btn-success');
        continueBtn.disabled = true;

        setTimeout(() => {
          document.removeEventListener('keydown', escHandler, true);
          overlay.remove();
          resolve();
        }, 600);
      });
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to create passkey';
      errorEl.classList.remove('hidden');
      registerBtn.disabled = false;
      registerBtn.classList.remove('btn-success');
      registerBtn.classList.add('btn-primary');
      registerBtn.innerHTML = '<span>Create Passkey</span>';
    }
  });
}
