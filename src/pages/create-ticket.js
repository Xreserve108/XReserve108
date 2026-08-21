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

      <!-- Optional Reference -->
      <div id="reference-section" class="hidden">
        <label class="block text-[13px] font-medium text-text-primary dark:text-text-primary-dark mb-1.5">Related Reference</label>
        <div id="reference-info" class="rounded-xl bg-black/[0.03] dark:bg-white/[0.05] px-4 py-3 text-[13px] text-text-secondary dark:text-text-secondary-dark"></div>
      </div>

      <!-- Optional TX Hash -->
      <div>
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

  // Load contextual reference info
  if (ctxType && ctxId) {
    loadContextInfo(ctxType, ctxId, page);
  }

  // Back button
  page.querySelector('#back-to-tickets').addEventListener('click', () => navigate('my-tickets'));

  // Form submit
  page.querySelector('#ticket-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitting) return;

    const category = catSelect.value;
    const subject = page.querySelector('#ticket-subject').value.trim();
    const description = page.querySelector('#ticket-description').value.trim();
    const txHash = page.querySelector('#ticket-tx-hash').value.trim();

    // Validation
    const errorEl = page.querySelector('#ticket-error');
    errorEl.classList.add('hidden');

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

    // Build params
    const rpcParams = {
      p_category: category,
      p_subject: subject,
      p_description: description,
      p_related_deposit_id: ctxType === 'deposit' ? ctxId : null,
      p_related_sell_order_id: ctxType === 'sell-order' ? ctxId : null,
      p_reference_hash: txHash || null,
      p_chat_session_id: null,
    };

    const { data, error } = await supabase.rpc('support_create_ticket', rpcParams);

    if (error) {
      submitting = false;
      btn.disabled = false;
      btn.textContent = 'Submit Ticket';
      showError(errorEl, error.message || 'Failed to create ticket');
      return;
    }

    // Navigate to the ticket detail
    navigate(`ticket-detail?id=${data.ticket_id}`);
  });

  return page;
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function loadContextInfo(ctxType, ctxId, page) {
  const refSection = page.querySelector('#reference-section');
  const refInfo = page.querySelector('#reference-info');

  if (ctxType === 'deposit') {
    const { data, error } = await supabase
      .from('deposits')
      .select('id, expected_amount, network, status, tx_hash, created_at')
      .eq('id', ctxId)
      .single();

    if (!error && data) {
      refSection.classList.remove('hidden');
      refInfo.innerHTML = `
        <p class="font-medium text-text-primary dark:text-text-primary-dark">Deposit</p>
        <p>ID: ${data.id.slice(0, 8).toUpperCase()}</p>
        <p>${data.expected_amount} USDT via ${data.network}</p>
        <p>Status: ${data.status}</p>
      `;
    }
  } else if (ctxType === 'sell-order') {
    const { data, error } = await supabase
      .from('sell_orders')
      .select('id, usdt_amount, inr_amount, status, created_at')
      .eq('id', ctxId)
      .single();

    if (!error && data) {
      refSection.classList.remove('hidden');
      refInfo.innerHTML = `
        <p class="font-medium text-text-primary dark:text-text-primary-dark">Sell Order</p>
        <p>ID: ${data.id.slice(0, 8).toUpperCase()}</p>
        <p>${data.usdt_amount} USDT → ₹${data.inr_amount} INR</p>
        <p>Status: ${data.status}</p>
      `;
    }
  }
}
