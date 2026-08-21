import { get2FAStatus, begin2FAEnrollment, confirm2FAEnrollment, disable2FA, renderQRCode } from '@/core/totp';
import { requireVerification } from '@/components/TotpDialog';
import { navigate } from '@/core/router';
import { supabase } from '@/lib/supabase';

export function renderSecurity() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  page.innerHTML = `
    <div class="flex items-center gap-3 mb-2">
      <button id="back-btn" class="flex h-8 w-8 items-center justify-center rounded-xl text-text-secondary transition-colors duration-150 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
        <svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
      </button>
      <h1 class="page-title">Security</h1>
    </div>
    <p class="text-muted mt-1 mb-6">Two-factor authentication and account security</p>
    <div id="security-content" class="flex items-center justify-center py-12">
      <div class="auth-spinner"></div>
    </div>
  `;

  page.querySelector('#back-btn').addEventListener('click', () => navigate('profile'));

  loadSecurityPage(page);
  return page;
}

async function loadSecurityPage(page) {
  const container = page.querySelector('#security-content');
  try {
    const status = await get2FAStatus();
    container.className = '';
    if (status.enabled) {
      renderEnabledState(container, status);
    } else {
      renderDisabledState(container);
    }
  } catch (err) {
    container.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">${err.message || 'Failed to load security settings'}</p></div>`;
  }
}

function renderEnabledState(container, status) {
  container.innerHTML = `
    <div class="card p-6 mb-4">
      <div class="flex items-center gap-3 mb-4">
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/10 dark:bg-green-500/20">
          <svg class="h-5 w-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/></svg>
        </div>
        <div>
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">2FA Enabled</p>
          <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Since ${new Date(status.created_at).toLocaleDateString()}</p>
        </div>
      </div>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Your account is protected with two-factor authentication. You'll need your authenticator app for sensitive operations.</p>
    </div>
    <div class="space-y-3">
      <button id="disable-2fa-btn" class="btn-secondary w-full text-red-600 dark:text-red-400">Disable 2FA</button>
    </div>
    <div id="security-feedback" class="hidden mt-4"></div>
    ${changePasswordCard()}
  `;

  container.querySelector('#disable-2fa-btn').addEventListener('click', () => handleDisable(container));
  attachChangePasswordHandlers(container);
}

function renderDisabledState(container) {
  container.innerHTML = `
    <div class="card p-6 mb-4">
      <div class="flex items-center gap-3 mb-4">
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/10 dark:bg-amber-500/20">
          <svg class="h-5 w-5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>
        </div>
        <div>
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">2FA Not Enabled</p>
          <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Protect your account with two-factor authentication</p>
        </div>
      </div>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">2FA is required for deposits, sell orders, and other sensitive operations. Set it up using any authenticator app (Google Authenticator, Authy, 1Password, etc.).</p>
      <button id="enable-2fa-btn" class="btn-primary w-full">Set Up 2FA</button>
    </div>
    <div id="security-feedback" class="hidden mt-4"></div>
    ${changePasswordCard()}
  `;

  container.querySelector('#enable-2fa-btn').addEventListener('click', () => handleEnroll(container));
  attachChangePasswordHandlers(container);
}

async function handleEnroll(container) {
  const feedback = container.querySelector('#security-feedback');
  try {
    showFeedback(feedback, 'Generating setup...', 'amber');
    const { secret, qr_uri } = await begin2FAEnrollment();

    container.innerHTML = `
      <div class="card p-6 mb-4">
        <h2 class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Scan QR Code</h2>
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">Scan this with your authenticator app, then enter the 6-digit code below.</p>
        <div id="qr-container" class="mb-4 flex justify-center">
          <div class="auth-spinner"></div>
        </div>
        <div class="card p-3 mb-4 bg-black/[0.03] dark:bg-white/[0.04]">
          <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark mb-1">Secret Key</p>
          <p class="font-mono text-[14px] text-text-primary dark:text-text-primary-dark break-all select-all">${secret}</p>
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
      <div id="security-feedback" class="hidden mt-4"></div>
    `;

    const qrContainer = container.querySelector('#qr-container');
    await renderQRCode(qrContainer, qr_uri);

    const input = container.querySelector('#totp-code');
    const confirmBtn = container.querySelector('#confirm-enroll');
    const cancelBtn = container.querySelector('#cancel-enroll');
    const errorEl = container.querySelector('#enroll-error');
    const newFeedback = container.querySelector('#security-feedback');

    input.addEventListener('input', () => {
      errorEl.classList.add('hidden');
      confirmBtn.disabled = input.value.trim().length < 6;
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click();
    });

    cancelBtn.addEventListener('click', () => loadSecurityPage(container.closest('main') || container.parentElement));

    confirmBtn.addEventListener('click', async () => {
      const code = input.value.trim();
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Verifying...';
      try {
        const result = await confirm2FAEnrollment(code);
        if (result.success) {
          showRecoveryCodes(container, result.recovery_codes);
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
    showFeedback(feedback, err.message || 'Failed to start enrollment', 'red');
  }
}

function showRecoveryCodes(container, codes) {
  container.innerHTML = `
    <div class="card p-6 mb-4">
      <div class="flex items-center gap-3 mb-4">
        <div class="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/10 dark:bg-green-500/20">
          <svg class="h-5 w-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
        </div>
        <div>
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">2FA Enabled Successfully</p>
          <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Save your recovery codes in a safe place</p>
        </div>
      </div>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-3">These codes can be used to access your account if you lose your authenticator device. Each code can only be used once.</p>
      <div class="grid grid-cols-2 gap-2 mb-4">
        ${codes.map(c => `<div class="rounded-lg bg-black/[0.04] dark:bg-white/[0.06] px-3 py-2 text-center font-mono text-[13px] text-text-primary dark:text-text-primary-dark select-all">${c}</div>`).join('')}
      </div>
      <div class="rounded-xl bg-amber-500/10 px-4 py-3 mb-4">
        <p class="text-[12px] text-amber-600 dark:text-amber-400 font-medium">Store these codes now. They won't be shown again.</p>
      </div>
      <button id="done-btn" class="btn-primary w-full">Done</button>
    </div>
  `;

  container.querySelector('#done-btn').addEventListener('click', () => {
    const main = container.closest('main');
    if (main) loadSecurityPage(main);
  });
}

async function handleDisable(container) {
  const feedback = container.querySelector('#security-feedback');
  const btn = container.querySelector('#disable-2fa-btn');
  btn.disabled = true;
  btn.textContent = 'Enter code to disable...';

  // Show inline code input
  const inputWrap = document.createElement('div');
  inputWrap.className = 'mt-3';
  inputWrap.innerHTML = `
    <label class="label" for="disable-code">Enter your authenticator code to confirm</label>
    <input type="text" inputmode="numeric" maxlength="6" class="input-field text-center text-[18px] tracking-[0.3em] font-mono" placeholder="000000" id="disable-code" />
    <div id="disable-error" class="hidden mt-2 text-[13px] text-red-600 dark:text-red-400"></div>
    <div class="flex gap-3 mt-3">
      <button id="cancel-disable" class="btn-secondary flex-1">Cancel</button>
      <button id="confirm-disable" class="btn-secondary flex-1 text-red-600 dark:text-red-400" disabled>Disable 2FA</button>
    </div>
  `;
  container.querySelector('.space-y-3').after(inputWrap);

  const input = inputWrap.querySelector('#disable-code');
  const confirmBtn = inputWrap.querySelector('#confirm-disable');
  const cancelBtn = inputWrap.querySelector('#cancel-disable');
  const errorEl = inputWrap.querySelector('#disable-error');

  input.addEventListener('input', () => {
    errorEl.classList.add('hidden');
    confirmBtn.disabled = input.value.trim().length < 6;
  });

  cancelBtn.addEventListener('click', () => {
    inputWrap.remove();
    btn.disabled = false;
    btn.textContent = 'Disable 2FA';
  });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Disabling...';
    try {
      await disable2FA(input.value.trim());
      showFeedback(feedback, '2FA disabled', 'green');
      setTimeout(() => loadSecurityPage(container.closest('main') || container.parentElement), 1000);
    } catch (err) {
      errorEl.textContent = err.message || 'Invalid code';
      errorEl.classList.remove('hidden');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Disable 2FA';
      input.value = '';
      input.focus();
    }
  });

  setTimeout(() => input.focus(), 100);
}

function changePasswordCard() {
  return `
    <div class="divider my-6"></div>
    <div id="cp-section">
      <div id="cp-trigger" class="card p-5 flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
            <svg class="h-[18px] w-[18px] text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>
          </div>
          <div>
            <p class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">Change Password</p>
            <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Update your account password</p>
          </div>
        </div>
        <svg class="h-4 w-4 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>
      </div>
      <div id="cp-form" class="hidden card p-6 mt-3">
        <div class="space-y-4">
          <div>
            <label class="label" for="cp-current">Current Password</label>
            <input type="password" id="cp-current" class="input-field" placeholder="Enter current password" autocomplete="current-password" />
          </div>
          <div>
            <label class="label" for="cp-new">New Password</label>
            <input type="password" id="cp-new" class="input-field" placeholder="Minimum 6 characters" autocomplete="new-password" />
          </div>
          <div>
            <label class="label" for="cp-confirm">Confirm New Password</label>
            <input type="password" id="cp-confirm" class="input-field" placeholder="Re-enter new password" autocomplete="new-password" />
          </div>
        </div>
        <div id="cp-error" class="hidden mt-3 text-[13px] text-red-600 dark:text-red-400"></div>
        <div class="flex gap-3 mt-5">
          <button id="cp-cancel" class="btn-secondary flex-1">Cancel</button>
          <button id="cp-submit" class="btn-primary flex-1" disabled>Change Password</button>
        </div>
        <div id="cp-feedback" class="hidden mt-4"></div>
      </div>
    </div>
  `;
}

function attachChangePasswordHandlers(container) {
  const trigger = container.querySelector('#cp-trigger');
  const form = container.querySelector('#cp-form');
  if (!trigger || !form) return;

  const currentInput = form.querySelector('#cp-current');
  const newInput = form.querySelector('#cp-new');
  const confirmInput = form.querySelector('#cp-confirm');
  const submitBtn = form.querySelector('#cp-submit');
  const cancelBtn = form.querySelector('#cp-cancel');
  const errorEl = form.querySelector('#cp-error');
  const feedback = form.querySelector('#cp-feedback');

  trigger.addEventListener('click', () => {
    const isHidden = form.classList.contains('hidden');
    if (isHidden) {
      form.classList.remove('hidden');
      trigger.classList.add('hidden');
      currentInput.focus();
    }
  });

  cancelBtn.addEventListener('click', () => {
    form.classList.add('hidden');
    trigger.classList.remove('hidden');
    currentInput.value = '';
    newInput.value = '';
    confirmInput.value = '';
    errorEl.classList.add('hidden');
    submitBtn.disabled = true;
  });

  const validate = () => {
    errorEl.classList.add('hidden');
    submitBtn.disabled = !(
      currentInput.value.length > 0 &&
      newInput.value.length >= 6 &&
      confirmInput.value.length >= 6
    );
  };

  currentInput.addEventListener('input', validate);
  newInput.addEventListener('input', validate);
  confirmInput.addEventListener('input', validate);

  submitBtn.addEventListener('click', async () => {
    errorEl.classList.add('hidden');

    // Validate passwords
    if (newInput.value.length < 6) {
      errorEl.textContent = 'Password must be at least 6 characters';
      errorEl.classList.remove('hidden');
      return;
    }
    if (newInput.value !== confirmInput.value) {
      errorEl.textContent = 'New passwords do not match';
      errorEl.classList.remove('hidden');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying...';

    try {
      // Step 1: Verify current password
      const { data: { user } } = await supabase.auth.getUser();
      const email = user?.email;
      if (!email) throw new Error('Session expired');

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: currentInput.value,
      });
      if (signInError) {
        errorEl.textContent = 'Current password is incorrect';
        errorEl.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Change Password';
        return;
      }

      // Step 2: 2FA verification
      submitBtn.textContent = '2FA Required...';
      try {
        await requireVerification('Change Password', 'user_transaction');
      } catch {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Change Password';
        return;
      }

      // Step 3: Update password
      submitBtn.textContent = 'Updating...';
      const { error: updateError } = await supabase.auth.updateUser({
        password: newInput.value,
      });
      if (updateError) throw updateError;

      // Success
      showFeedback(feedback, 'Password successfully changed', 'green');
      currentInput.value = '';
      newInput.value = '';
      confirmInput.value = '';
      submitBtn.textContent = 'Change Password';
      submitBtn.disabled = true;

      setTimeout(() => {
        form.classList.add('hidden');
        trigger.classList.remove('hidden');
        feedback.classList.add('hidden');
      }, 2500);
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to change password';
      errorEl.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Change Password';
    }
  });
}

function showFeedback(el, message, color) {
  if (!el) return;
  el.className = `mt-4 rounded-xl px-4 py-3 text-[13px] font-medium ${
    color === 'green' ? 'bg-green-500/10 text-green-600 dark:text-green-400' :
    color === 'red' ? 'bg-red-500/10 text-red-600 dark:text-red-400' :
    'bg-amber-500/10 text-amber-600 dark:text-amber-400'
  }`;
  el.textContent = message;
  el.classList.remove('hidden');
}
