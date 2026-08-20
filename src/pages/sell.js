import { navigate } from '@/core/router';
import { requireVerification } from '@/components/TotpDialog';
import { getPlatformRate, DEV_FALLBACK_RATE } from '@/data/platform-rate';
import { getWalletBalance } from '@/data/wallet-data';
import { getBankAccounts, maskAccountNumber } from '@/data/bank-data';
import { openAddBankAccountModal, escapeHtml } from '@/pages/payment-methods';
import { supabase } from '@/lib/supabase';

export async function renderSell() {
  const { rate: RATE } = await getPlatformRate();
  const walletBalance = await getWalletBalance();
  const availableBalance = walletBalance ? walletBalance.available : 0;

  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-36 pt-8 md:px-8 md:pb-8 lg:px-12';
  page.dataset.rate = String(RATE);
  page.dataset.balance = String(availableBalance);

  // Zero-balance state: selling is not possible, guide the user to deposit.
  if (availableBalance <= 0) {
    page.innerHTML = `
      <h1 class="page-title">Sell USDT</h1>
      <p class="text-muted mt-1 mb-6">Convert USDT to INR at the platform rate</p>

      <div class="card flex flex-col items-center p-8 text-center">
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
          <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"/></svg>
        </div>
        <p class="mt-4 text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">No USDT available to sell</p>
        <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">Your available balance is 0 USDT. Deposit USDT to your wallet to start selling.</p>
        <button id="deposit-cta-btn" class="btn-primary mt-5 w-full">Deposit USDT</button>
      </div>
    `;
    page.querySelector('#deposit-cta-btn').addEventListener('click', () => navigate('deposit'));
    return page;
  }

  page.innerHTML = `
    <h1 class="page-title">Sell USDT</h1>
    <p class="text-muted mt-1 mb-6">Convert USDT to INR at the platform rate</p>

    <div class="card p-5 mb-5">
      <div class="flex items-center justify-between mb-4">
        <div>
          <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">Available Balance</p>
          <p id="sell-balance" class="mt-1 text-[20px] font-bold tracking-tight text-text-primary dark:text-text-primary-dark">${formatAmount(availableBalance)} <span class="text-[13px] font-medium text-text-secondary dark:text-text-secondary-dark">USDT</span></p>
        </div>
        <button type="button" id="max-btn" class="rounded-full bg-black/[0.04] px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-text-secondary transition-colors duration-150 hover:bg-black/[0.08] active:bg-black/[0.12] dark:bg-white/[0.06] dark:text-text-secondary-dark dark:hover:bg-white/[0.1]">MAX</button>
      </div>

      <label class="label" for="sell-amount">Amount</label>
      <div class="relative">
        <input
          id="sell-amount"
          type="number"
          class="input-field pr-16"
          placeholder="0.00"
          min="0"
          step="0.01"
          inputmode="decimal"
          autocomplete="off"
        />
        <span class="absolute right-4 top-1/2 -translate-y-1/2 text-[13px] font-medium text-text-secondary dark:text-text-secondary-dark">USDT</span>
      </div>

      <div class="mt-3 flex flex-wrap gap-2" id="quick-amounts">
        <button type="button" data-amount="10" class="rounded-full bg-black/[0.04] px-3.5 py-1.5 text-[13px] font-medium text-text-primary transition-colors duration-150 hover:bg-black/[0.08] active:bg-black/[0.12] dark:bg-white/[0.06] dark:text-text-primary-dark dark:hover:bg-white/[0.1] dark:active:bg-white/[0.14]">10</button>
        <button type="button" data-amount="50" class="rounded-full bg-black/[0.04] px-3.5 py-1.5 text-[13px] font-medium text-text-primary transition-colors duration-150 hover:bg-black/[0.08] active:bg-black/[0.12] dark:bg-white/[0.06] dark:text-text-primary-dark dark:hover:bg-white/[0.1] dark:active:bg-white/[0.14]">50</button>
        <button type="button" data-amount="100" class="rounded-full bg-black/[0.04] px-3.5 py-1.5 text-[13px] font-medium text-text-primary transition-colors duration-150 hover:bg-black/[0.08] active:bg-black/[0.12] dark:bg-white/[0.06] dark:text-text-primary-dark dark:hover:bg-white/[0.1] dark:active:bg-white/[0.14]">100</button>
        <button type="button" data-amount="500" class="rounded-full bg-black/[0.04] px-3.5 py-1.5 text-[13px] font-medium text-text-primary transition-colors duration-150 hover:bg-black/[0.08] active:bg-black/[0.12] dark:bg-white/[0.06] dark:text-text-primary-dark dark:hover:bg-white/[0.1] dark:active:bg-white/[0.14]">500</button>
      </div>

      <div class="divider my-5"></div>

      <div class="flex items-center justify-between">
        <span class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Platform rate</span>
        <span class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">1 USDT = ₹${RATE.toFixed(2)}</span>
      </div>

      <div class="mt-4 flex items-center justify-between">
        <span class="text-[13px] text-text-secondary dark:text-text-secondary-dark">You receive</span>
        <p class="text-[24px] font-bold tracking-tight text-text-primary dark:text-text-primary-dark" id="payout">₹0.00</p>
      </div>
    </div>
  `;

  // Sticky CTA bar — always visible, even with keyboard open
  const bar = document.createElement('div');
  bar.className = 'sticky-action-bar';
  bar.innerHTML = `
    <button class="btn-primary w-full" id="sell-now-btn" disabled>Sell Now</button>
    <p class="mt-2.5 text-center text-[11px] leading-relaxed text-text-secondary dark:text-text-secondary-dark">Rate locked at order creation · USDT reserved immediately</p>
  `;
  page.appendChild(bar);

  return page;
}

export function setupSellInteractions(container) {
  const input = container.querySelector('#sell-amount');
  const chips = container.querySelector('#quick-amounts');
  const payout = container.querySelector('#payout');
  const maxBtn = container.querySelector('#max-btn');
  const sellBtn = container.querySelector('#sell-now-btn');
  if (!input) return; // zero-balance state has no amount form

  // NOTE: onMount receives the #page-content wrapper, not the page root —
  // read both attributes from the rendered page element inside it.
  const pageEl = container.querySelector('[data-rate]');
  const rateAttr = parseFloat(pageEl?.dataset.rate);
  const RATE = isFinite(rateAttr) && rateAttr > 0 ? rateAttr : DEV_FALLBACK_RATE;

  const balanceAttr = parseFloat(pageEl?.dataset.balance);
  let BALANCE = isFinite(balanceAttr) && balanceAttr >= 0 ? balanceAttr : 0;

  function updatePayout() {
    const amount = parseFloat(input.value) || 0;
    const inr = amount * RATE;
    if (payout) {
      payout.textContent = `₹${inr.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    if (sellBtn) {
      sellBtn.disabled = amount <= 0 || amount > BALANCE;
    }
  }

  function setAmount(val) {
    input.value = val;
    updatePayout();
    input.focus();
  }

  input.addEventListener('input', updatePayout);

  if (chips) {
    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-amount]');
      if (!chip) return;
      setAmount(chip.dataset.amount);
    });
  }

  if (maxBtn) {
    maxBtn.addEventListener('click', () => {
      setAmount(BALANCE.toString());
    });
  }

  if (sellBtn) {
    sellBtn.addEventListener('click', () => {
      const amount = parseFloat(input.value) || 0;
      if (amount <= 0 || amount > BALANCE) return;
      openSellWorkflow(container, amount, RATE, async () => {
        // After a successful order, fetch the real wallet balance via the
        // canonical mechanism and sync the Sell page + header immediately.
        const fresh = await getWalletBalance();
        if (fresh && isFinite(fresh.available)) {
          BALANCE = fresh.available;
          const pageRoot = container.querySelector('[data-balance]');
          if (pageRoot) pageRoot.dataset.balance = String(BALANCE);
          const balanceEl = container.querySelector('#sell-balance');
          if (balanceEl) {
            balanceEl.innerHTML = `${formatAmount(BALANCE)} <span class="text-[13px] font-medium text-text-secondary dark:text-text-secondary-dark">USDT</span>`;
          }
          // Header wallet display (same element updated by navigation.js / main.js)
          const headerBalanceEl = document.getElementById('wallet-balance-text');
          if (headerBalanceEl) headerBalanceEl.textContent = formatAmount(BALANCE);
        }
        input.value = '';
        updatePayout();
      });
    });
  }
}

// =============================================================================
// SELL NOW WORKFLOW
//   Bank account selection → Confirm & Sell → duplicate check → 2FA →
//   server-side atomic order creation (create_sell_order RPC).
// =============================================================================

function openSellWorkflow(page, amount, rate, onSold) {
  const clientToken = newClientToken();
  let selectedAccount = null;
  let loadedAccounts = [];
  let submitting = false;

  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[90] flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-4';

  const modal = document.createElement('div');
  modal.className = 'card w-full max-w-sm rounded-b-none sm:rounded-2xl p-5 step-enter max-h-[90dvh] flex flex-col';
  modal.innerHTML = `
    <div class="flex-shrink-0 flex items-start justify-between">
      <div>
        <h3 id="wf-title" class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark"></h3>
        <p id="wf-subtitle" class="mt-0.5 text-[13px] text-text-secondary dark:text-text-secondary-dark"></p>
      </div>
      <button id="wf-close" class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl text-text-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.06]" aria-label="Close">
        <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>
    <div id="wf-content" class="mt-4 flex-1 overflow-y-auto pr-1"></div>
    <div id="wf-error" class="hidden flex-shrink-0 mt-3 rounded-xl bg-red-500/10 px-4 py-2.5 text-[13px] font-medium text-red-600 dark:text-red-400"></div>
    <div id="wf-footer" class="flex-shrink-0 mt-4"></div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const titleEl = modal.querySelector('#wf-title');
  const subtitleEl = modal.querySelector('#wf-subtitle');
  const content = modal.querySelector('#wf-content');
  const footer = modal.querySelector('#wf-footer');
  const errorEl = modal.querySelector('#wf-error');

  function close() {
    overlay.remove();
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }

  function hideError() {
    errorEl.classList.add('hidden');
  }

  modal.querySelector('#wf-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  // ---- Step 1: bank account selection ---------------------------------------

  async function renderBankStep() {
    titleEl.textContent = 'Select Bank Account';
    subtitleEl.textContent = 'INR will be sent to the selected account';
    hideError();
    footer.innerHTML = '';
    content.innerHTML = '<div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>';

    try {
      loadedAccounts = await getBankAccounts();
    } catch (err) {
      content.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">${escapeHtml(err.message || 'Failed to load bank accounts')}</p></div>`;
      return;
    }

    if (loadedAccounts.length === 0) {
      content.innerHTML = `
        <div class="card flex flex-col items-center p-6 text-center">
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
            <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21M3 5.25l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21"/></svg>
          </div>
          <p class="mt-4 text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">No bank account found</p>
          <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">Add a bank account to receive your INR payout.</p>
        </div>
      `;
      footer.innerHTML = '<button id="wf-add-bank" class="btn-primary w-full">Add Bank Account</button>';
      footer.querySelector('#wf-add-bank').addEventListener('click', () => {
        // Reuse the existing Manage Bank Accounts modal (validation + 2FA + RPC).
        openAddBankAccountModal(async () => {
          try {
            const refreshed = await getBankAccounts();
            if (refreshed.length > 0) {
              loadedAccounts = refreshed;
              selectedAccount = refreshed[0]; // freshly created account (newest first)
              renderConfirmStep();
            } else {
              renderBankStep();
            }
          } catch (err) {
            showError(err.message || 'Failed to reload bank accounts');
          }
        });
      });
      return;
    }

    if (loadedAccounts.length === 1) {
      // Exactly one account: select it automatically.
      selectedAccount = loadedAccounts[0];
      renderConfirmStep();
      return;
    }

    renderBankList();
  }

  function renderBankList() {
    content.innerHTML = `
      <div class="space-y-3">
        ${loadedAccounts.map((acc) => {
          const selected = selectedAccount && selectedAccount.id === acc.id;
          return `
            <button type="button" data-bank-id="${acc.id}" class="bank-option card w-full p-4 text-left transition-colors duration-150 ${selected ? 'ring-2 ring-action dark:ring-action-dark' : ''}">
              <div class="flex items-center gap-3">
                <span class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full border-2 ${selected ? 'border-action dark:border-action-dark' : 'border-border-light dark:border-border-dark'}">
                  ${selected ? '<span class="h-2.5 w-2.5 rounded-full bg-action dark:bg-action-dark"></span>' : ''}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-[14px] font-semibold text-text-primary dark:text-text-primary-dark truncate">${escapeHtml(acc.bank_name)}</span>
                  <span class="block mt-0.5 text-[12px] text-text-secondary dark:text-text-secondary-dark truncate">${escapeHtml(acc.account_holder_name)}</span>
                  <span class="block mt-0.5 text-[12px] text-text-secondary dark:text-text-secondary-dark">${maskAccountNumber(acc.account_number)} · ${escapeHtml(acc.ifsc_code).toUpperCase()}</span>
                </span>
              </div>
            </button>
          `;
        }).join('')}
      </div>
    `;

    content.querySelectorAll('.bank-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedAccount = loadedAccounts.find((a) => a.id === btn.dataset.bankId) || null;
        renderBankList();
        const cont = footer.querySelector('#wf-continue');
        if (cont) cont.disabled = !selectedAccount;
      });
    });

    footer.innerHTML = '<button id="wf-continue" class="btn-primary w-full" disabled>Continue</button>';
    const continueBtn = footer.querySelector('#wf-continue');
    continueBtn.disabled = !selectedAccount;
    continueBtn.addEventListener('click', () => {
      if (selectedAccount) renderConfirmStep();
    });
  }

  // ---- Step 2: confirm & sell ------------------------------------------------

  function renderConfirmStep() {
    titleEl.textContent = 'Confirm & Sell';
    subtitleEl.textContent = 'Review the details before confirming';
    hideError();

    const expectedInr = amount * rate;
    content.innerHTML = `
      <div class="card p-4">
        ${confirmRow('Sell amount', `${formatAmount(amount)} USDT`)}
        ${confirmRow('Platform rate', `1 USDT = ₹${rate.toFixed(2)}`)}
        <div class="divider my-1"></div>
        <div class="flex items-center justify-between py-1.5">
          <span class="text-[13px] text-text-secondary dark:text-text-secondary-dark">You receive</span>
          <span class="text-[15px] font-bold text-text-primary dark:text-text-primary-dark">₹${expectedInr.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div class="divider my-1"></div>
        ${confirmRow('Bank', escapeHtml(selectedAccount.bank_name))}
        ${confirmRow('Account', maskAccountNumber(selectedAccount.account_number))}
        ${confirmRow('IFSC', escapeHtml(selectedAccount.ifsc_code).toUpperCase())}
      </div>
      <div class="mt-3 rounded-xl bg-amber-500/10 px-4 py-3">
        <p class="text-[12px] leading-relaxed text-amber-600 dark:text-amber-400">Payment processing time may vary from 30 minutes to 180 minutes depending on availability of funds.</p>
      </div>
    `;

    footer.innerHTML = `
      <div class="flex gap-3">
        ${loadedAccounts.length > 1 ? '<button id="wf-back" class="btn-secondary flex-1">Back</button>' : ''}
        <button id="wf-confirm" class="btn-primary flex-1">Confirm & Sell</button>
      </div>
    `;

    footer.querySelector('#wf-back')?.addEventListener('click', () => renderBankList());
    footer.querySelector('#wf-confirm').addEventListener('click', handleConfirm);
  }

  async function handleConfirm() {
    if (submitting) return; // double-click / repeated submission guard
    submitting = true;
    hideError();

    const confirmBtn = footer.querySelector('#wf-confirm');
    const backBtn = footer.querySelector('#wf-back');
    confirmBtn.disabled = true;
    if (backBtn) backBtn.disabled = true;
    confirmBtn.textContent = 'Checking...';

    try {
      // Duplicate-order safety check (UX warning; legitimate repeats allowed)
      const similar = await findSimilarPendingOrder(amount, selectedAccount.id);
      if (similar) {
        const proceed = await confirmDuplicateDialog();
        if (!proceed) throw new Error('cancelled');
      }

      // 2FA happens only after the sell confirmation is complete
      confirmBtn.textContent = 'Verifying...';
      const verificationId = await requireVerification('Confirm Sell Order', 'user_transaction');

      // Server-side: token consumption, bank ownership, rate, balance, atomicity
      confirmBtn.textContent = 'Submitting...';
      const { data: orderId, error } = await supabase.rpc('create_sell_order', {
        p_usdt_amount: amount,
        p_bank_account_id: selectedAccount.id,
        p_client_token: clientToken,
        p_verification_id: verificationId,
      });
      if (error) throw new Error(error.message || 'Failed to create sell order');

      submitting = false;
      // Sync wallet displays immediately (sell page + header), not on modal close
      await onSold();
      renderSuccessStep(orderId);
    } catch (err) {
      submitting = false;
      if (err.message !== 'cancelled') {
        showError(err.message || 'Failed to create sell order');
      }
      confirmBtn.disabled = false;
      if (backBtn) backBtn.disabled = false;
      confirmBtn.textContent = 'Confirm & Sell';
    }
  }

  function confirmDuplicateDialog() {
    return new Promise((resolve) => {
      const dupOverlay = document.createElement('div');
      dupOverlay.className = 'fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4';
      dupOverlay.innerHTML = `
        <div class="card w-full max-w-sm p-6 step-enter">
          <h3 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Similar pending order</h3>
          <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">You already have a similar pending sell order (${formatAmount(amount)} USDT to the same bank account). Are you sure you want to submit another one?</p>
          <div class="flex flex-col gap-2">
            <button id="dup-confirm" class="btn-primary w-full">I confirm this is not a duplicate order</button>
            <button id="dup-cancel" class="btn-secondary w-full">Go Back</button>
          </div>
        </div>
      `;
      document.body.appendChild(dupOverlay);

      dupOverlay.querySelector('#dup-confirm').addEventListener('click', () => {
        dupOverlay.remove();
        resolve(true);
      });
      dupOverlay.querySelector('#dup-cancel').addEventListener('click', () => {
        dupOverlay.remove();
        resolve(false);
      });
      dupOverlay.addEventListener('click', (e) => {
        if (e.target === dupOverlay) {
          dupOverlay.remove();
          resolve(false);
        }
      });
    });
  }

  // ---- Step 3: success ---------------------------------------------------------

  function renderSuccessStep(orderId) {
    titleEl.textContent = 'Sell Order Created';
    subtitleEl.textContent = `SELL_ID # ${String(orderId).slice(0, 8).toUpperCase()}`;
    hideError();

    content.innerHTML = `
      <div class="card flex flex-col items-center p-6 text-center">
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-500/10 dark:bg-green-500/20">
          <svg class="h-6 w-6 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>
        </div>
        <p class="mt-4 text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">${formatAmount(amount)} USDT sold</p>
        <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">₹${(amount * rate).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} will be sent to ${escapeHtml(selectedAccount.bank_name)} · ${maskAccountNumber(selectedAccount.account_number)}</p>
      </div>
      <div class="mt-3 rounded-xl bg-amber-500/10 px-4 py-3">
        <p class="text-[12px] leading-relaxed text-amber-600 dark:text-amber-400">Payment processing time may vary from 30 minutes to 180 minutes depending on availability of funds.</p>
      </div>
    `;

    footer.innerHTML = `
      <div class="flex gap-3">
        <button id="wf-done" class="btn-secondary flex-1">Done</button>
        <button id="wf-view-orders" class="btn-primary flex-1">View Orders</button>
      </div>
    `;

    footer.querySelector('#wf-done').addEventListener('click', () => {
      close();
    });
    footer.querySelector('#wf-view-orders').addEventListener('click', () => {
      close();
      navigate('orders');
    });
  }

  renderBankStep();
}

// Pending sell orders are RLS-scoped to the authenticated user.
async function findSimilarPendingOrder(amount, bankAccountId) {
  const { data, error } = await supabase
    .from('sell_orders')
    .select('id, usdt_amount, bank_account_id')
    .in('status', ['PAYMENT_PENDING', 'PAYMENT_PROOF_UPLOADED', 'MANUAL_REVIEW']);

  if (error || !data) return null;
  return data.find((o) => Number(o.usdt_amount) === amount && o.bank_account_id === bankAccountId) || null;
}

function confirmRow(label, value) {
  return `<div class="flex items-center justify-between py-1.5"><span class="text-[13px] text-text-secondary dark:text-text-secondary-dark">${label}</span><span class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark text-right max-w-[60%] truncate">${value}</span></div>`;
}

function newClientToken() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function formatAmount(num) {
  const n = Number(num);
  if (!isFinite(n) || n < 0) return '0.00';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}
