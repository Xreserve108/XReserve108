import { supabase } from '@/lib/supabase';
import { requireVerification } from '@/components/TotpDialog';

/**
 * Change Exchange Rate dialog (admin).
 *
 * Multi-step secure flow:
 *   1. Input   — enter new rate (validated client-side)
 *   2. Review  — current vs new, absolute + percentage diff
 *   3. 2FA     — existing requireVerification (scope: admin_settings)
 *   4. Confirm — final explicit confirmation after 2FA
 *   5. Update  — admin_update_exchange_rate RPC (server-side auth + 2FA check + audit)
 *   6. Success — confirmation view
 *
 * The browser never writes to exchange_settings directly; the update only
 * happens through the SECURITY DEFINER RPC which re-checks admin role and
 * consumes the 2FA verification token server-side.
 *
 * @param {Object} options
 * @param {number} options.currentRate - Current platform rate (1 USDT = ₹X)
 * @param {Function} [options.onUpdated] - Called after a successful update
 */
export function openChangeRateDialog({ currentRate, onUpdated } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4';

  const modal = document.createElement('div');
  modal.className = 'card w-full max-w-sm p-6 step-enter max-h-[90dvh] overflow-y-auto';
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Matches NUMERIC(10,4): up to 6 integer digits, up to 4 decimals
  const RATE_REGEX = /^\d{1,6}(\.\d{1,4})?$/;

  let newRate = null;

  function close() {
    overlay.remove();
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  function fmt(rate) {
    return `₹${Number(rate).toFixed(2)}`;
  }

  // ---------- Step 1: Input ----------
  function renderInput(errorMsg = '') {
    modal.innerHTML = `
      <h3 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Change Exchange Rate</h3>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">USDT → INR platform rate</p>

      <div class="mb-4 rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-4 py-3 flex items-center justify-between">
        <span class="text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark">Current rate</span>
        <span class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">${currentRate != null ? `1 USDT = ${fmt(currentRate)}` : '—'}</span>
      </div>

      <label class="block text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark mb-1.5" for="new-rate-input">New rate (INR per 1 USDT)</label>
      <input
        id="new-rate-input"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        class="input-field text-[16px] font-mono"
        placeholder="e.g. 92.50"
      />
      <p class="mt-1.5 text-[11px] text-text-secondary dark:text-text-secondary-dark">Positive number, up to 4 decimal places.</p>
      <div id="rate-error" class="${errorMsg ? '' : 'hidden'} mt-2 rounded-xl bg-red-500/10 px-4 py-2.5 text-[13px] font-medium text-red-600 dark:text-red-400">${errorMsg}</div>

      <div class="flex gap-3 mt-5">
        <button id="rate-cancel" class="btn-secondary flex-1">Cancel</button>
        <button id="rate-continue" class="btn-primary flex-1">Continue</button>
      </div>
    `;

    const input = modal.querySelector('#new-rate-input');
    const errorEl = modal.querySelector('#rate-error');
    const continueBtn = modal.querySelector('#rate-continue');

    modal.querySelector('#rate-cancel').addEventListener('click', close);

    input.addEventListener('input', () => errorEl.classList.add('hidden'));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') continueBtn.click();
    });

    continueBtn.addEventListener('click', () => {
      const raw = input.value.trim();
      if (!RATE_REGEX.test(raw)) {
        errorEl.textContent = 'Enter a valid positive number (up to 4 decimal places).';
        errorEl.classList.remove('hidden');
        return;
      }
      const value = parseFloat(raw);
      if (!isFinite(value) || value <= 0) {
        errorEl.textContent = 'Rate must be greater than zero.';
        errorEl.classList.remove('hidden');
        return;
      }
      if (value > 999999.9999) {
        errorEl.textContent = 'Rate is too large.';
        errorEl.classList.remove('hidden');
        return;
      }
      if (currentRate != null && value === Number(currentRate)) {
        errorEl.textContent = 'New rate is the same as the current rate.';
        errorEl.classList.remove('hidden');
        return;
      }
      newRate = value;
      renderReview();
    });

    setTimeout(() => input.focus(), 100);
  }

  // ---------- Step 2: Review ----------
  function renderReview() {
    const diff = currentRate != null ? newRate - Number(currentRate) : null;
    const pct = currentRate != null && Number(currentRate) > 0 ? (diff / Number(currentRate)) * 100 : null;
    const diffColor = diff >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400';
    const diffSign = diff >= 0 ? '+' : '−';

    modal.innerHTML = `
      <h3 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Review Rate Change</h3>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">Confirm the details before verification.</p>

      <div class="mb-4 flex flex-col gap-2">
        <div class="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-4 py-3 flex items-center justify-between">
          <span class="text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark">Current rate</span>
          <span class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">${currentRate != null ? fmt(currentRate) : '—'}</span>
        </div>
        <div class="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-4 py-3 flex items-center justify-between">
          <span class="text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark">New rate</span>
          <span class="text-[14px] font-bold text-text-primary dark:text-text-primary-dark">${fmt(newRate)}</span>
        </div>
        ${diff != null ? `
        <div class="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-4 py-3 flex items-center justify-between">
          <span class="text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark">Change</span>
          <span class="text-[14px] font-semibold ${diffColor}">${diffSign}₹${Math.abs(diff).toFixed(2)}${pct != null ? ` · ${diffSign}${Math.abs(pct).toFixed(2)}%` : ''}</span>
        </div>` : ''}
      </div>

      <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark mb-5">This rate will be used by XReserve for all USDT → INR pricing. The change is applied immediately after final confirmation.</p>

      <div class="flex gap-3">
        <button id="review-back" class="btn-secondary flex-1">Back</button>
        <button id="review-continue" class="btn-primary flex-1">Continue to 2FA</button>
      </div>
    `;

    modal.querySelector('#review-back').addEventListener('click', () => renderInput());
    modal.querySelector('#review-continue').addEventListener('click', run2FA);
  }

  // ---------- Step 3: 2FA ----------
  async function run2FA() {
    try {
      const verificationId = await requireVerification('Confirm Exchange Rate Change', 'admin_settings');
      renderFinalConfirm(verificationId);
    } catch (err) {
      if (err && err.message === 'cancelled') {
        // User cancelled 2FA — abort safely, rate unchanged
        close();
        return;
      }
      renderFailure(err?.message || '2FA verification failed.');
    }
  }

  // ---------- Step 4: Final confirmation ----------
  function renderFinalConfirm(verificationId) {
    modal.innerHTML = `
      <div class="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-green-500/10 dark:bg-green-500/20">
        <svg class="h-5 w-5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      </div>
      <h3 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">2FA Verified</h3>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">Final confirmation required to apply the change.</p>

      <div class="mb-5 rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-4 py-3 text-center">
        <p class="text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark">New platform rate</p>
        <p class="mt-1 text-[22px] font-bold tracking-tight text-text-primary dark:text-text-primary-dark">1 USDT = ${fmt(newRate)} INR</p>
      </div>

      <div id="final-error" class="hidden mb-3 rounded-xl bg-red-500/10 px-4 py-2.5 text-[13px] font-medium text-red-600 dark:text-red-400"></div>

      <div class="flex gap-3">
        <button id="final-cancel" class="btn-secondary flex-1">Cancel</button>
        <button id="final-confirm" class="btn-primary flex-1">Confirm &amp; Update Rate</button>
      </div>
    `;

    modal.querySelector('#final-cancel').addEventListener('click', close);
    modal.querySelector('#final-confirm').addEventListener('click', () => applyUpdate(verificationId));
  }

  // ---------- Step 5: Server update via RPC ----------
  async function applyUpdate(verificationId) {
    const confirmBtn = modal.querySelector('#final-confirm');
    const errorEl = modal.querySelector('#final-error');
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<div class="auth-spinner"></div><span>Updating...</span>';
    errorEl.classList.add('hidden');

    const { data, error } = await supabase.rpc('admin_update_exchange_rate', {
      p_rate: newRate,
      p_verification_id: verificationId,
    });

    if (error || data !== true) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = 'Confirm &amp; Update Rate';
      errorEl.textContent = `Exchange rate was not changed. ${error?.message || 'Server rejected the update.'}`;
      errorEl.classList.remove('hidden');
      return;
    }

    renderSuccess();
    if (typeof onUpdated === 'function') onUpdated(newRate);
  }

  // ---------- Step 6: Success ----------
  function renderSuccess() {
    modal.innerHTML = `
      <div class="flex flex-col items-center text-center py-2">
        <div class="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-green-500/10 dark:bg-green-500/20">
          <svg class="h-7 w-7 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
        </div>
        <h3 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Rate Updated</h3>
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-1">The platform exchange rate is now</p>
        <p class="text-[22px] font-bold tracking-tight text-text-primary dark:text-text-primary-dark mb-6">1 USDT = ${fmt(newRate)} INR</p>
        <button id="success-done" class="btn-primary w-full">Done</button>
      </div>
    `;
    modal.querySelector('#success-done').addEventListener('click', close);
  }

  // ---------- Failure fallback ----------
  function renderFailure(message) {
    modal.innerHTML = `
      <h3 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-2">Verification Failed</h3>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-2">${message}</p>
      <p class="text-[13px] font-medium text-red-600 dark:text-red-400 mb-5">Exchange rate was not changed.</p>
      <button id="failure-close" class="btn-secondary w-full">Close</button>
    `;
    modal.querySelector('#failure-close').addEventListener('click', close);
  }

  renderInput();
}
