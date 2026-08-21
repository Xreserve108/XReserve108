import { supabase } from '@/lib/supabase';
import { StatusBadge } from '@/components/StatusBadge';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { requireVerification } from '@/components/TotpDialog';
import { refreshWalletBalance } from '@/data/wallet-data';

const filters = ['All', 'Payment Pending', 'Completed', 'Rejected', 'Cancelled', 'Manual Review'];
const filterMap = { 'All': null, 'Payment Pending': 'PAYMENT_PENDING', 'Completed': 'COMPLETED', 'Rejected': 'REJECTED', 'Cancelled': 'CANCELLED', 'Manual Review': 'MANUAL_REVIEW' };

export function renderAdminSellOrders() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col px-5 pb-8 pt-8 md:px-8 lg:px-12';

  let activeFilter = 'All';
  let orders = [];
  let detailOverlay = null;

  page.innerHTML = `
    <h1 class="page-title">Sell Orders</h1>
    <p class="text-muted mt-1 mb-6">Manage sell orders and settlements</p>
    <div class="mb-5 flex gap-2 overflow-x-auto scrollbar-hide" id="order-filters"></div>
    <div id="order-content" class="flex items-center justify-center py-12">
      <div class="auth-spinner"></div>
    </div>
  `;

  // Render filter tabs
  const filterBar = page.querySelector('#order-filters');
  filters.forEach((f) => {
    const btn = document.createElement('button');
    btn.className = `whitespace-nowrap rounded-full px-4 py-2 text-[13px] font-medium transition-colors duration-150 ${
      f === activeFilter ? 'tab-active' : 'tab-inactive'
    }`;
    btn.textContent = f;
    btn.dataset.filter = f;
    btn.addEventListener('click', () => {
      activeFilter = f;
      filterBar.querySelectorAll('button').forEach((b) => {
        b.className = `whitespace-nowrap rounded-full px-4 py-2 text-[13px] font-medium transition-colors duration-150 ${
          b.dataset.filter === activeFilter ? 'tab-active' : 'tab-inactive'
        }`;
      });
      loadOrders();
    });
    filterBar.appendChild(btn);
  });

  async function loadOrders() {
    const content = page.querySelector('#order-content');
    content.innerHTML = '<div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>';

    const statusParam = filterMap[activeFilter];
    const { data, error } = await supabase.rpc('admin_list_sell_orders', { p_status: statusParam });

    if (error) {
      content.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">Failed to load orders</p><p class="mt-1 text-[12px] text-text-secondary dark:text-text-secondary-dark">${error.message}</p></div>`;
      return;
    }

    orders = data || [];
    renderList(content);
  }

  function renderList(container) {
    if (orders.length === 0) {
      container.innerHTML = `
        <div class="card flex flex-col items-center py-16 text-center">
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
            <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3.75 3H7.5c-2.485 0-4.5-2.015-4.5-4.5V8.25c0-2.485 2.015-4.5 4.5-4.5h9c2.485 0 4.5 2.015 4.5 4.5v8.25c0 2.485-2.015 4.5-4.5 4.5z"/></svg>
          </div>
          <p class="mt-4 text-[14px] font-medium text-text-primary dark:text-text-primary-dark">No orders found</p>
          <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">Try a different filter</p>
        </div>
      `;
      return;
    }

    container.className = 'stagger flex flex-col gap-3';
    container.innerHTML = '';
    orders.forEach((o) => container.appendChild(createOrderCard(o)));
  }

  function createOrderCard(o) {
    const card = document.createElement('div');
    card.className = 'card card-interactive p-4';
    card.innerHTML = `
      <div class="flex items-start justify-between mb-3">
        <div>
          <p class="text-[14px] font-medium text-text-primary dark:text-text-primary-dark">${o.user_email || 'Unknown'}</p>
          <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">${new Date(o.created_at).toLocaleDateString()}</p>
        </div>
        <div class="badge-slot"></div>
      </div>
      <div class="flex items-center justify-between">
        <div>
          <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">USDT</p>
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">${Number(o.usdt_amount).toFixed(2)}</p>
        </div>
        <div class="text-center">
          <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">Rate</p>
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">${Number(o.exchange_rate).toFixed(2)}</p>
        </div>
        <div class="text-right">
          <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">INR</p>
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">${Number(o.inr_amount).toLocaleString('en-IN')}</p>
        </div>
      </div>
      <div class="mt-2 text-[11px] text-text-secondary dark:text-text-secondary-dark">${o.bank_name} · ${o.account_holder_name}</div>
    `;
    card.querySelector('.badge-slot').appendChild(StatusBadge({ status: o.status }));
    card.addEventListener('click', () => showOrderDetail(o));
    return card;
  }

  function showOrderDetail(o) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[90] flex items-end justify-center bg-black/40 backdrop-blur-sm md:items-center';
    detailOverlay = overlay;

    const modal = document.createElement('div');
    modal.className = 'card w-full max-w-md max-h-[85vh] overflow-y-auto p-6 step-enter md:rounded-3xl';
    modal.innerHTML = `
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark">Order Detail</h2>
        <button class="flex h-8 w-8 items-center justify-center rounded-xl text-text-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.06]" id="close-detail">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="mb-4" id="detail-badge"></div>
      <div class="space-y-3 mb-6">
        ${detailRow('User', o.user_email)}
        ${detailRow('USDT Amount', Number(o.usdt_amount).toFixed(2))}
        ${detailRow('INR Amount', Number(o.inr_amount).toLocaleString('en-IN'))}
        ${detailRow('Exchange Rate', Number(o.exchange_rate).toFixed(4))}
        <div class="divider my-1"></div>
        ${detailRow('Bank', o.bank_name)}
        ${detailRow('Account Holder', o.account_holder_name)}
        ${detailRow('Account Number', o.account_number)}
        ${detailRow('IFSC', o.ifsc_code)}
        <div class="divider my-1"></div>
        ${detailRow('Created', new Date(o.created_at).toLocaleString())}
        ${detailRow('Updated', new Date(o.updated_at).toLocaleString())}
      </div>
      <div id="detail-actions" class="space-y-2"></div>
      <div id="detail-feedback" class="hidden mt-3"></div>
    `;

    modal.querySelector('#detail-badge').appendChild(StatusBadge({ status: o.status }));
    modal.querySelector('#close-detail').addEventListener('click', () => { overlay.remove(); detailOverlay = null; });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); detailOverlay = null; } });

    // Actions
    const actionsEl = modal.querySelector('#detail-actions');
    const canAct = ['PAYMENT_PENDING', 'PAYMENT_PROOF_UPLOADED', 'MANUAL_REVIEW'].includes(o.status);

    if (canAct) {
      const completeBtn = document.createElement('button');
      completeBtn.className = 'btn-primary w-full';
      completeBtn.textContent = 'Complete Order';
      completeBtn.addEventListener('click', () => {
        showCompletionChecklist(o);
      });
      actionsEl.appendChild(completeBtn);

      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'btn-secondary w-full text-red-600 dark:text-red-400';
      rejectBtn.textContent = 'Reject Order';
      rejectBtn.addEventListener('click', () => {
        showConfirm(modal, 'Reject Order', 'Release reserved USDT and mark order as rejected?', 'Reject', true, () => handleReject(o.id, 'REJECTED', modal, overlay));
      });
      actionsEl.appendChild(rejectBtn);
    }

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  function showConfirm(parentModal, title, message, confirmLabel, destructive, onConfirm) {
    const dialog = ConfirmDialog({ title, message, confirmLabel, destructive, onConfirm });
    document.body.appendChild(dialog);
  }

  // Checklist-style confirmation before completing a sell order, mirroring the
  // manual deposit verification pattern. Completion itself (admin 2FA + RPC)
  // happens only after every item is explicitly checked.
  function showCompletionChecklist(o) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[100] flex items-end justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4';
    overlay.innerHTML = `
      <div class="card w-full max-w-md rounded-b-none sm:rounded-3xl p-6 step-enter max-h-[90dvh] flex flex-col">
        <div class="flex-shrink-0">
          <h3 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Complete Order</h3>
          <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">The user's USDT was reserved when the order was created. Independently confirm each item before completing — completion consumes the reserved USDT and cannot be undone.</p>
        </div>
        <div class="flex-1 overflow-y-auto space-y-2.5 pr-1">
          ${checklistItem('payment', 'INR payment has been sent to the bank account shown in the order')}
          ${checklistItem('amount', 'Paid INR amount matches the order INR amount')}
          ${checklistItem('holder', 'Account holder name verified against the order')}
          ${checklistItem('reference', 'Payment reference/UTR recorded for audit')}
        </div>
        <div class="flex-shrink-0 flex gap-3 mt-5">
          <button id="cl-cancel" class="btn-secondary flex-1">Cancel</button>
          <button id="cl-confirm" class="btn-primary flex-1" disabled>Complete Order</button>
        </div>
        <div id="detail-feedback" class="hidden mt-3"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    const card = overlay.firstElementChild;
    const checkboxes = overlay.querySelectorAll('.checklist-cb');
    const confirmBtn = overlay.querySelector('#cl-confirm');

    const updateConfirmBtn = () => {
      confirmBtn.disabled = !Array.from(checkboxes).every((cb) => cb.checked);
    };
    checkboxes.forEach((cb) => cb.addEventListener('change', updateConfirmBtn));

    overlay.querySelector('#cl-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    confirmBtn.addEventListener('click', () => handleComplete(o.id, card, overlay));
  }

  function checklistItem(key, label) {
    return `<label class="flex items-start gap-2.5 cursor-pointer"><input type="checkbox" class="checklist-cb mt-0.5 h-4 w-4 rounded border-border-light dark:border-border-dark accent-action dark:accent-action-dark" data-key="${key}" /><span class="text-[12px] text-text-primary dark:text-text-primary-dark">${label}</span></label>`;
  }

  async function handleComplete(orderId, modal, overlay) {
    try {
      const verificationId = await requireVerification('Complete Order', 'admin_financial');
      showFeedback(modal, 'Processing...', 'amber');
      const { error } = await supabase.rpc('admin_complete_sell_order', { p_order_id: orderId, p_verification_id: verificationId });
      if (error) {
        showFeedback(modal, error.message, 'red');
        return;
      }
      showFeedback(modal, 'Order completed successfully', 'green');
      refreshWalletBalance();
      // Close both the checklist overlay and the detail overlay
      setTimeout(() => {
        overlay.remove();
        if (detailOverlay) { detailOverlay.remove(); detailOverlay = null; }
        loadOrders();
      }, 800);
    } catch {
      showFeedback(modal, 'Verification cancelled', 'amber');
    }
  }

  async function handleReject(orderId, status, modal, overlay) {
    try {
      const verificationId = await requireVerification('Reject Order', 'admin_financial');
      showFeedback(modal, 'Processing...', 'amber');
      const { error } = await supabase.rpc('admin_reject_sell_order', { p_order_id: orderId, p_status: status, p_verification_id: verificationId });
      if (error) {
        showFeedback(modal, error.message, 'red');
        return;
      }
      showFeedback(modal, 'Order rejected', 'green');
      refreshWalletBalance();
      setTimeout(() => {
        overlay.remove();
        if (detailOverlay) { detailOverlay.remove(); detailOverlay = null; }
        loadOrders();
      }, 800);
    } catch {
      showFeedback(modal, 'Verification cancelled', 'amber');
    }
  }

  function showFeedback(modal, message, color) {
    const el = modal.querySelector('#detail-feedback');
    el.className = `mt-3 rounded-xl px-4 py-3 text-[13px] font-medium ${
      color === 'green' ? 'bg-green-500/10 text-green-600 dark:text-green-400' :
      color === 'red' ? 'bg-red-500/10 text-red-600 dark:text-red-400' :
      'bg-amber-500/10 text-amber-600 dark:text-amber-400'
    }`;
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function detailRow(label, value) {
    return `<div class="flex items-center justify-between py-1"><span class="text-[13px] text-text-secondary dark:text-text-secondary-dark">${label}</span><span class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark text-right max-w-[60%] truncate">${value}</span></div><div class="divider"></div>`;
  }

  loadOrders();
  return page;
}
