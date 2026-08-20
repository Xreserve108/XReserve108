import { signUpWithUsername, isAuthenticated, signOut } from '@/core/auth';
import { navigate } from '@/core/router';
import { validateUsername } from '@/core/username';
import { supabase } from '@/lib/supabase';
import { get2FAStatus, begin2FAEnrollment, confirm2FAEnrollment, renderQRCode } from '@/core/totp';

export function renderSignUp() {
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
      // If status check fails, still try to navigate but user will be prompted later
    }
    
    // Show final success before navigation
    btn.innerHTML = `
      <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
      </svg>
      <span>Welcome to XReserve</span>
    `;
    
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
 * Enforce 2FA setup immediately after signup
 * Blocks navigation until 2FA is enabled or user cancels (signs out)
 */
async function enforce2FASetup() {
  return new Promise(async (resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4';
    
    const modal = document.createElement('div');
    modal.className = 'card w-full max-w-sm p-6 step-enter';
    modal.innerHTML = `
      <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Set Up Two-Factor Authentication</h2>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">For your security, please set up two-factor authentication before continuing.</p>
      <div id="enroll-step-1">
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
          <button id="cancel-enroll" class="btn-secondary flex-1">Cancel</button>
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
    
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    
    const qrContainer = modal.querySelector('#qr-container');
    const secretKeyEl = modal.querySelector('#secret-key');
    const input = modal.querySelector('#totp-code');
    const confirmBtn = modal.querySelector('#confirm-enroll');
    const cancelBtn = modal.querySelector('#cancel-enroll');
    const errorEl = modal.querySelector('#enroll-error');
    const step1 = modal.querySelector('#enroll-step-1');
    const step2 = modal.querySelector('#enroll-step-2');
    const recoveryCodesEl = modal.querySelector('#recovery-codes');
    const continueBtn = modal.querySelector('#continue-btn');
    
    try {
      // Begin enrollment
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
      
      cancelBtn.addEventListener('click', async () => {
        // User cancelled - sign out
        overlay.remove();
        await signOut();
        reject(new Error('2FA setup cancelled'));
      });
      
      confirmBtn.addEventListener('click', async () => {
        const code = input.value.trim();
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = `<div class="auth-spinner"></div><span>Verifying...</span>`;
        
        try {
          const result = await confirm2FAEnrollment(code);
          if (result.success) {
            // Show success state on button before transitioning
            confirmBtn.innerHTML = `
              <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
              </svg>
              <span>2FA Enabled</span>
            `;
            confirmBtn.classList.add('btn-success');
            confirmBtn.classList.remove('btn-primary');
            
            // Wait briefly for success animation
            await new Promise(resolve => setTimeout(resolve, 600));
            
            // Show recovery codes
            step1.classList.add('hidden');
            step2.classList.remove('hidden');
            
            // Display recovery codes
            if (result.recovery_codes && result.recovery_codes.length > 0) {
              recoveryCodesEl.innerHTML = result.recovery_codes.map(code => 
                `<div class="select-all">${code}</div>`
              ).join('');
            }
            
            continueBtn.addEventListener('click', () => {
              // Show success state on continue button
              continueBtn.innerHTML = `
                <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                </svg>
                <span>Setup Complete</span>
              `;
              continueBtn.classList.add('btn-success');
              continueBtn.classList.remove('btn-primary');
              continueBtn.disabled = true;
              
              // Wait for animation, then close
              setTimeout(() => {
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
    } catch (err) {
      overlay.remove();
      await signOut();
      reject(err);
    }
  });
}
