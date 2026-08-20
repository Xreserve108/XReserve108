import { supabase } from '@/lib/supabase';
import { get2FAStatus, begin2FAEnrollment, confirm2FAEnrollment, disable2FA, renderQRCode } from '@/core/totp';

export function renderAdminSecurity() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col px-5 pb-8 pt-8 md:px-8 lg:px-12';

  page.innerHTML = `
    <h1 class="page-title">Security Settings</h1>
    <p class="text-muted mt-1 mb-6">Admin two-factor authentication</p>
    <div id="admin-security-content" class="flex items-center justify-center py-12">
      <div class="auth-spinner"></div>
    </div>
  `;

  loadAdminSecurity(page);
  return page;
}

/**
 * Render security content without page wrapper — for embedding in Settings tabs.
 */
export function renderAdminSecurityContent() {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div id="admin-security-content" class="flex items-center justify-center py-8">
      <div class="auth-spinner"></div>
    </div>
  `;
  loadAdminSecurity(wrapper);
  return wrapper;
}

async function loadAdminSecurity(page) {
  const container = page.querySelector('#admin-security-content');
  try {
    const status = await get2FAStatus();
    container.className = '';
    if (status.enabled) {
      renderAdminEnabled(container, status);
    } else {
      renderAdminDisabled(container);
    }
  } catch (err) {
    container.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">${err.message || 'Failed to load'}</p></div>`;
  }
}

function renderAdminEnabled(container, status) {
  container.innerHTML = `
    <div class="card p-6 mb-4 max-w-lg">
      <div class="flex items-center gap-3 mb-4">
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/10 dark:bg-green-500/20">
          <svg class="h-5 w-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/></svg>
        </div>
        <div>
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">2FA Enabled</p>
          <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Since ${new Date(status.created_at).toLocaleDateString()}</p>
        </div>
      </div>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Admin operations require fresh TOTP verification.</p>
    </div>
    <div class="max-w-lg space-y-3">
      <button id="admin-disable-2fa" class="btn-secondary w-full text-red-600 dark:text-red-400">Disable 2FA</button>
    </div>
    <div id="admin-security-feedback" class="hidden mt-4 max-w-lg"></div>
  `;

  container.querySelector('#admin-disable-2fa').addEventListener('click', () => handleAdminDisable(container));
}

function renderAdminDisabled(container) {
  container.innerHTML = `
    <div class="card p-6 mb-4 max-w-lg">
      <div class="flex items-center gap-3 mb-4">
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 dark:bg-amber-500/20">
          <svg class="h-5 w-5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>
        </div>
        <div>
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">2FA Required</p>
          <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Admins must have 2FA enabled</p>
        </div>
      </div>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">Set up 2FA to perform admin operations.</p>
      <button id="admin-enable-2fa" class="btn-primary w-full">Set Up 2FA</button>
    </div>
    <div id="admin-security-feedback" class="hidden mt-4 max-w-lg"></div>
  `;

  container.querySelector('#admin-enable-2fa').addEventListener('click', () => handleAdminEnroll(container));
}

async function handleAdminEnroll(container) {
  const feedback = container.querySelector('#admin-security-feedback');
  try {
    showFeedback(feedback, 'Generating setup...', 'amber');
    const { secret, qr_uri } = await begin2FAEnrollment();

    container.innerHTML = `
      <div class="card p-6 mb-4 max-w-lg">
        <h2 class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Scan QR Code</h2>
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">Scan with your authenticator app.</p>
        <div id="qr-container" class="mb-4 flex justify-center"><div class="auth-spinner"></div></div>
        <div class="card p-3 mb-4 bg-black/[0.03] dark:bg-white/[0.04]">
          <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark mb-1">Secret Key</p>
          <p class="font-mono text-[14px] text-text-primary dark:text-text-primary-dark break-all select-all">${secret}</p>
        </div>
        <label class="label" for="admin-totp-code">Verification Code</label>
        <input type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code"
          class="input-field text-center text-[20px] tracking-[0.3em] font-mono" placeholder="000000" id="admin-totp-code" />
        <div id="admin-enroll-error" class="hidden mt-2 text-[13px] text-red-600 dark:text-red-400"></div>
        <div class="flex gap-3 mt-4">
          <button id="admin-cancel-enroll" class="btn-secondary flex-1">Cancel</button>
          <button id="admin-confirm-enroll" class="btn-primary flex-1" disabled>Enable 2FA</button>
        </div>
      </div>
      <div id="admin-security-feedback" class="hidden mt-4 max-w-lg"></div>
    `;

    await renderQRCode(container.querySelector('#qr-container'), qr_uri);

    const input = container.querySelector('#admin-totp-code');
    const confirmBtn = container.querySelector('#admin-confirm-enroll');
    const cancelBtn = container.querySelector('#admin-cancel-enroll');
    const errorEl = container.querySelector('#admin-enroll-error');

    input.addEventListener('input', () => {
      errorEl.classList.add('hidden');
      confirmBtn.disabled = input.value.trim().length < 6;
    });

    cancelBtn.addEventListener('click', () => {
      const main = container.closest('main');
      if (main) loadAdminSecurity(main);
    });

    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Verifying...';
      try {
        const result = await confirm2FAEnrollment(input.value.trim());
        if (result.success) {
          showAdminRecoveryCodes(container, result.recovery_codes);
        }
      } catch (err) {
        errorEl.textContent = err.message || 'Invalid code';
        errorEl.classList.remove('hidden');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Enable 2FA';
        input.value = '';
        input.focus();
      }
    });

    setTimeout(() => input.focus(), 100);
  } catch (err) {
    showFeedback(feedback, err.message || 'Failed', 'red');
  }
}

function showAdminRecoveryCodes(container, codes) {
  container.innerHTML = `
    <div class="card p-6 max-w-lg">
      <h2 class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark mb-3">Recovery Codes</h2>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-3">Save these codes. Each can be used once.</p>
      <div class="grid grid-cols-2 gap-2 mb-4">
        ${codes.map(c => `<div class="rounded-lg bg-black/[0.04] dark:bg-white/[0.06] px-3 py-2 text-center font-mono text-[13px] text-text-primary dark:text-text-primary-dark select-all">${c}</div>`).join('')}
      </div>
      <button id="admin-done-btn" class="btn-primary w-full">Done</button>
    </div>
  `;

  container.querySelector('#admin-done-btn').addEventListener('click', () => {
    const main = container.closest('main');
    if (main) loadAdminSecurity(main);
  });
}

async function handleAdminDisable(container) {
  const feedback = container.querySelector('#admin-security-feedback');
  const btn = container.querySelector('#admin-disable-2fa');
  btn.disabled = true;

  const inputWrap = document.createElement('div');
  inputWrap.className = 'mt-3 max-w-lg';
  inputWrap.innerHTML = `
    <label class="label" for="admin-disable-code">Enter code to confirm</label>
    <input type="text" inputmode="numeric" maxlength="6" class="input-field text-center text-[18px] tracking-[0.3em] font-mono" placeholder="000000" id="admin-disable-code" />
    <div id="admin-disable-error" class="hidden mt-2 text-[13px] text-red-600 dark:text-red-400"></div>
    <div class="flex gap-3 mt-3">
      <button id="admin-cancel-disable" class="btn-secondary flex-1">Cancel</button>
      <button id="admin-confirm-disable" class="btn-secondary flex-1 text-red-600 dark:text-red-400" disabled>Disable</button>
    </div>
  `;
  container.querySelector('.space-y-3, .max-w-lg')?.after(inputWrap) || container.appendChild(inputWrap);

  const input = inputWrap.querySelector('#admin-disable-code');
  const confirmBtn = inputWrap.querySelector('#admin-confirm-disable');
  const cancelBtn = inputWrap.querySelector('#admin-cancel-disable');
  const errorEl = inputWrap.querySelector('#admin-disable-error');

  input.addEventListener('input', () => {
    errorEl.classList.add('hidden');
    confirmBtn.disabled = input.value.trim().length < 6;
  });

  cancelBtn.addEventListener('click', () => {
    inputWrap.remove();
    btn.disabled = false;
  });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      await disable2FA(input.value.trim());
      showFeedback(feedback, '2FA disabled', 'green');
      setTimeout(() => loadAdminSecurity(container.closest('main') || container.parentElement), 1000);
    } catch (err) {
      errorEl.textContent = err.message || 'Invalid code';
      errorEl.classList.remove('hidden');
      confirmBtn.disabled = false;
      input.value = '';
      input.focus();
    }
  });

  setTimeout(() => input.focus(), 100);
}

function showFeedback(el, message, color) {
  if (!el) return;
  el.className = `mt-4 rounded-xl px-4 py-3 text-[13px] font-medium max-w-lg ${
    color === 'green' ? 'bg-green-500/10 text-green-600 dark:text-green-400' :
    color === 'red' ? 'bg-red-500/10 text-red-600 dark:text-red-400' :
    'bg-amber-500/10 text-amber-600 dark:text-amber-400'
  }`;
  el.textContent = message;
  el.classList.remove('hidden');
}
