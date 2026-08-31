import { verify2FACode, get2FAStatus } from '@/core/totp';
import { verifyPasskeyAction, browserSupportsPasskeys, listPasskeys } from '@/core/passkey';
import { signOut } from '@/core/auth';

/**
 * Unified verification dialog — supports both TOTP and Passkey.
 * Shows an overlay where user verifies via authenticator code or passkey.
 * Returns a Promise that resolves with verification_id on success.
 *
 * @param {Object} options
 * @param {string} options.title - Dialog title
 * @param {string} options.message - Description text
 * @param {boolean} options.allowRecovery - Allow recovery code input (TOTP only)
 * @param {string} options.scope - Operation scope for the verification token
 * @param {'login'|'action'} options.mode - 'login' for login 2FA (no backdrop/Escape dismiss, Cancel signs out), 'action' for transaction 2FA (default)
 * @returns {Promise<string>} verification_id
 */
export function TotpDialog({ title = 'Verify Identity', message = 'Enter the 6-digit code from your authenticator app.', allowRecovery = true, scope, mode = 'action' } = {}) {
  const isLoginMode = mode === 'login';
  return new Promise(async (resolve, reject) => {
    // ── Detect available 2FA methods ──
    let hasTotp = false;
    let hasPasskey = false;

    try {
      const status = await get2FAStatus();
      hasTotp = status.enabled;
    } catch { /* ignore */ }

    if (browserSupportsPasskeys()) {
      try {
        const passkeys = await listPasskeys();
        hasPasskey = passkeys.length > 0;
      } catch { /* ignore */ }
    }

    // If neither method is available (shouldn't happen), reject
    if (!hasTotp && !hasPasskey) {
      reject(new Error('No 2FA method configured'));
      return;
    }

    const showMethodChoice = hasTotp && hasPasskey;
    // Default to TOTP if both available (backward compatible)
    let activeMethod = hasTotp ? 'totp' : 'passkey';

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4';

    const modal = document.createElement('div');
    modal.className = 'card w-full max-w-sm p-6 step-enter';
    modal.innerHTML = buildDialogHTML({ title, message, allowRecovery, showMethodChoice, activeMethod, hasTotp, hasPasskey });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // ── DOM references ──
    const input = modal.querySelector('#totp-input');
    const verifyBtn = modal.querySelector('#totp-verify');
    const cancelBtn = modal.querySelector('#totp-cancel');
    const errorEl = modal.querySelector('#totp-error');
    const recoveryToggle = modal.querySelector('#totp-recovery-toggle');
    const pasteBtn = modal.querySelector('#totp-paste');
    const totpSection = modal.querySelector('#totp-section');
    const passkeySection = modal.querySelector('#passkey-section');
    const methodTabs = modal.querySelector('#method-tabs');
    const tabTotp = modal.querySelector('#tab-totp');
    const tabPasskey = modal.querySelector('#tab-passkey');
    const passkeyBtn = modal.querySelector('#passkey-verify-btn');

    let isRecoveryMode = false;

    function cleanup() {
      overlay.remove();
    }

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.classList.remove('hidden');
      if (verifyBtn) {
        verifyBtn.disabled = true;
        verifyBtn.classList.remove('btn-success');
        verifyBtn.classList.add('btn-primary');
        verifyBtn.innerHTML = '<span>Verify</span>';
      }
    }

    function hideError() {
      errorEl.classList.add('hidden');
    }

    function switchMethod(method) {
      activeMethod = method;
      hideError();
      if (totpSection) totpSection.classList.toggle('hidden', method !== 'totp');
      if (passkeySection) passkeySection.classList.toggle('hidden', method !== 'passkey');
      if (tabTotp) {
        tabTotp.classList.toggle('!bg-action/10', method === 'totp');
        tabTotp.classList.toggle('dark:!bg-action-dark/20', method === 'totp');
      }
      if (tabPasskey) {
        tabPasskey.classList.toggle('!bg-action/10', method === 'passkey');
        tabPasskey.classList.toggle('dark:!bg-action-dark/20', method === 'passkey');
      }
      if (method === 'totp' && input) input.focus();
    }

    // ── Method tabs ──
    if (tabTotp) tabTotp.addEventListener('click', () => switchMethod('totp'));
    if (tabPasskey) tabPasskey.addEventListener('click', () => switchMethod('passkey'));

    // ── TOTP input handlers ──
    if (input) {
      input.addEventListener('input', () => {
        hideError();
        const val = input.value.trim();
        if (isRecoveryMode) {
          verifyBtn.disabled = val.length < 4;
        } else {
          verifyBtn.disabled = val.length < 6;
        }
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
    }

    // ── Paste button ──
    if (pasteBtn) {
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
        } catch {
          showError('Unable to access clipboard. Please enter the code manually.');
        }
      });
    }

    // ── Cancel ──
    cancelBtn.addEventListener('click', async () => {
      if (isLoginMode) {
        try { await signOut(); } catch { /* session may already be cleared */ }
      }
      cleanup();
      reject(new Error('cancelled'));
    });

    // ── Backdrop click (action mode only) ──
    if (!isLoginMode) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          cleanup();
          reject(new Error('cancelled'));
        }
      });
    }

    // ── Escape key (action mode only) ──
    if (!isLoginMode) {
      const escHandler = (e) => {
        if (e.key === 'Escape') {
          cleanup();
          reject(new Error('cancelled'));
        }
      };
      document.addEventListener('keydown', escHandler);
      const origCleanup = cleanup;
      cleanup = () => {
        document.removeEventListener('keydown', escHandler);
        origCleanup();
      };
    }

    // ── Recovery toggle ──
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

    // ── TOTP verify ──
    if (verifyBtn) {
      verifyBtn.addEventListener('click', async () => {
        const code = input.value.trim();
        if (!code) return;

        verifyBtn.disabled = true;
        verifyBtn.innerHTML = `<div class="auth-spinner"></div><span>Verifying...</span>`;
        hideError();

        try {
          const verificationId = await verify2FACode(code, scope);

          verifyBtn.innerHTML = `
            <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
            <span>Verification Complete</span>
          `;
          verifyBtn.classList.add('btn-success');
          verifyBtn.classList.remove('btn-primary');

          input.disabled = true;
          cancelBtn.disabled = true;

          await new Promise(resolve => setTimeout(resolve, 800));
          cleanup();
          resolve(verificationId);
        } catch (err) {
          showError(err.message || 'Invalid code');
          input.value = '';
          if (pasteBtn) pasteBtn.style.display = '';
          input.focus();
        }
      });
    }

    // ── Passkey verify ──
    if (passkeyBtn) {
      passkeyBtn.addEventListener('click', async () => {
        passkeyBtn.disabled = true;
        passkeyBtn.innerHTML = `<div class="auth-spinner"></div><span>Verifying...</span>`;
        hideError();

        try {
          const verificationId = await verifyPasskeyAction(scope);

          passkeyBtn.innerHTML = `
            <svg class="h-5 w-5 animate-success-check" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
            <span>Verification Complete</span>
          `;
          passkeyBtn.classList.add('btn-success');
          passkeyBtn.classList.remove('btn-primary');

          cancelBtn.disabled = true;

          await new Promise(resolve => setTimeout(resolve, 800));
          cleanup();
          resolve(verificationId);
        } catch (err) {
          showError(err.message || 'Passkey verification failed');
          passkeyBtn.disabled = false;
          passkeyBtn.innerHTML = `
            <svg class="h-5 w-5 mr-2" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25c2.25-1.5 3-3.75 3-5.25m3.75 0v-3m-3.75 3V12"/></svg>
            <span>Use Passkey</span>
          `;
        }
      });
    }

    // ── Focus input after render ──
    if (activeMethod === 'totp' && input) {
      setTimeout(() => input.focus(), 100);
    }
  });
}

/**
 * Build dialog HTML based on available methods.
 */
function buildDialogHTML({ title, message, allowRecovery, showMethodChoice, activeMethod, hasTotp, hasPasskey }) {
  let methodTabsHTML = '';
  if (showMethodChoice) {
    methodTabsHTML = `
      <div id="method-tabs" class="flex gap-2 mb-4">
        ${hasTotp ? `<button id="tab-totp" class="flex-1 rounded-xl px-3 py-2 text-[13px] font-medium transition-colors ${activeMethod === 'totp' ? 'bg-action/10 text-action dark:bg-action-dark/20 dark:text-action-dark' : 'bg-black/[0.03] text-text-secondary dark:bg-white/[0.04] dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark'}">Authenticator</button>` : ''}
        ${hasPasskey ? `<button id="tab-passkey" class="flex-1 rounded-xl px-3 py-2 text-[13px] font-medium transition-colors ${activeMethod === 'passkey' ? 'bg-action/10 text-action dark:bg-action-dark/20 dark:text-action-dark' : 'bg-black/[0.03] text-text-secondary dark:bg-white/[0.04] dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark'}">Passkey</button>` : ''}
      </div>
    `;
  }

  let totpHTML = '';
  if (hasTotp) {
    totpHTML = `
      <div id="totp-section" class="${activeMethod !== 'totp' && showMethodChoice ? 'hidden' : ''}">
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
        </div>
        <div id="totp-error" class="hidden mb-3 rounded-xl bg-red-500/10 px-4 py-2.5 text-[13px] font-medium text-red-600 dark:text-red-400"></div>
        <div class="flex gap-3 mt-4">
          <button id="totp-cancel" class="btn-secondary flex-1">Cancel</button>
          <button id="totp-verify" class="btn-primary flex-1" disabled>Verify</button>
        </div>
        ${allowRecovery ? `<button id="totp-recovery-toggle" class="mt-3 w-full text-center text-[12px] text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark transition-colors">Use recovery code instead</button>` : ''}
      </div>
    `;
  }

  let passkeyHTML = '';
  if (hasPasskey) {
    passkeyHTML = `
      <div id="passkey-section" class="${activeMethod !== 'passkey' && showMethodChoice ? 'hidden' : ''}">
        <div class="card p-4 mb-4 bg-black/[0.03] dark:bg-white/[0.04]">
          <div class="flex items-center gap-3 mb-2">
            <svg class="h-6 w-6 text-action dark:text-action-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25c2.25-1.5 3-3.75 3-5.25m3.75 0v-3m-3.75 3V12"/></svg>
            <p class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">Your device will prompt you to verify</p>
          </div>
          <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Use fingerprint, face recognition, Windows Hello, or a security key.</p>
        </div>
        <div class="flex gap-3 mt-4">
          ${!hasTotp ? `<button id="totp-cancel" class="btn-secondary flex-1">Cancel</button>` : ''}
          <button id="passkey-verify-btn" class="btn-primary flex-1">
            <svg class="h-5 w-5 mr-2" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25c2.25-1.5 3-3.75 3-5.25m3.75 0v-3m-3.75 3V12"/></svg>
            <span>Use Passkey</span>
          </button>
        </div>
      </div>
    `;
  }

  // If only one method, no tabs needed
  // If both methods, show tabs + both sections
  return `
    <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">${title}</h2>
    <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">${message}</p>
    ${methodTabsHTML}
    ${totpHTML}
    ${passkeyHTML}
  `;
}

/**
 * Helper: Run verification and return verification_id.
 * Wraps TotpDialog with sensible defaults.
 * Automatically supports both TOTP and Passkey.
 * @param {string} context - Description for the verification
 * @param {string} scope - Operation scope (e.g. 'user_transaction')
 */
export async function requireVerification(context = 'Verify your identity', scope) {
  return TotpDialog({ title: context, message: 'Verify your identity to continue.', scope });
}
