import { navigate } from '@/core/router';
import { requireVerification } from '@/components/TotpDialog';
import { getBankAccounts, addBankAccount, deleteBankAccount, maskAccountNumber, isValidIFSC } from '@/data/bank-data';

const bankIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21M3 5.25l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21"/></svg>`;
const plusIcon = `<svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4.5v15m7.5-7.5h-15"/></svg>`;
const trashIcon = `<svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/></svg>`;

export function renderPaymentMethods() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  page.innerHTML = `
    <div class="flex items-center gap-3 mb-2">
      <button id="back-btn" class="flex h-8 w-8 items-center justify-center rounded-xl text-text-secondary transition-colors duration-150 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
        <svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
      </button>
      <h1 class="page-title">Payment Methods</h1>
    </div>
    <p class="text-muted mt-1 mb-6">Manage your payout methods</p>
    <div id="payment-methods-content"></div>
  `;

  page.querySelector('#back-btn').addEventListener('click', () => navigate('profile'));

  renderBankAccountsUI(page.querySelector('#payment-methods-content'));
  return page;
}

// =============================================================================
// Manage Bank Accounts
// =============================================================================

async function renderBankAccountsUI(container) {
  container.innerHTML = `
    <div class="flex items-center gap-3 mb-2">
      <button id="bank-back-btn" class="flex h-8 w-8 items-center justify-center rounded-xl text-text-secondary transition-colors duration-150 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]">
        <svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
      </button>
      <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark">Manage Bank Accounts</h2>
    </div>
    <p class="text-muted mt-1 mb-5">Bank accounts for receiving INR from sell orders</p>
    <div id="bank-accounts-content" class="flex items-center justify-center py-12">
      <div class="auth-spinner"></div>
    </div>
    <div id="bank-feedback" class="hidden mt-4"></div>
  `;

  container.querySelector('#bank-back-btn').addEventListener('click', () => navigate('profile'));

  await loadBankAccountsList(container);
}

async function loadBankAccountsList(container) {
  const content = container.querySelector('#bank-accounts-content');
  const feedback = container.querySelector('#bank-feedback');

  try {
    const accounts = await getBankAccounts();
    const canAdd = accounts.length < 2;

    if (accounts.length === 0) {
      content.innerHTML = `
        <div class="card flex w-full flex-col items-center justify-center p-8 text-center">
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
            ${bankIcon}
          </div>
          <p class="mt-4 text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">No bank accounts</p>
          <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">Add an account to receive INR payouts</p>
        </div>
      `;
    } else {
      content.innerHTML = `
        <div class="w-full space-y-3">
          ${accounts.map(acc => `
            <div class="card p-4" data-account-id="${acc.id}">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark truncate">${escapeHtml(acc.bank_name)}</p>
                  <p class="mt-0.5 text-[13px] text-text-secondary dark:text-text-secondary-dark truncate">${escapeHtml(acc.account_holder_name)}</p>
                  <p class="mt-1 text-[13px] font-medium text-text-primary dark:text-text-primary-dark">${maskAccountNumber(acc.account_number)}</p>
                  <p class="mt-0.5 text-[12px] text-text-secondary dark:text-text-secondary-dark">IFSC: ${escapeHtml(acc.ifsc_code).toUpperCase()}</p>
                </div>
                <button class="delete-bank-btn flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl text-red-500 transition-colors duration-150 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/10" aria-label="Delete bank account">
                  ${trashIcon}
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      `;

      content.querySelectorAll('.delete-bank-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const card = btn.closest('[data-account-id]');
          const id = card?.dataset.accountId;
          if (id) confirmDeleteBankAccount(id, container);
        });
      });
    }

    if (canAdd) {
      const addBtn = document.createElement('button');
      addBtn.className = 'card mt-3 flex w-full items-center justify-center gap-2 p-4 text-[14px] font-medium text-text-primary transition-colors duration-150 hover:bg-black/[0.03] dark:text-text-primary-dark dark:hover:bg-white/[0.04]';
      addBtn.innerHTML = `${plusIcon}<span>Add Bank Account</span>`;
      addBtn.addEventListener('click', () => openAddBankAccountModal(() => loadBankAccountsList(container)));
      content.appendChild(addBtn);
    }
  } catch (err) {
    content.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">${err.message || 'Failed to load bank accounts'}</p></div>`;
  }

  if (feedback) feedback.classList.add('hidden');
}

function confirmDeleteBankAccount(id, container) {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4';
  overlay.innerHTML = `
    <div class="card w-full max-w-sm p-6 step-enter">
      <h3 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Delete bank account?</h3>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">This action cannot be undone. The account will no longer be available for INR payouts.</p>
      <div class="flex gap-3">
        <button id="cancel-delete-bank" class="btn-secondary flex-1">Cancel</button>
        <button id="confirm-delete-bank" class="btn-secondary flex-1 text-red-600 dark:text-red-400">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const feedback = container.querySelector('#bank-feedback');

  overlay.querySelector('#cancel-delete-bank').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#confirm-delete-bank').addEventListener('click', async () => {
    const btn = overlay.querySelector('#confirm-delete-bank');
    btn.disabled = true;
    btn.textContent = 'Deleting...';
    try {
      await deleteBankAccount(id);
      overlay.remove();
      showFeedback(feedback, 'Bank account deleted', 'green');
      await loadBankAccountsList(container);
    } catch (err) {
      overlay.remove();
      showFeedback(feedback, err.message || 'Failed to delete bank account', 'red');
    }
  });
}

export function openAddBankAccountModal(onSuccess) {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[100] flex items-end justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4';

  const modal = document.createElement('div');
  modal.className = 'card w-full max-w-sm rounded-b-none sm:rounded-2xl p-5 step-enter max-h-[90dvh] flex flex-col';
  modal.innerHTML = `
    <div class="flex-shrink-0">
      <h3 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Add Bank Account</h3>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-5">Enter your bank details carefully</p>
    </div>
    <div class="flex-1 overflow-y-auto space-y-4 pr-1">
      <div>
        <label class="label" for="bank-name">Bank Name</label>
        <input id="bank-name" type="text" class="input-field" placeholder="e.g. HDFC Bank" autocomplete="off" />
      </div>
      <div>
        <label class="label" for="bank-ifsc">IFSC Code</label>
        <input id="bank-ifsc" type="text" class="input-field" placeholder="HDFC0001234" autocomplete="off" />
      </div>
      <div>
        <label class="label" for="bank-account">Account No</label>
        <input id="bank-account" type="text" inputmode="numeric" class="input-field" placeholder="Enter account number" autocomplete="off" />
      </div>
      <div>
        <label class="label" for="bank-confirm-account">Confirm Account No</label>
        <input id="bank-confirm-account" type="text" inputmode="numeric" class="input-field" placeholder="Re-enter account number" autocomplete="off" />
      </div>
      <div>
        <label class="label" for="bank-holder">Account Holder's Name</label>
        <input id="bank-holder" type="text" class="input-field" placeholder="Full name as in bank records" autocomplete="name" />
      </div>
      <div id="bank-form-error" class="hidden rounded-xl bg-red-500/10 px-4 py-2.5 text-[13px] font-medium text-red-600 dark:text-red-400"></div>
    </div>
    <div class="flex-shrink-0 flex gap-3 mt-5 pt-2">
      <button id="cancel-add-bank" class="btn-secondary flex-1">Cancel</button>
      <button id="submit-add-bank" class="btn-primary flex-1" disabled>Add Bank Account</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const bankName = modal.querySelector('#bank-name');
  const ifsc = modal.querySelector('#bank-ifsc');
  const account = modal.querySelector('#bank-account');
  const confirmAccount = modal.querySelector('#bank-confirm-account');
  const holder = modal.querySelector('#bank-holder');
  const submitBtn = modal.querySelector('#submit-add-bank');
  const cancelBtn = modal.querySelector('#cancel-add-bank');
  const errorEl = modal.querySelector('#bank-form-error');

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

  function validate() {
    const name = bankName.value.trim();
    const ifscVal = ifsc.value.trim();
    const acc = account.value.trim();
    const accConfirm = confirmAccount.value.trim();
    const holderVal = holder.value.trim();

    const allFilled = name && ifscVal && acc && accConfirm && holderVal;
    submitBtn.disabled = !allFilled;
  }

  [bankName, ifsc, account, confirmAccount, holder].forEach(input => {
    input.addEventListener('input', () => {
      hideError();
      validate();
    });
  });

  cancelBtn.addEventListener('click', close);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  submitBtn.addEventListener('click', async () => {
    const name = bankName.value.trim();
    const ifscVal = ifsc.value.trim().toUpperCase();
    const acc = account.value.trim();
    const accConfirm = confirmAccount.value.trim();
    const holderVal = holder.value.trim();

    if (!name || !ifscVal || !acc || !accConfirm || !holderVal) {
      showError('All fields are required.');
      return;
    }

    if (acc !== accConfirm) {
      showError('Account numbers do not match.');
      return;
    }

    if (!isValidIFSC(ifscVal)) {
      showError('Enter a valid 11-character IFSC code.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying...';

    try {
      const verificationId = await requireVerification('Add Bank Account', 'user_transaction');
      submitBtn.textContent = 'Saving...';
      await addBankAccount({
        bankName: name,
        ifscCode: ifscVal,
        accountNumber: acc,
        accountHolderName: holderVal,
      }, verificationId);
      close();
      if (onSuccess) onSuccess();
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Bank Account';
      if (err.message === 'cancelled') {
        hideError();
      } else {
        showError(err.message || 'Failed to add bank account');
      }
    }
  });

  setTimeout(() => bankName.focus(), 100);
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
