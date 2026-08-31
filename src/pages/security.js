import { get2FAStatus, begin2FAEnrollment, confirm2FAEnrollment, disable2FA, disable2FAWithVerification, renderQRCode } from '@/core/totp';
import { requireVerification } from '@/components/TotpDialog';
import { listPasskeys, deletePasskey, renamePasskey, browserSupportsPasskeys, registerPasskeyExisting } from '@/core/passkey';
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

    // Load passkeys
    let passkeys = [];
    if (browserSupportsPasskeys()) {
      try {
        passkeys = await listPasskeys();
      } catch { /* ignore */ }
    }

    container.className = '';
    renderSecurityContent(container, status, passkeys);
  } catch (err) {
    container.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">${err.message || 'Failed to load security settings'}</p></div>`;
  }
}

function renderSecurityContent(container, status, passkeys) {
  const hasTotp = status.enabled;
  const hasPasskey = passkeys.length > 0;

  container.innerHTML = `
    <!-- Authenticator Section -->
    <div class="card p-6 mb-4">
      <div class="flex items-center gap-3 mb-4">
        <div class="flex h-10 w-10 items-center justify-center rounded-full ${hasTotp ? 'bg-green-500/10 dark:bg-green-500/20' : 'bg-amber-500/10 dark:bg-amber-500/20'}">
          ${hasTotp
            ? '<svg class="h-5 w-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/></svg>'
            : '<svg class="h-5 w-5 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>'
          }
        </div>
        <div>
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">Authenticator${hasTotp ? ' Enabled' : ' Not Enabled'}</p>
          ${hasTotp ? `<p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Since ${new Date(status.created_at).toLocaleDateString()}</p>` : ''}
        </div>
      </div>
      ${hasTotp
        ? `<p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">Authenticator app is active. You can use it for two-factor authentication.</p>
           ${!hasPasskey
             ? '<p class="text-[12px] text-amber-600 dark:text-amber-400 mb-3">Add a passkey before disabling authenticator. Your account must always have at least one 2FA method.</p>'
             : ''}
           <button id="disable-totp-btn" class="btn-secondary w-full text-red-600 dark:text-red-400${!hasPasskey ? ' opacity-50 cursor-not-allowed' : ''}"${!hasPasskey ? ' disabled' : ''}>Disable Authenticator</button>`
        : `<p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">Set up an authenticator app for two-factor authentication.</p>
           <button id="enable-totp-btn" class="btn-primary w-full">Set Up Authenticator</button>`
      }
    </div>

    <!-- Passkey Section -->
    <div class="card p-6 mb-4">
      <div class="flex items-center gap-3 mb-4">
        <div class="flex h-10 w-10 items-center justify-center rounded-full ${hasPasskey ? 'bg-green-500/10 dark:bg-green-500/20' : 'bg-black/[0.04] dark:bg-white/[0.06]'}">
          <svg class="h-5 w-5 ${hasPasskey ? 'text-green-600 dark:text-green-400' : 'text-text-secondary dark:text-text-secondary-dark'}" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M7.864 4.243A7.5 7.5 0 0119.5 12c0 2.07-.84 3.94-2.197 5.303m-2.197-5.303A4.5 4.5 0 0012 7.5a4.5 4.5 0 00-3.106 4.5m6.212 0A7.478 7.478 0 0112 16.5a7.478 7.478 0 01-3.106-4.5m6.212 0c.39.39.72.84.97 1.337M8.894 12A4.486 4.486 0 0112 7.5a4.486 4.486 0 013.106 4.5m-6.212 0c-.39.39-.72.84-.97 1.337M12 16.5v1.5m-3.536-1.06A7.478 7.478 0 014.5 12c0-1.04.213-2.03.597-2.933"/></svg>
        </div>
        <div>
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">Passkey${hasPasskey ? ` (${passkeys.length})` : ''}</p>
        </div>
      </div>
      ${hasPasskey
        ? `<div id="passkey-list" class="space-y-2 mb-4">${renderPasskeyList(passkeys, hasTotp || passkeys.length > 1)}</div>
           ${!hasTotp && passkeys.length === 1 ? '<p class="text-[12px] text-amber-600 dark:text-amber-400 mb-3">Enable authenticator before deleting your last passkey. Your account must always have at least one 2FA method.</p>' : ''}
           <div id="passkey-feedback" class="hidden mt-3"></div>`
        : `<div id="passkey-feedback" class="hidden mt-3"></div>`
      }
      <button id="add-passkey-btn" class="btn-secondary w-full flex items-center justify-center gap-2">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>
        <span>Add Passkey</span>
      </button>
    </div>

    <div id="security-feedback" class="hidden mt-4"></div>
    ${changePasswordCard()}
  `;

  // ── Event handlers ──
  const enableTotpBtn = container.querySelector('#enable-totp-btn');
  if (enableTotpBtn) enableTotpBtn.addEventListener('click', () => handleEnroll(container));

  const disableTotpBtn = container.querySelector('#disable-totp-btn');
  if (disableTotpBtn) disableTotpBtn.addEventListener('click', () => handleDisableTotp(container));

  // Passkey handlers
  const addPasskeyBtn = container.querySelector('#add-passkey-btn');
  if (addPasskeyBtn) addPasskeyBtn.addEventListener('click', () => handleAddPasskey(container));

  container.querySelectorAll('[data-passkey-delete]').forEach(btn => {
    btn.addEventListener('click', () => handleDeletePasskey(container, btn.dataset.passkeyDelete));
  });
  container.querySelectorAll('[data-passkey-rename]').forEach(btn => {
    btn.addEventListener('click', () => handleRenamePasskey(container, btn.dataset.passkeyRename, btn.dataset.passkeyName));
  });

  attachChangePasswordHandlers(container);
}

function renderPasskeyList(passkeys, canDelete) {
  return passkeys.map(pk => `
    <div class="flex items-center justify-between rounded-xl bg-black/[0.03] dark:bg-white/[0.04] px-4 py-3">
      <div class="flex items-center gap-3 min-w-0">
        <svg class="h-5 w-5 shrink-0 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25c2.25-1.5 3-3.75 3-5.25m3.75 0v-3m-3.75 3V12"/></svg>
        <div class="min-w-0">
          <p class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark truncate">${pk.friendly_name || 'Passkey'}</p>
          <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">${new Date(pk.created_at).toLocaleDateString()}</p>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button data-passkey-rename="${pk.id}" data-passkey-name="${pk.friendly_name || ''}" class="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary dark:text-text-secondary-dark dark:hover:text-text-primary-dark hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors">Rename</button>
        <button data-passkey-delete="${pk.id}" class="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors${!canDelete ? ' opacity-50 cursor-not-allowed' : ''}"${!canDelete ? ' disabled' : ''}>Delete</button>
      </div>
    </div>
  `).join('');
}

async function handleDisableTotp(container) {
  const feedback = container.querySelector('#security-feedback');
  try {
    // Use the unified verification dialog (supports both TOTP and passkey)
    const verificationId = await requireVerification('Disable Authenticator', 'user_transaction');

    // Disable TOTP using the verification_id
    await disable2FAWithVerification(verificationId);
    showFeedback(feedback, 'Authenticator disabled', 'green');
    setTimeout(() => loadSecurityPage(container.closest('main') || container.parentElement), 1000);
  } catch (err) {
    if (err.message === 'cancelled') return;
    showFeedback(feedback, err.message || 'Failed to disable authenticator', 'red');
  }
}

async function handleAddPasskey(container) {
  const feedback = container.querySelector('#passkey-feedback') || container.querySelector('#security-feedback');
  try {
    // Require fresh TOTP or existing-passkey verification
    const verificationId = await requireVerification('Add Passkey', 'passkey_enrollment');

    // Register new passkey (authorization consumed server-side, trigger validates)
    await registerPasskeyExisting(verificationId);

    showFeedback(feedback, 'Passkey added successfully', 'green');
    setTimeout(() => loadSecurityPage(container.closest('main') || container.parentElement), 1000);
  } catch (err) {
    if (err.message === 'cancelled') return;
    showFeedback(feedback, err.message || 'Failed to add passkey', 'red');
  }
}

async function handleDeletePasskey(container, passkeyId) {
  const feedback = container.querySelector('#passkey-feedback') || container.querySelector('#security-feedback');
  try {
    // Require fresh verification before deletion
    const verificationId = await requireVerification('Delete Passkey', 'user_transaction');
    await deletePasskey(passkeyId, verificationId);
    showFeedback(feedback, 'Passkey deleted', 'green');
    setTimeout(() => loadSecurityPage(container.closest('main') || container.parentElement), 1000);
  } catch (err) {
    if (err.message === 'cancelled') return;
    showFeedback(feedback, err.message || 'Failed to delete passkey', 'red');
  }
}

async function handleRenamePasskey(container, passkeyId, currentName) {
  const feedback = container.querySelector('#passkey-feedback') || container.querySelector('#security-feedback');

  // Show inline rename form
  const passkeyList = container.querySelector('#passkey-list');
  if (!passkeyList) return;

  const existingForm = container.querySelector('#rename-form');
  if (existingForm) existingForm.remove();

  const form = document.createElement('div');
  form.id = 'rename-form';
  form.className = 'card p-4 mb-3';
  form.innerHTML = `
    <label class="label" for="rename-input">New name</label>
    <input type="text" id="rename-input" class="input-field" value="${currentName}" maxlength="120" />
    <div id="rename-error" class="hidden mt-2 text-[13px] text-red-600 dark:text-red-400"></div>
    <div class="flex gap-3 mt-3">
      <button id="rename-cancel" class="btn-secondary flex-1">Cancel</button>
      <button id="rename-save" class="btn-primary flex-1">Save</button>
    </div>
  `;
  passkeyList.before(form);

  const input = form.querySelector('#rename-input');
  const saveBtn = form.querySelector('#rename-save');
  const cancelBtn = form.querySelector('#rename-cancel');
  const errorEl = form.querySelector('#rename-error');

  input.focus();
  input.select();

  cancelBtn.addEventListener('click', () => form.remove());

  saveBtn.addEventListener('click', async () => {
    const newName = input.value.trim();
    if (!newName) {
      errorEl.textContent = 'Name cannot be empty';
      errorEl.classList.remove('hidden');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      await renamePasskey(passkeyId, newName);
      form.remove();
      showFeedback(feedback, 'Passkey renamed', 'green');
      setTimeout(() => loadSecurityPage(container.closest('main') || container.parentElement), 800);
    } catch (err) {
      errorEl.textContent = err.message || 'Failed to rename';
      errorEl.classList.remove('hidden');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });
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
      const { data: { user } } = await supabase.auth.getUser();
      const email = user?.email;
      if (!email) throw new Error('Session expired');

      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password: currentInput.value });
      if (signInError) {
        errorEl.textContent = 'Current password is incorrect';
        errorEl.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Change Password';
        return;
      }

      submitBtn.textContent = '2FA Required...';
      try {
        await requireVerification('Change Password', 'user_transaction');
      } catch {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Change Password';
        return;
      }

      submitBtn.textContent = 'Updating...';
      const { error: updateError } = await supabase.auth.updateUser({ password: newInput.value });
      if (updateError) throw updateError;

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
