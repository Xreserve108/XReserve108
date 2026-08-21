import { supabase } from '@/lib/supabase';
import { isAuthenticated } from '@/core/auth';
import { navigate } from '@/core/router';

const CATEGORIES = [
  { value: 'Deposit', label: 'Deposit' },
  { value: 'Sell Order', label: 'Sell Order' },
  { value: 'Account', label: 'Account' },
  { value: '2FA / Security', label: '2FA / Security' },
  { value: 'Wallet', label: 'Wallet' },
  { value: 'Transaction', label: 'Transaction' },
  { value: 'Other', label: 'Other' },
];

// Friendly labels for deposit statuses
const depositStatusLabels = {
  PENDING: 'Pending',
  PENDING_VERIFICATION: 'Under Verification',
  UNDER_REVIEW: 'Under Review',
  CREDITED: 'Credited',
  REJECTED: 'Rejected',
};

// Friendly labels for sell-order statuses
const sellOrderStatusLabels = {
  PAYMENT_PENDING: 'Payment Pending',
  PAYMENT_PROOF_UPLOADED: 'Proof Uploaded',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  REJECTED: 'Rejected',
  MANUAL_REVIEW: 'Manual Review',
};

// Badge colour classes by status
const statusColors = {
  // Deposit
  PENDING: 'bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  PENDING_VERIFICATION: 'bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  UNDER_REVIEW: 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400',
  CREDITED: 'bg-green-500/10 text-green-600 dark:bg-green-500/15 dark:text-green-400',
  REJECTED: 'bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400',
  // Sell order
  PAYMENT_PENDING: 'bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400',
  PAYMENT_PROOF_UPLOADED: 'bg-blue-500/10 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400',
  COMPLETED: 'bg-green-500/10 text-green-600 dark:bg-green-500/15 dark:text-green-400',
  CANCELLED: 'bg-gray-500/10 text-gray-500 dark:bg-gray-500/15 dark:text-gray-400',
  MANUAL_REVIEW: 'bg-purple-500/10 text-purple-600 dark:bg-purple-500/15 dark:text-purple-400',
};

// Cache for transaction data (shared across category switches)
let _cachedTxData = null;

export function renderCreateTicket() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  if (!isAuthenticated()) {
    navigate('signin');
    return page;
  }

  // Parse contextual params from hash
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const ctxType = params.get('ctx') || '';
  const ctxId = params.get('ref') || '';

  let submitting = false;
  let selectedTxId = null;   // ID of selected deposit or sell order
  let selectedTxType = null; // 'deposit' | 'sell_order' | null

  page.innerHTML = `
    <button id="back-to-tickets" class="flex items-center gap-1.5 text-[13px] font-medium text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark transition-colors mb-4">
      <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
      Back to Tickets
    </button>

    <h1 class="page-title">Create Support Ticket</h1>
    <p class="text-muted mt-1 mb-6">Describe your issue and we'll get back to you</p>

    <form id="ticket-form" class="flex flex-col gap-5 max-w-lg">
      <!-- Category -->
      <div>
        <label class="block text-[13px] font-medium text-text-primary dark:text-text-primary-dark mb-1.5">Category <span class="text-red-500">*</span></label>
        <select id="ticket-category" class="w-full rounded-xl border border-border-light bg-surface-light px-3.5 py-2.5 text-[14px] text-text-primary outline-none transition-colors focus:border-action dark:border-border-dark dark:bg-surface-dark dark:focus:border-action-dark">
          <option value="">Select a category</option>
        </select>
      </div>

      <!-- Transaction selector (Deposit / Sell Order) -->
      <div id="tx-selector-section" class="hidden">
        <label class="block text-[13px] font-medium text-text-primary dark:text-text-primary-dark mb-1.5" id="tx-selector-label">Select Transaction</label>
        <!-- Collapsed selected summary (shown after selection) -->
        <div id="tx-selected-summary" class="hidden rounded-xl border border-action/30 dark:border-action-dark/30 bg-surface-light dark:bg-surface-dark p-3 cursor-pointer transition-colors hover:border-action dark:hover:border-action-dark">
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0 flex-1">
              <p id="tx-summary-line1" class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark truncate"></p>
              <div class="flex items-center gap-2 mt-0.5">
                <span id="tx-summary-status" class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"></span>
                <span id="tx-summary-line2" class="text-[11px] text-text-secondary dark:text-text-secondary-dark"></span>
              </div>
            </div>
            <svg class="h-4 w-4 text-text-secondary dark:text-text-secondary-dark flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5"/></svg>
          </div>
          <p class="text-[10px] text-text-secondary dark:text-text-secondary-dark mt-1.5">Tap to change selection</p>
        </div>
        <!-- Expandable list (shown before selection or when expanding) -->
        <div id="tx-selector-list" class="flex flex-col gap-2 max-h-[220px] overflow-y-auto">
          <div class="flex items-center justify-center py-6"><div class="auth-spinner"></div></div>
        </div>
      </div>

      <!-- Subject -->
      <div>
        <label class="block text-[13px] font-medium text-text-primary dark:text-text-primary-dark mb-1.5">Subject <span class="text-red-500">*</span></label>
        <input id="ticket-subject" type="text" maxlength="200" placeholder="Brief summary of your issue"
          class="w-full rounded-xl border border-border-light bg-surface-light px-3.5 py-2.5 text-[14px] text-text-primary placeholder:text-text-secondary/50 outline-none transition-colors focus:border-action dark:border-border-dark dark:bg-surface-dark dark:focus:border-action-dark dark:placeholder:text-text-secondary-dark/50" />
      </div>

      <!-- Description -->
      <div>
        <label class="block text-[13px] font-medium text-text-primary dark:text-text-primary-dark mb-1.5">Description <span class="text-red-500">*</span></label>
        <textarea id="ticket-description" rows="5" maxlength="5000" placeholder="Please provide as much detail as possible..."
          class="w-full resize-none rounded-xl border border-border-light bg-surface-light px-3.5 py-2.5 text-[14px] text-text-primary placeholder:text-text-secondary/50 outline-none transition-colors focus:border-action dark:border-border-dark dark:bg-surface-dark dark:focus:border-action-dark dark:placeholder:text-text-secondary-dark/50"></textarea>
      </div>

      <!-- Optional TX Hash (Deposit only) -->
      <div id="tx-hash-section" class="hidden">
        <label class="block text-[13px] font-medium text-text-primary dark:text-text-primary-dark mb-1.5">Transaction Hash / TX ID <span class="text-[11px] font-normal text-text-secondary dark:text-text-secondary-dark">(optional)</span></label>
        <input id="ticket-tx-hash" type="text" placeholder="e.g. abc123..."
          class="w-full rounded-xl border border-border-light bg-surface-light px-3.5 py-2.5 text-[14px] text-text-primary placeholder:text-text-secondary/50 outline-none transition-colors focus:border-action dark:border-border-dark dark:bg-surface-dark dark:focus:border-action-dark dark:placeholder:text-text-secondary-dark/50" />
      </div>

      <!-- Error -->
      <div id="ticket-error" class="hidden rounded-xl bg-red-50 dark:bg-red-900/20 px-4 py-3 text-[13px] text-red-600 dark:text-red-400"></div>

      <!-- Submit -->
      <button id="submit-ticket" type="submit" class="btn-primary w-full py-3 text-[14px] font-medium rounded-xl">
        Submit Ticket
      </button>
    </form>
  `;

  // Populate categories
  const catSelect = page.querySelector('#ticket-category');
  CATEGORIES.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.value;
    opt.textContent = c.label;
    catSelect.appendChild(opt);
  });

  // Auto-select category from context
  if (ctxType === 'deposit') {
    catSelect.value = 'Deposit';
  } else if (ctxType === 'sell-order') {
    catSelect.value = 'Sell Order';
  } else if (ctxType === 'transaction') {
    catSelect.value = 'Transaction';
  }

  // Back button
  page.querySelector('#back-to-tickets').addEventListener('click', () => navigate('my-tickets'));

  // Category change handler — show/hide transaction selector and TX hash field
  catSelect.addEventListener('change', () => {
    const cat = catSelect.value;
    const txSection = page.querySelector('#tx-selector-section');
    const txHashSection = page.querySelector('#tx-hash-section');

    // Reset selection when category changes
    selectedTxId = null;
    selectedTxType = null;
    resetTxSelectorUI(page);

    if (cat === 'Deposit' || cat === 'Sell Order') {
      txSection.classList.remove('hidden');
      const label = page.querySelector('#tx-selector-label');
      label.textContent = cat === 'Deposit' ? 'Select Deposit Transaction' : 'Select Sell Order';
      showTxList(page, cat);

      // TX Hash only for Deposit
      if (cat === 'Deposit') {
        txHashSection.classList.remove('hidden');
      } else {
        txHashSection.classList.add('hidden');
        page.querySelector('#ticket-tx-hash').value = '';
      }
    } else {
      txSection.classList.add('hidden');
      txHashSection.classList.add('hidden');
      page.querySelector('#ticket-tx-hash').value = '';
    }
  });

  // If context pre-selects a category, trigger the handler
  if (catSelect.value === 'Deposit' || catSelect.value === 'Sell Order') {
    catSelect.dispatchEvent(new Event('change'));
  }

  // Form submit
  page.querySelector('#ticket-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;

    const category = catSelect.value;
    const subject = page.querySelector('#ticket-subject').value.trim();
    const description = page.querySelector('#ticket-description').value.trim();
    const txHash = page.querySelector('#ticket-tx-hash').value.trim();

    const errorEl = page.querySelector('#ticket-error');
    errorEl.classList.add('hidden');

    // Validation
    if (!category) {
      showError(errorEl, 'Please select a category');
      return;
    }
    if (!subject) {
      showError(errorEl, 'Please enter a subject');
      return;
    }
    if (!description) {
      showError(errorEl, 'Please enter a description');
      return;
    }

    submitting = true;
    const btn = page.querySelector('#submit-ticket');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    try {
      // Determine linked IDs based on category + selection
      let depositId = null;
      let sellOrderId = null;

      if (category === 'Deposit' && selectedTxType === 'deposit' && selectedTxId) {
        depositId = selectedTxId;
      } else if (category === 'Sell Order' && selectedTxType === 'sell_order' && selectedTxId) {
        sellOrderId = selectedTxId;
      }

      const rpcParams = {
        p_category: category,
        p_subject: subject,
        p_description: description,
        p_related_deposit_id: depositId,
        p_related_sell_order_id: sellOrderId,
        p_reference_hash: (category === 'Deposit' && txHash) ? txHash : null,
        p_chat_session_id: null,
      };

      const { data, error } = await supabase.rpc('support_create_ticket', rpcParams);

      if (error) {
        showError(errorEl, sanitizeError(error.message));
        return;
      }

      // Extract ticket info from response
      const ticketId = data?.ticket_id;
      const ticketNumber = data?.ticket_number || 'your ticket';

      // Show success screen
      showSuccessScreen(page, ticketId, ticketNumber);
    } catch (err) {
      showError(errorEl, 'Something went wrong. Please try again.');
    } finally {
      // Always restore button state
      submitting = false;
      btn.disabled = false;
      btn.textContent = 'Submit Ticket';
    }
  });

  return page;
}

// =============================================================================
// Transaction selector — collapse / expand
// =============================================================================

/** Reset the selector UI: hide summary, show empty list */
function resetTxSelectorUI(page) {
  const summary = page.querySelector('#tx-selected-summary');
  const list = page.querySelector('#tx-selector-list');
  if (summary) summary.classList.add('hidden');
  if (list) {
    list.classList.remove('hidden');
    list.innerHTML = '<div class="flex items-center justify-center py-6"><div class="auth-spinner"></div></div>';
  }
}

/** Show the expandable list (called on initial load or when user taps summary) */
function showTxList(page, category) {
  const summary = page.querySelector('#tx-selected-summary');
  const list = page.querySelector('#tx-selector-list');
  summary.classList.add('hidden');
  list.classList.remove('hidden');
  loadTransactions(page, category);
}

/** Collapse the list and show the compact selected summary */
function collapseTxSelector(page, tx, category, type) {
  const summary = page.querySelector('#tx-selected-summary');
  const list = page.querySelector('#tx-selector-list');
  const labels = category === 'Deposit' ? depositStatusLabels : sellOrderStatusLabels;
  const colorClass = statusColors[tx.status] || statusColors.PENDING;
  const statusLabel = labels[tx.status] || tx.status;
  const ref = tx.id.slice(0, 8).toUpperCase();
  const dateStr = formatDateShort(tx.created_at);

  let amountStr;
  if (type === 'deposit') {
    amountStr = `${tx.amount} ${tx.asset || 'USDT'}`;
  } else {
    amountStr = `${tx.amount} USDT`;
  }

  page.querySelector('#tx-summary-line1').textContent = `#${ref}  ·  ${amountStr}`;
  const statusEl = page.querySelector('#tx-summary-status');
  statusEl.textContent = statusLabel;
  statusEl.className = `inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${colorClass}`;
  page.querySelector('#tx-summary-line2').textContent = dateStr;

  list.classList.add('hidden');
  summary.classList.remove('hidden');

  // Tap summary → re-expand list
  const handler = () => {
    summary.removeEventListener('click', handler);
    showTxList(page, category);
  };
  summary.addEventListener('click', handler);
}

async function loadTransactions(page, category) {
  const list = page.querySelector('#tx-selector-list');
  list.innerHTML = '<div class="flex items-center justify-center py-6"><div class="auth-spinner"></div></div>';

  // Load from cache or fetch
  if (!_cachedTxData) {
    const { data, error } = await supabase.rpc('support_get_user_recent_transactions');
    if (error) {
      list.innerHTML = `<div class="card p-4 text-center"><p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Unable to load transactions</p></div>`;
      return;
    }
    _cachedTxData = data || { deposits: [], sell_orders: [] };
  }

  const items = category === 'Deposit' ? _cachedTxData.deposits : _cachedTxData.sell_orders;

  if (!items || items.length === 0) {
    list.innerHTML = `<div class="card p-4 text-center"><p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">No ${category === 'Deposit' ? 'deposits' : 'sell orders'} found</p></div>`;
    return;
  }

  list.innerHTML = '';
  const type = category === 'Deposit' ? 'deposit' : 'sell_order';
  const labels = category === 'Deposit' ? depositStatusLabels : sellOrderStatusLabels;

  items.forEach((tx) => {
    const row = document.createElement('button');
    row.type = 'button';
    const statusLabel = labels[tx.status] || tx.status;
    const colorClass = statusColors[tx.status] || statusColors.PENDING;
    const ref = tx.id.slice(0, 8).toUpperCase();
    const dateStr = formatDateShort(tx.created_at);

    let amountStr;
    if (type === 'deposit') {
      amountStr = `${tx.amount} ${tx.asset || 'USDT'}`;
    } else {
      amountStr = `${tx.amount} USDT`;
    }

    row.className = 'flex items-center gap-3 rounded-xl border border-border-light dark:border-border-dark bg-surface-light dark:bg-surface-dark p-3 text-left transition-colors hover:border-action dark:hover:border-action-dark w-full';
    row.setAttribute('role', 'radio');
    row.setAttribute('aria-checked', 'false');
    row.innerHTML = `
      <span class="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 border-border-light dark:border-border-dark">
        <span class="tx-radio-dot hidden h-2 w-2 rounded-full bg-action dark:bg-action-dark"></span>
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="text-[12px] font-mono font-medium text-text-secondary dark:text-text-secondary-dark">#${ref}</span>
          <span class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${colorClass}">${statusLabel}</span>
        </div>
        <p class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark mt-0.5">${amountStr}</p>
      </div>
      <span class="text-[11px] text-text-secondary dark:text-text-secondary-dark flex-shrink-0">${dateStr}</span>
    `;

    row.addEventListener('click', () => {
      // Deselect all
      list.querySelectorAll('[role="radio"]').forEach((r) => {
        r.classList.remove('border-action', 'dark:border-action-dark');
        r.classList.add('border-border-light', 'dark:border-border-dark');
        r.querySelector('.tx-radio-dot')?.classList.add('hidden');
        r.setAttribute('aria-checked', 'false');
      });
      // Select this one
      row.classList.remove('border-border-light', 'dark:border-border-dark');
      row.classList.add('border-action', 'dark:border-action-dark');
      row.querySelector('.tx-radio-dot')?.classList.remove('hidden');
      row.setAttribute('aria-checked', 'true');

      selectedTxId = tx.id;
      selectedTxType = type;

      // Collapse the list and show compact summary
      setTimeout(() => collapseTxSelector(page, tx, category, type), 150);
    });

    list.appendChild(row);
  });
}

// =============================================================================
// Success screen
// =============================================================================

function showSuccessScreen(page, ticketId, ticketNumber) {
  const form = page.querySelector('#ticket-form');
  form.innerHTML = `
    <div class="flex flex-col items-center py-10 text-center">
      <div class="flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10 dark:bg-green-500/15 mb-5">
        <svg class="h-8 w-8 text-green-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
        </svg>
      </div>
      <h2 class="text-[18px] font-semibold text-text-primary dark:text-text-primary-dark mb-2">Ticket Created</h2>
      <p class="text-[14px] text-text-secondary dark:text-text-secondary-dark mb-1">Your support ticket</p>
      <p class="text-[20px] font-bold font-mono text-text-primary dark:text-text-primary-dark mb-6">${escapeHtml(ticketNumber)}</p>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-6">has been created successfully.</p>
      <div class="flex flex-col gap-3 w-full max-w-[240px]">
        ${ticketId ? `<button id="success-view-ticket" class="btn-primary w-full py-2.5 text-[13px] font-medium rounded-xl">View Ticket</button>` : ''}
        <button id="success-back-help" class="btn-secondary w-full py-2.5 text-[13px] font-medium rounded-xl">Back to Help & Support</button>
      </div>
    </div>
  `;

  if (ticketId) {
    form.querySelector('#success-view-ticket')?.addEventListener('click', () => {
      navigate(`ticket-detail?id=${ticketId}`);
    });
  }
  form.querySelector('#success-back-help')?.addEventListener('click', () => {
    navigate('help-support');
  });
}

// =============================================================================
// Helpers
// =============================================================================

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function sanitizeError(msg) {
  // Don't expose internal SQL/RPC errors to users
  if (!msg) return 'Something went wrong. Please try again.';
  const lower = msg.toLowerCase();
  if (lower.includes('raise exception') || lower.includes('function') || lower.includes('sql') || lower.includes('permission')) {
    return 'Something went wrong. Please try again.';
  }
  return msg;
}

function formatDateShort(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
