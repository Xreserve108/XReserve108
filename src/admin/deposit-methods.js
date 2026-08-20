import { supabase } from '@/lib/supabase';
import { requireVerification } from '@/components/TotpDialog';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import QRCode from 'qrcode';

const copyIcon = `<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-12A1.125 1.125 0 011.5 20.625V7.5a1.125 1.125 0 011.125-1.125H6m11.5-3v10.5a1.125 1.125 0 01-1.125 1.125H5.625m12.75-12.75h.008v.008h-.008V3.75zM19.5 8.25h.008v.008H19.5V8.25zm0 4.5h.008v.008H19.5v-.008zm0 4.5h.008v.008H19.5v-.008zM15 3.75h.008v.008H15V3.75zm4.5 0h.008v.008H19.5V3.75z"/></svg>`;
const checkIcon = `<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`;
const qrPlaceholderIcon = `<svg class="h-10 w-10 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5z"/><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 14.625v2.25m0 4.5v-2.25m3.375-2.25h2.25m-4.5 0h-2.25m4.5 0h-2.25m-2.25 3.375v2.25m3.375-5.625v2.25m0-4.5v2.25m0 0v-2.25"/></svg>`;

const SUPPORTED_NETWORKS = ['TRC20', 'BEP20'];

export function renderDepositMethods() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col px-5 pb-8 pt-8 md:px-8 lg:px-12';

  page.innerHTML = `
    <h1 class="page-title">Active Deposit Methods</h1>
    <p class="text-muted mt-1 mb-6">Configure cryptocurrency deposit addresses</p>
    <div id="deposit-methods-content" class="flex items-center justify-center py-12">
      <div class="auth-spinner"></div>
    </div>
  `;

  loadDepositMethods(page);
  return page;
}

/**
 * Render deposit methods content without page wrapper — for embedding in Settings tabs.
 */
export function renderDepositMethodsContent() {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div id="deposit-methods-content" class="flex items-center justify-center py-8">
      <div class="auth-spinner"></div>
    </div>
  `;
  loadDepositMethods(wrapper);
  return wrapper;
}

async function loadDepositMethods(page) {
  const container = page.querySelector('#deposit-methods-content');
  try {
    const { data, error } = await supabase.rpc('admin_list_deposit_methods');
    if (error) throw error;

    // Build a map of existing methods by network
    const methodMap = {};
    (data || []).forEach(m => { methodMap[m.network] = m; });

    // Ensure both networks are represented
    SUPPORTED_NETWORKS.forEach(net => {
      if (!methodMap[net]) {
        methodMap[net] = { network: net, asset: 'USDT', deposit_address: null, is_active: false };
      }
    });

    container.className = 'space-y-4';
    container.innerHTML = '';

    SUPPORTED_NETWORKS.forEach(net => {
      container.appendChild(renderMethodCard(methodMap[net]));
    });
  } catch (err) {
    container.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">${escapeHtml(err.message || 'Failed to load deposit methods')}</p></div>`;
  }
}

function renderMethodCard(method) {
  const card = document.createElement('div');
  card.className = 'card p-5';
  card.dataset.network = method.network;

  const isActive = method.is_active;
  const addr = method.deposit_address;
  const hasAddr = addr && addr.trim().length > 0;
  const displayAddr = hasAddr ? truncateAddress(addr) : null;

  card.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-full ${isActive ? 'bg-green-500/10 dark:bg-green-500/20' : 'bg-black/[0.04] dark:bg-white/[0.06]'}">
          <span class="text-[13px] font-bold ${isActive ? 'text-green-600 dark:text-green-400' : 'text-text-secondary dark:text-text-secondary-dark'}">${method.network === 'TRC20' ? 'T' : 'B'}</span>
        </div>
        <div>
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">${method.network}</p>
          <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">${method.asset}</p>
        </div>
      </div>
      <span class="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${isActive ? 'bg-green-500/10 text-green-700 dark:bg-green-500/20 dark:text-green-400' : 'bg-black/[0.04] text-text-secondary dark:bg-white/[0.06] dark:text-text-secondary-dark'}">
        ${isActive ? 'ACTIVE' : 'INACTIVE'}
      </span>
    </div>

    <div class="space-y-3">
      <div>
        <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark mb-1.5">Deposit Address</p>
        ${hasAddr ? `
          <div class="flex items-center gap-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] px-3 py-2.5">
            <p class="flex-1 truncate font-mono text-[13px] text-text-primary dark:text-text-primary-dark select-all" title="${escapeHtml(addr)}">${escapeHtml(displayAddr)}</p>
            <button class="dm-copy-btn flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.08]" data-address="${escapeHtml(addr)}" aria-label="Copy address">${copyIcon}</button>
          </div>
        ` : `<p class="text-[13px] text-text-secondary dark:text-text-secondary-dark italic">Not configured</p>`}
      </div>

      <div>
        <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark mb-1.5">QR Code</p>
        <div class="dm-qr-preview flex items-center justify-center rounded-xl bg-black/[0.03] dark:bg-white/[0.04] p-4 min-h-[120px]">
          ${hasAddr
            ? `<div class="dm-qr-gen flex flex-col items-center gap-2"><div class="auth-spinner"></div><span class="text-[11px] text-text-secondary dark:text-text-secondary-dark">Generating QR…</span></div>`
            : `<div class="flex flex-col items-center gap-2 text-text-secondary dark:text-text-secondary-dark">${qrPlaceholderIcon}<span class="text-[11px]">Set address to generate QR</span></div>`
          }
        </div>
      </div>

      <div class="flex flex-wrap gap-2 pt-1">
        <button class="dm-edit-addr btn-secondary flex-1 min-w-[120px] text-[13px] py-2.5">${hasAddr ? 'Edit Address' : 'Set Address'}</button>
        <button class="dm-toggle-active ${isActive ? 'btn-secondary text-red-600 dark:text-red-400' : 'btn-primary'} flex-1 min-w-[120px] text-[13px] py-2.5">${isActive ? 'Deactivate' : 'Activate'}</button>
      </div>
    </div>
    <div class="dm-feedback hidden mt-3"></div>
  `;

  // Generate QR code client-side from deposit address (deterministic)
  if (hasAddr) {
    generateQRIntoCard(card, addr);
  }

  // Wire up events
  // Copy address
  const copyBtn = card.querySelector('.dm-copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const address = copyBtn.dataset.address;
      navigator.clipboard?.writeText(address);
      copyBtn.innerHTML = checkIcon;
      showFeedback(card, 'Address copied', 'green');
      setTimeout(() => { copyBtn.innerHTML = copyIcon; }, 2000);
    });
  }

  // Edit address
  card.querySelector('.dm-edit-addr').addEventListener('click', () => {
    handleEditAddress(card, method);
  });

  // Toggle active
  card.querySelector('.dm-toggle-active').addEventListener('click', () => {
    handleToggleActive(card, method);
  });

  return card;
}

/**
 * Generate a QR code deterministically from the deposit address and render it
 * into the card's QR preview area. Uses the same `qrcode` library already used
 * for TOTP enrollment QR codes. The QR is always a faithful representation of
 * the configured address — there is no independent QR image to manage.
 */
async function generateQRIntoCard(card, address) {
  const qrContainer = card.querySelector('.dm-qr-gen');
  if (!qrContainer) return;

  try {
    const dataUrl = await QRCode.toDataURL(address, {
      width: 160,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
    qrContainer.innerHTML = `<img src="${dataUrl}" alt="QR code for ${escapeHtml(address)}" class="rounded-lg" style="width:140px;height:140px" />`;
  } catch {
    qrContainer.innerHTML = `<p class="text-[11px] text-text-secondary dark:text-text-secondary-dark text-center">QR generation failed</p>`;
  }
}

// ---------------------------------------------------------------------------
// Edit Address
// ---------------------------------------------------------------------------
async function handleEditAddress(card, method) {
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4';
  overlay.innerHTML = `
    <div class="card w-full max-w-sm p-6 step-enter">
      <h3 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Edit Deposit Address</h3>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">${method.network} — Enter the deposit address</p>
      <label class="label" for="dm-addr-input">Deposit Address</label>
      <input type="text" class="input-field font-mono text-[13px]" placeholder="Enter ${method.network} address" value="${escapeHtml(method.deposit_address || '')}" id="dm-addr-input" autocomplete="off" spellcheck="false" />
      <div class="dm-addr-error hidden mt-2 text-[13px] text-red-600 dark:text-red-400"></div>
      <div class="flex gap-3 mt-4">
        <button class="btn-secondary flex-1" id="dm-addr-cancel">Cancel</button>
        <button class="btn-primary flex-1" id="dm-addr-save" disabled>Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#dm-addr-input');
  const saveBtn = overlay.querySelector('#dm-addr-save');
  const cancelBtn = overlay.querySelector('#dm-addr-cancel');
  const errorEl = overlay.querySelector('.dm-addr-error');

  input.addEventListener('input', () => {
    errorEl.classList.add('hidden');
    saveBtn.disabled = input.value.trim().length === 0;
  });

  cancelBtn.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  saveBtn.addEventListener('click', async () => {
    const address = input.value.trim();
    if (!address) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const verificationId = await requireVerification('Confirm Address Change', 'admin_settings');
      saveBtn.textContent = 'Updating...';

      const { error } = await supabase.rpc('admin_upsert_deposit_method', {
        p_network: method.network,
        p_deposit_address: address,
        p_is_active: method.is_active,
        p_verification_id: verificationId,
      });

      if (error) throw error;

      overlay.remove();
      showFeedback(card, 'Deposit address updated', 'green');
      refreshCard(card, method.network);
    } catch (err) {
      if (err.message !== 'cancelled' && err.message !== "cancelled") {
        errorEl.textContent = err.message || 'Failed to save address';
        errorEl.classList.remove('hidden');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    }
  });

  setTimeout(() => input.focus(), 100);
}

// ---------------------------------------------------------------------------
// Toggle Active/Inactive
// ---------------------------------------------------------------------------
function handleToggleActive(card, method) {
  if (!method.id) {
    showFeedback(card, 'Configure an address before activating.', 'amber');
    return;
  }

  const newActive = !method.is_active;
  const action = newActive ? 'activate' : 'deactivate';

  const dialog = ConfirmDialog({
    title: `${newActive ? 'Activate' : 'Deactivate'} ${method.network}`,
    message: newActive
      ? `This will make ${method.network} available as a deposit method for users.`
      : `This will hide ${method.network} from users. The configuration will be preserved.`,
    confirmLabel: newActive ? 'Activate' : 'Deactivate',
    destructive: !newActive,
    onConfirm: async () => {
      try {
        const verificationId = await requireVerification(`Confirm ${action.charAt(0).toUpperCase() + action.slice(1)}`, 'admin_settings');

        const { error } = await supabase.rpc('admin_toggle_deposit_method', {
          p_method_id: method.id,
          p_is_active: newActive,
          p_verification_id: verificationId,
        });

        if (error) throw error;

        showFeedback(card, `${method.network} ${newActive ? 'activated' : 'deactivated'}`, 'green');
        refreshCard(card, method.network);
      } catch (err) {
        if (err.message !== 'cancelled' && err.message !== "cancelled") {
          showFeedback(card, err.message || `Failed to ${action} ${method.network}`, 'red');
        }
      }
    },
  });

  document.body.appendChild(dialog);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function refreshCard(card, network) {
  // Reload the entire deposit methods list
  const container = document.getElementById('deposit-methods-content');
  if (container) {
    const page = container.closest('main') || container.parentElement;
    container.className = 'flex items-center justify-center py-12';
    container.innerHTML = '<div class="auth-spinner"></div>';
    await loadDepositMethods(page);
  }
}

function truncateAddress(addr) {
  if (!addr || addr.length <= 16) return addr;
  return addr.slice(0, 10) + '...' + addr.slice(-6);
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showFeedback(card, message, color) {
  const el = card.querySelector('.dm-feedback');
  if (!el) return;
  el.className = `dm-feedback mt-3 rounded-xl px-4 py-2.5 text-[13px] font-medium ${
    color === 'green' ? 'bg-green-500/10 text-green-600 dark:text-green-400' :
    color === 'red' ? 'bg-red-500/10 text-red-600 dark:text-red-400' :
    'bg-amber-500/10 text-amber-600 dark:text-amber-400'
  }`;
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => { el.classList.add('hidden'); }, 4000);
}
