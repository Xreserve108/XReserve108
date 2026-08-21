import { verify2FACode } from '@/core/totp';
import { signOut } from '@/core/auth';

/**
 * TOTP verification dialog.
 * Shows an overlay where user enters their 6-digit TOTP code.
 * Returns a Promise that resolves with verification_id on success.
 *
 * @param {Object} options
 * @param {string} options.title - Dialog title
 * @param {string} options.message - Description text
 * @param {boolean} options.allowRecovery - Allow recovery code input
 * @param {string} options.scope - Operation scope for the verification token
 * @param {'login'|'action'} options.mode - 'login' for login 2FA (no backdrop/Escape dismiss, Cancel signs out), 'action' for transaction 2FA (default)
 * @returns {Promise<string>} verification_id
 */
export function TotpDialog({ title = 'Verify Identity', message = 'Enter the 6-digit code from your authenticator app.', allowRecovery = true, scope, mode = 'action' } = {}) {
  const isLoginMode = mode === 'login';
  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4';

    const modal = document.createElement('div');
    modal.className = 'card w-full max-w-sm p-6 step-enter';
    modal.innerHTML = `
      <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">${title}</h2>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">${message}</p>
      <div class="relative mb-2">
      <input
        type="text"
        inputmode="numeric"
        maxlength="10"
        autocomplete="one-time-code"
        class="input-field text-center text-[20px] tracking-[0.3em] font-mono mb-2"
        placeholder="000000"
        id="totp-input"
        autofocus
      />
      <button type="button" id="totp-paste" class="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2.5 py-1 text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors" aria-label="Paste 2FA code">Paste</button>
      <div id="totp-error" class="hidden mb-3 rounded-xl bg-red-500/10 px-4 py-2.5 text-[13px] font-medium text-red-600 dark:text-red-400"></div>
      </div>
      <div class="flex gap-3 mt-4">
        <button id="totp-cancel" class="btn-secondary flex-1">Cancel</button>
        <button id="totp-verify" class="btn-primary flex-1" disabled>Verify</button>
      </div>
      ${allowRecovery ? `<button id="totp-recovery-toggle" class="mt-3 w-full text-center text-[12px] text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark transition-colors">Use recovery code instead</button>` : ''}
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const input = modal.querySelector('#totp-input');
    const verifyBtn = modal.querySelector('#totp-verify');
    const cancelBtn = modal.querySelector('#totp-cancel');
    const errorEl = modal.querySelector('#totp-error');
    const recoveryToggle = modal.querySelector('#totp-recovery-toggle');
    const pasteBtn = modal.querySelector('#totp-paste');
    let isRecoveryMode = false;

    function cleanup() {
      overlay.remove();
    }

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.classList.remove('hidden');
      verifyBtn.disabled = true;
      verifyBtn.classList.remove('btn-success');
      verifyBtn.classList.add('btn-primary');
      verifyBtn.innerHTML = '<span>Verify</span>';
    }

    function hideError() {
      errorEl.classList.add('hidden');
    }

    // Paste button is always enabled — the click handler (user gesture)
    // performs the clipboard read, which is the only reliable approach on iOS.
    // Background clipboard reads are NOT used because iOS blocks them without
    // a user gesture.

    input.addEventListener('input', () => {
      hideError();
      const val = input.value.trim();
      if (isRecoveryMode) {
        verifyBtn.disabled = val.length < 4;
      } else {
        verifyBtn.disabled = val.length < 6;
      }
      // Reset button to normal state if it was in success state
      if (verifyBtn.classList.contains('btn-success')) {
        verifyBtn.classList.remove('btn-success');
        verifyBtn.classList.add('btn-primary');
        verifyBtn.innerHTML = '<span>Verify</span>';
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !verifyBtn.disabled) {
        verifyBtn.click();
      }
    });

    pasteBtn.addEventListener('click', async () => {
      if (!navigator.clipboard?.readText) {
        showError('Unable to access clipboard. Please enter the code manually.');
        return;
      }
      try {
        const text = (await navigator.clipboard.readText()).trim();
        if (isRecoveryMode) {
          if (text.length < 4) {
            showError('Clipboard does not contain a valid recovery code.');
            return;
          }
        } else {
          if (!/^\d{6}$/.test(text)) {
            showError('Clipboard does not contain a valid 6-digit code.');
            return;
          }
        }
        hideError();
        input.value = text;
        input.dispatchEvent(new Event('input'));
        pasteBtn.style.display = 'none';
        verifyBtn.click();
      } catch (err) {
        showError('Unable to access clipboard. Please enter the code manually.');
      }
    });

    cancelBtn.addEventListener('click', async () => {
      if (isLoginMode) {
        // LOGIN 2FA: Cancel abandons the login attempt entirely
        try { await signOut(); } catch { /* session may already be cleared */ }
      }
      cleanup();
      reject(new Error('cancelled'));
    });

    // LOGIN 2FA: backdrop click is a true modal barrier — do nothing
    if (!isLoginMode) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          cleanup();
          reject(new Error('cancelled'));
        }
      });
    }

    // LOGIN 2FA: Escape key must not dismiss the dialog
    if (!isLoginMode) {
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          cleanup();
          reject(new Error('cancelled'));
        }
      };
      document.addEventListener('keydown', escHandler);
      // Store reference for cleanup
      const origCleanup = cleanup;
      cleanup = () => {
        document.removeEventListener('keydown', escHandler);
        origCleanup();
      };
    }

    if (recoveryToggle) {
      recoveryToggle.addEventListener('click', () => {
        isRecoveryMode = !isRecoveryMode;
        if (isRecoveryMode) {
          input.placeholder = 'Recovery code';
          input.maxLength = 10;
          input.inputMode = 'text';
          recoveryToggle.textContent = 'Use authenticator code instead';
          pasteBtn.style.display = 'none';
        } else {
          input.placeholder = '000000';
          input.maxLength = 10;
          input.inputMode = 'numeric';
          recoveryToggle.textContent = 'Use recovery code instead';
          pasteBtn.style.display = '';
        }
        input.value = '';
        verifyBtn.disabled = true;
        hideError();
        input.focus();
      });
    }

    verifyBtn.addEventListener('click', async () => {
      const code = input.value.trim();
      if (!code) return;

      verifyBtn.disabled = true;
      verifyBtn.innerHTML = `<div class="auth-spinner"></div><span>Verifying...</span>`;
      hideError();

      try {
        const verificationId = await verify2FACode(code, scope);
        
        // Show success state
        verifyBtn.innerHTML = `
          <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
          </svg>
          <span>Verification Complete</span>
        `;
        verifyBtn.classList.add('btn-success');
        verifyBtn.classList.remove('btn-primary');
        
        // Disable all inputs during success animation
        input.disabled = true;
        cancelBtn.disabled = true;
        
        // Wait for success animation, then close
        await new Promise(resolve => setTimeout(resolve, 800));
        cleanup();
        resolve(verificationId);
      } catch (err) {
        showError(err.message || 'Invalid code');
        input.value = '';
        pasteBtn.style.display = '';
        input.focus();
      }
    });

    // Focus input after render
    setTimeout(() => input.focus(), 100);
  });
}

/**
 * Helper: Run TOTP verification and return verification_id.
 * Wraps TotpDialog with sensible defaults.
 * @param {string} context - Description for the verification
 * @param {string} scope - Operation scope (e.g. 'user_transaction', 'admin_financial')
 */
export async function requireVerification(context = 'Verify your identity', scope) {
  return TotpDialog({ title: context, message: 'Enter your authenticator code to continue.', scope });
}
