import { supabase } from '@/lib/supabase';
import { StatusBadge } from '@/components/StatusBadge';
import { ConfirmDialog } from '@/components/admin/ConfirmDialog';
import { requireVerification } from '@/components/TotpDialog';
import { refreshWalletBalance } from '@/data/wallet-data';

// Short-lived credit continuations issued by admin_manually_verify_deposit
// (server-side: bound to this admin + deposit, single-use, ~5 min expiry).
// Allows the immediate Credit action right after a manual verification
// without a second 2FA prompt. Client-side expiry mirrors the server's.
const creditContinuations = new Map(); // depositId -> { id, expiresAt }

const filters = ['All', 'Pending Verification', 'Awaiting Manual Review', 'Pending', 'Under Review', 'Credited', 'Rejected'];
const filterMap = {
  'All': null,
  'Pending Verification': 'PENDING_VERIFICATION_AWAITING_BLOCKCHAIN',
  'Awaiting Manual Review': 'PENDING_VERIFICATION_AWAITING_MANUAL',
  'Pending': 'PENDING',
  'Under Review': 'UNDER_REVIEW',
  'Credited': 'CREDITED',
  'Rejected': 'REJECTED'
};

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function shortAddr(addr) {
  if (!addr) return '—';
  if (addr.length <= 16) return addr;
  return addr.slice(0, 8) + '…' + addr.slice(-6);
}

function formatAmount(num) {
  if (num === null || num === undefined) return '—';
  return Number(num).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export function renderAdminDeposits() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-120px)] flex-col px-5 pb-8 pt-8 md:px-8 lg:px-12';

  let activeFilter = 'All';
  let deposits = [];

  page.innerHTML = `
    <h1 class="page-title">Deposits</h1>
    <p class="text-muted mt-1 mb-6">Manage user deposits and wallet credits</p>
    <div class="mb-5 flex gap-2 overflow-x-auto scrollbar-hide" id="deposit-filters"></div>
    <div id="deposit-content" class="flex items-center justify-center py-12">
      <div class="auth-spinner"></div>
    </div>
  `;

  // Render filter tabs
  const filterBar = page.querySelector('#deposit-filters');
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
      loadDeposits();
    });
    filterBar.appendChild(btn);
  });

  async function loadDeposits() {
    const content = page.querySelector('#deposit-content');
    content.innerHTML = '<div class="flex items-center justify-center py-12"><div class="auth-spinner"></div></div>';

    // Map custom filters to RPC calls
    let result;
    if (activeFilter === 'Pending Verification') {
      // Deposits awaiting blockchain verification
      const { data, error } = await supabase.rpc('admin_list_pending_blockchain_verification');
      if (error) {
        content.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">Failed to load deposits</p><p class="mt-1 text-[12px] text-text-secondary dark:text-text-secondary-dark">${error.message}</p></div>`;
        return;
      }
      // Map to the standard shape
      result = (data || []).map(d => ({
        id: d.id, user_id: d.user_id, user_email: d.user_email,
        network: d.network, token: d.token, expected_amount: d.declared_amount,
        actual_amount: null, tx_hash: d.tx_hash, status: d.status,
        created_at: d.created_at, updated_at: d.created_at,
        verified_amount: null, blockchain_verified_at: null, manually_verified_at: null
      }));
    } else if (activeFilter === 'Awaiting Manual Review') {
      // Deposits blockchain-verified, awaiting manual admin verification
      const { data, error } = await supabase.rpc('admin_list_blockchain_verified_deposits');
      if (error) {
        content.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">Failed to load deposits</p><p class="mt-1 text-[12px] text-text-secondary dark:text-text-secondary-dark">${error.message}</p></div>`;
        return;
      }
      result = (data || []).map(d => ({
        id: d.id, user_id: d.user_id, user_email: d.user_email,
        network: d.network, token: d.token, expected_amount: d.declared_amount,
        actual_amount: null, tx_hash: d.tx_hash, status: d.status,
        created_at: d.created_at, updated_at: d.blockchain_verified_at,
        verified_amount: d.verified_amount, blockchain_verified_at: d.blockchain_verified_at, manually_verified_at: null
      }));
    } else {
      // Standard filter
      const statusParam = filterMap[activeFilter];
      const { data, error } = await supabase.rpc('admin_list_deposits', { p_status: statusParam });
      if (error) {
        content.innerHTML = `<div class="card p-6 text-center"><p class="text-[14px] text-red-600 dark:text-red-400">Failed to load deposits</p><p class="mt-1 text-[12px] text-text-secondary dark:text-text-secondary-dark">${error.message}</p></div>`;
        return;
      }
      result = data || [];
    }

    deposits = result;
    renderList(content);
  }

  function renderList(container) {
    if (deposits.length === 0) {
      container.className = '';
      container.innerHTML = `
        <div class="card flex flex-col items-center py-16 text-center">
          <div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
            <svg class="h-5 w-5 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18.75a60.07 60.07 0 0115.797 2.101c.727.198 1.453-.342 1.857-1.012l.018-.031a60.068 60.068 0 00-1.376-2.042c-.303-.442-.922-.547-1.342-.267A55.04 55.04 0 019.75 18M12 12a3.75 3.75 0 00-3.75 3.75V18"/></svg>
          </div>
          <p class="mt-4 text-[14px] font-medium text-text-primary dark:text-text-primary-dark">No deposits found</p>
          <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">Try a different filter</p>
        </div>
      `;
      return;
    }

    container.className = 'stagger flex flex-col gap-3';
    container.innerHTML = '';
    deposits.forEach((d) => container.appendChild(createDepositCard(d)));
  }

  function createDepositCard(d) {
    const card = document.createElement('div');
    card.className = 'card card-interactive p-4';
    // Build subtitle showing verification stage
    let subtitle = '';
    if (d.status === 'PENDING_VERIFICATION') {
      if (d.verified_amount && d.manually_verified_at) {
        subtitle = `Verified: ${formatAmount(d.verified_amount)} USDT · Manually Verified`;
      } else if (d.verified_amount) {
        subtitle = `Verified: ${formatAmount(d.verified_amount)} USDT · Awaiting Manual Review`;
      } else {
        subtitle = 'Awaiting Blockchain Verification';
      }
    }
    card.innerHTML = `
      <div class="flex items-start justify-between mb-3">
        <div>
          <p class="text-[14px] font-medium text-text-primary dark:text-text-primary-dark">${escapeHtml(d.user_email) || 'Unknown'}</p>
          <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">${new Date(d.created_at).toLocaleDateString()}</p>
        </div>
        <div class="badge-slot"></div>
      </div>
      <div class="flex items-center justify-between">
        <div>
          <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">Declared</p>
          <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">${formatAmount(d.expected_amount)} ${d.token}</p>
        </div>
        <div class="text-right">
          <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">Verified</p>
          <p class="text-[15px] font-semibold ${d.verified_amount ? 'text-green-600 dark:text-green-400' : 'text-text-secondary dark:text-text-secondary-dark'}">${d.verified_amount ? formatAmount(d.verified_amount) : '—'}</p>
        </div>
      </div>
      ${subtitle ? `<p class="mt-2 text-[11px] text-text-secondary dark:text-text-secondary-dark">${escapeHtml(subtitle)}</p>` : ''}
      <div class="mt-2 text-[11px] text-text-secondary dark:text-text-secondary-dark">${escapeHtml(d.network)} ${d.tx_hash ? '· ' + escapeHtml(d.tx_hash).slice(0, 10) + '…' : ''}</div>
    `;
    card.querySelector('.badge-slot').appendChild(StatusBadge({ status: d.status }));
    card.addEventListener('click', () => openDepositDetail(d.id));
    return card;
  }

  async function openDepositDetail(depositId) {
    // Fetch full verification details
    const { data: detail, error } = await supabase.rpc('get_deposit_verification_details', { p_deposit_id: depositId });
    if (error) {
      alert('Failed to load deposit details: ' + error.message);
      return;
    }
    if (!detail) return;
    showDepositDetail(detail);
  }

  function showDepositDetail(d) {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[90] flex items-end justify-center bg-black/40 backdrop-blur-sm md:items-center';

    const modal = document.createElement('div');
    modal.className = 'card w-full max-w-md max-h-[85vh] overflow-y-auto p-6 step-enter md:rounded-3xl';

    // Three-stage progress indicator
    const stage1Done = !!d.blockchain_verified_at;
    const stage2Done = !!d.manually_verified_at;
    // Credit readiness: manual verification + an established verified amount
    // (blockchain-derived OR admin manual override). Server re-enforces all rules.
    const stage3Ready = stage2Done && d.status === 'PENDING_VERIFICATION' && d.verified_amount;
    const stageHtml = `
      <div class="mb-5 space-y-2">
        <p class="text-[11px] font-semibold uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">Verification Progress</p>
        <div class="flex items-center gap-2 text-[12px]">
          <span class="${stage1Done ? 'text-green-600 dark:text-green-400' : 'text-text-secondary dark:text-text-secondary-dark'}">${stage1Done ? '✓' : '①'}</span>
          <span class="${stage1Done ? 'text-text-primary dark:text-text-primary-dark font-medium' : 'text-text-secondary dark:text-text-secondary-dark'}">Blockchain Verification</span>
        </div>
        <div class="flex items-center gap-2 text-[12px]">
          <span class="${stage2Done ? 'text-green-600 dark:text-green-400' : (stage1Done ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark')}">${stage2Done ? '✓' : '②'}</span>
          <span class="${stage2Done ? 'text-text-primary dark:text-text-primary-dark font-medium' : (stage1Done ? 'text-text-primary dark:text-text-primary-dark' : 'text-text-secondary dark:text-text-secondary-dark')}">Manual Admin Verification</span>
        </div>
        <div class="flex items-center gap-2 text-[12px]">
          <span class="${stage3Ready ? 'text-action dark:text-action-dark' : 'text-text-secondary dark:text-text-secondary-dark'}">${stage3Ready ? '③' : '③'}</span>
          <span class="${stage3Ready ? 'text-text-primary dark:text-text-primary-dark font-medium' : 'text-text-secondary dark:text-text-secondary-dark'}">Financial Authorization (2FA)</span>
        </div>
      </div>
    `;

    // Build the verification section
    let verificationHtml = '';
    if (d.status === 'PENDING_VERIFICATION') {
      if (d.blockchain_verified_at) {
        const bvData = d.blockchain_verification_data || {};
        const explorerUrl = d.tx_hash ? `https://tronscan.org/#/transaction/${encodeURIComponent(d.tx_hash)}` : null;
        verificationHtml = `
          <div class="card p-4 mb-4 bg-green-500/5 border border-green-500/20">
            <p class="text-[12px] font-semibold text-green-700 dark:text-green-400 mb-2">STAGE 1 — Blockchain Verification</p>
            <div class="space-y-1.5 text-[12px]">
              ${detailRow('From', escapeHtml(shortAddr(bvData.from_address)))}
              ${detailRow('Block', bvData.block_number ? '#' + bvData.block_number : '—')}
              ${detailRow('Confirmations', bvData.confirmations || '—')}
              ${detailRow('Verified At', new Date(d.blockchain_verified_at).toLocaleString())}
              ${explorerUrl ? `<a href="${escapeHtml(explorerUrl)}" target="_blank" rel="noopener noreferrer" class="mt-2 inline-block text-[12px] text-action dark:text-action-dark underline">View on Tronscan →</a>` : ''}
            </div>
          </div>
        `;
        // Amount difference
        if (d.declared_amount != null && d.verified_amount != null) {
          const diff = Number(d.verified_amount) - Number(d.declared_amount);
          if (Math.abs(diff) > 0.000001) {
            const diffClass = diff < 0 ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400';
            const diffSign = diff > 0 ? '+' : '';
            verificationHtml += `
              <div class="card p-4 mb-4 bg-amber-500/5 border border-amber-500/20">
                <p class="text-[12px] font-semibold text-amber-700 dark:text-amber-400 mb-2">⚠ Amount Difference</p>
                <div class="space-y-1.5 text-[12px]">
                  ${detailRow('Declared', formatAmount(d.declared_amount) + ' USDT')}
                  ${detailRow('Verified', formatAmount(d.verified_amount) + ' USDT')}
                  ${detailRow('Difference', `<span class="${diffClass} font-semibold">${diffSign}${formatAmount(diff)} USDT</span>`)}
                </div>
              </div>
            `;
          }
        }
      } else if (d.blockchain_verification_error) {
        verificationHtml = `
          <div class="card p-4 mb-4 bg-red-500/5 border border-red-500/20">
            <p class="text-[12px] font-semibold text-red-700 dark:text-red-400 mb-1">⚠ Verification Error</p>
            <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">${escapeHtml(d.blockchain_verification_error)}</p>
            <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark mt-1">Attempts: ${d.blockchain_verification_attempts || 0}</p>
          </div>
        `;
      } else {
        verificationHtml = `
          <div class="card p-4 mb-4 bg-amber-500/5 border border-amber-500/20">
            <p class="text-[12px] font-medium text-amber-700 dark:text-amber-400">⏳ Awaiting blockchain verification (${d.blockchain_verification_attempts || 0} attempts)</p>
          </div>
        `;
      }

      // STAGE 2 — Manual admin verification is an INDEPENDENT path:
      // available regardless of blockchain verification state/attempts.
      if (d.manually_verified_at) {
        verificationHtml += `
          <div class="card p-4 mb-4 bg-green-500/5 border border-green-500/20">
            <p class="text-[12px] font-semibold text-green-700 dark:text-green-400 mb-1">STAGE 2 — Manual Verification Complete</p>
            <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">By ${escapeHtml(d.manually_verified_by_email || 'admin')} on ${new Date(d.manually_verified_at).toLocaleString()}</p>
            ${d.manual_verification_notes ? `<p class="text-[11px] text-text-secondary dark:text-text-secondary-dark mt-1">Notes: ${escapeHtml(d.manual_verification_notes)}</p>` : ''}
          </div>
        `;
      } else {
        // Checklist for manual verification
        verificationHtml += `
          <div class="card p-4 mb-4">
            <p class="text-[12px] font-semibold text-text-primary dark:text-text-primary-dark mb-2">STAGE 2 — Manual Admin Verification</p>
            <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark mb-3">Independently confirm each of the following before proceeding. The admin who checks these is recorded in the audit log.</p>
            <div class="space-y-2.5" id="manual-checklist">
              ${checklistItem('txid', 'Transaction Hash (TX ID) is correct')}
              ${checklistItem('network', 'TRC20 network confirmed')}
              ${checklistItem('token', 'Token is USDT')}
              ${checklistItem('sender', 'Sender address verified')}
              ${checklistItem('recipient', 'Recipient matches XReserve deposit address')}
              ${checklistItem('amount', 'Deposit amount is correct')}
              ${checklistItem('finality', 'Transaction has sufficient finality (confirmations)' )}
              ${checklistItem('wallet_info', 'Relevant wallet/blockchain information reviewed')}
            </div>
            ${d.verified_amount ? '' : `
            <div class="mt-3">
              <label class="text-[11px] font-medium text-text-primary dark:text-text-primary-dark block mb-1" for="manual-amount">Verified Amount (USDT) <span class="text-red-500">*</span></label>
              <input id="manual-amount" type="number" inputmode="decimal" min="0" step="0.000001" class="input-field w-full text-[12px]" placeholder="e.g. 100.00" />
              <p class="mt-1 text-[11px] text-text-secondary dark:text-text-secondary-dark">Blockchain verification did not establish an amount. Enter the exact USDT amount you verified. It is validated server-side, recorded with the verification, and becomes the creditable amount.</p>
            </div>
            `}
            <div class="mt-3">
              <label class="text-[11px] font-medium text-text-primary dark:text-text-primary-dark block mb-1">Notes (optional)</label>
              <textarea id="manual-notes" class="input-field w-full text-[12px]" rows="2" placeholder="Any additional notes..."></textarea>
            </div>
          </div>
        `;
      }
    }

    modal.innerHTML = `
      <div class="flex items-center justify-between mb-5">
        <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark">Deposit Verification</h2>
        <button class="flex h-8 w-8 items-center justify-center rounded-xl text-text-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.06]" id="close-detail" aria-label="Close">
          <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="mb-4" id="detail-badge"></div>
      ${stageHtml}
      <div class="space-y-0 mb-4">
        ${detailRow('User', escapeHtml(d.user_email))}
        ${detailRow('Network', escapeHtml(d.network))}
        ${detailRow('Token', escapeHtml(d.token))}
        ${detailRow('Declared', formatAmount(d.declared_amount) + ' USDT')}
        ${detailRow('Verified', d.verified_amount ? formatAmount(d.verified_amount) + ' USDT' : '—')}
        ${detailRow('Credited', d.actual_amount ? formatAmount(d.actual_amount) + ' USDT' : '—')}
        ${detailRow('Transaction Hash (TX ID)', escapeHtml(d.tx_hash) || '—')}
        ${d.destination_address ? detailRow('Destination', escapeHtml(d.destination_address)) : ''}
        ${detailRow('Created', new Date(d.created_at).toLocaleString())}
        ${detailRow('Updated', new Date(d.updated_at).toLocaleString())}
      </div>
      ${verificationHtml}
      <div id="detail-actions" class="space-y-2"></div>
      <div id="detail-feedback" class="hidden mt-3"></div>
    `;

    modal.querySelector('#detail-badge').appendChild(StatusBadge({ status: d.status }));
    modal.querySelector('#close-detail').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    // Action buttons based on verification stage
    const actionsEl = modal.querySelector('#detail-actions');

    // Retry blockchain verification (admin JWT hits the EF's admin path).
    // Shown while blockchain verification has not completed.
    if (d.status === 'PENDING_VERIFICATION' && !d.blockchain_verified_at) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn-secondary w-full';
      retryBtn.textContent = 'Retry Blockchain Verification';
      retryBtn.addEventListener('click', async () => {
        retryBtn.disabled = true;
        retryBtn.textContent = 'Verifying on blockchain...';
        try {
          const { data: res, error: invokeErr } = await supabase.functions.invoke('verify-trc20-deposit', {
            body: { deposit_id: d.deposit_id }
          });
          if (invokeErr) throw invokeErr;
          const row = Array.isArray(res?.results) ? res.results[0] : null;
          if (row?.status === 'verified') {
            showFeedback(modal, `Blockchain verification succeeded — verified ${formatAmount(row.verified_amount)} USDT`, 'green');
            setTimeout(() => { overlay.remove(); loadDeposits(); }, 1200);
          } else if (row?.status === 'manual_override') {
            showFeedback(modal, 'Skipped: deposit was manually verified', 'amber');
            retryBtn.disabled = false;
            retryBtn.textContent = 'Retry Blockchain Verification';
          } else {
            showFeedback(modal, `Blockchain verification did not complete: ${row?.error || res?.error || 'transaction not found or not confirmed yet'}`, 'red');
            retryBtn.disabled = false;
            retryBtn.textContent = 'Retry Blockchain Verification';
          }
        } catch (err) {
          showFeedback(modal, err?.message || 'Failed to run blockchain verification', 'red');
          retryBtn.disabled = false;
          retryBtn.textContent = 'Retry Blockchain Verification';
        }
      });
      actionsEl.appendChild(retryBtn);
    }

    // Stage 2: Manual verification button — independent of blockchain
    // verification state; gated server-side by admin_financial 2FA.
    // 2FA is requested ONLY on final submission, never when opening the
    // modal or entering checklist/amount data.
    if (d.status === 'PENDING_VERIFICATION' && !d.manually_verified_at) {
      const needsManualAmount = !d.verified_amount;
      const verifyBtn = document.createElement('button');
      verifyBtn.className = 'btn-primary w-full';
      verifyBtn.textContent = 'Manual Verify Deposit';
      verifyBtn.disabled = true; // Enabled only when checklist (+ amount, when required) is complete
      actionsEl.appendChild(verifyBtn);

      // Wire checklist checkboxes (+ optional amount input) to enable the button
      const checkboxes = modal.querySelectorAll('.checklist-cb');
      const amountEl = modal.querySelector('#manual-amount');
      const updateVerifyBtn = () => {
        const allChecked = Array.from(checkboxes).every((cb) => cb.checked);
        let amountValid = true;
        if (needsManualAmount && amountEl) {
          const parsed = Number.parseFloat(amountEl.value);
          amountValid = Number.isFinite(parsed) && parsed > 0;
        }
        verifyBtn.disabled = !(allChecked && amountValid);
      };
      checkboxes.forEach((cb) => cb.addEventListener('change', updateVerifyBtn));
      if (amountEl) amountEl.addEventListener('input', updateVerifyBtn);

      verifyBtn.addEventListener('click', () => {
        const checklist = {};
        checkboxes.forEach((cb) => { checklist[cb.dataset.key] = cb.checked; });
        const notesEl = modal.querySelector('#manual-notes');
        const notes = notesEl ? notesEl.value.trim() : '';
        let manualAmount = null;
        if (needsManualAmount && amountEl) {
          manualAmount = Number.parseFloat(amountEl.value);
          if (!Number.isFinite(manualAmount) || manualAmount <= 0) {
            showFeedback(modal, 'Enter a valid verified amount greater than 0', 'red');
            return;
          }
        }
        handleManualVerify(d, checklist, notes, manualAmount, modal, overlay, verifyBtn);
      });
    }

    // Stage 3: Credit button (after manual verification, once a verified
    // amount exists — blockchain-derived OR manual override). The server
    // re-validates every precondition; the browser never supplies the
    // credit amount. When a valid continuation from the just-completed
    // manual verification exists, it authorizes this single credit without
    // a second 2FA prompt (server still enforces every check).
    if (d.status === 'PENDING_VERIFICATION' && d.manually_verified_at && d.verified_amount) {
      const cont = creditContinuations.get(d.deposit_id);
      if (cont && cont.expiresAt <= Date.now()) creditContinuations.delete(d.deposit_id);
      const validCont = creditContinuations.get(d.deposit_id) || null;
      const creditBtn = document.createElement('button');
      creditBtn.className = 'btn-primary w-full';
      creditBtn.textContent = `Credit ${formatAmount(d.verified_amount)} USDT`;
      creditBtn.addEventListener('click', () => handleCredit(d.deposit_id, Number(d.verified_amount), modal, overlay, validCont));
      actionsEl.appendChild(creditBtn);
    }

    // Reject button (for any non-credited deposit)
    if (d.status !== 'CREDITED' && d.status !== 'REJECTED') {
      const rejectBtn = document.createElement('button');
      rejectBtn.className = 'btn-secondary w-full text-red-600 dark:text-red-400';
      rejectBtn.textContent = 'Reject Deposit';
      rejectBtn.addEventListener('click', () => showConfirm(modal, 'Reject Deposit', 'Reject this deposit? The user will not be credited.', 'Reject', true, () => handleAction(d.deposit_id, 'REJECTED', 'Reject', modal)));
      actionsEl.appendChild(rejectBtn);
    }

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  function showConfirm(parentModal, title, message, confirmLabel, destructive, onConfirm) {
    const dialog = ConfirmDialog({ title, message, confirmLabel, destructive, onConfirm });
    document.body.appendChild(dialog);
  }

  async function handleAction(depositId, newStatus, label, modal) {
    showConfirm(modal, label, `${label} this deposit?`, label, false, async () => {
      showFeedback(modal, 'Verifying identity...', 'amber');
      try {
        const verificationId = await requireVerification(label, 'admin_financial');
        showFeedback(modal, 'Processing...', 'amber');
        const { error } = await supabase.rpc('admin_update_deposit_status', { p_deposit_id: depositId, p_new_status: newStatus, p_verification_id: verificationId });
        if (error) {
          showFeedback(modal, error.message, 'red');
          return;
        }
        showFeedback(modal, 'Updated successfully', 'green');
        refreshWalletBalance();
        setTimeout(() => loadDeposits(), 800);
      } catch {
        showFeedback(modal, 'Verification cancelled', 'amber');
      }
    });
  }

  async function handleManualVerify(deposit, checklist, notes, manualAmount, modal, overlay, verifyBtn) {
    // Manual verification is an independent override path. It requires the
    // existing admin_financial 2FA challenge (consumed server-side) plus the
    // mandatory 8-item checklist. When blockchain verification has not
    // established an amount, the admin-entered manualAmount is validated and
    // stored server-side as verified_amount (source: manual_override).
    // On success the server issues a short-lived single-use credit
    // continuation so the immediate Credit action does not need a second
    // 2FA prompt; the credit RPC still re-validates everything server-side.
    verifyBtn.disabled = true;
    showFeedback(modal, 'Verifying identity...', 'amber');
    try {
      const verificationId = await requireVerification('Manual Verify Deposit', 'admin_financial');
      verifyBtn.textContent = 'Recording verification...';
      showFeedback(modal, 'Recording verification...', 'amber');
      const { data: continuationId, error } = await supabase.rpc('admin_manually_verify_deposit', {
        p_deposit_id: deposit.deposit_id,
        p_notes: notes || null,
        p_checklist: checklist,
        p_verification_id: verificationId,
        p_manual_verified_amount: manualAmount
      });
      if (error) {
        showFeedback(modal, error.message, 'red');
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Manual Verify Deposit';
        return;
      }
      // Store continuation (if issued — only after migration 019 is applied)
      if (continuationId) {
        creditContinuations.set(deposit.deposit_id, {
          id: continuationId,
          expiresAt: Date.now() + 5 * 60 * 1000
        });
      }
      showFeedback(modal, 'Manual verification recorded', 'green');
      // Re-open the refreshed detail so the admin can credit immediately
      setTimeout(async () => {
        overlay.remove();
        await loadDeposits();
        openDepositDetail(deposit.deposit_id);
      }, 600);
    } catch {
      showFeedback(modal, 'Verification cancelled', 'amber');
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Manual Verify Deposit';
    }
  }

  async function handleCredit(depositId, amount, modal, overlay, continuation) {
    showFeedback(modal, 'Processing...', 'amber');
    try {
      if (continuation) {
        // Continuation path: no second 2FA prompt. The server atomically
        // validates + consumes the continuation (admin-bound, deposit-bound,
        // single-use, short-lived) and still enforces every credit check.
        const { error } = await supabase.rpc('admin_credit_verified_deposit', {
          p_deposit_id: depositId,
          p_continuation_id: continuation.id
        });
        if (error) {
          // Continuation rejected/expired — fall back to standard 2FA.
          creditContinuations.delete(depositId);
          showFeedback(modal, 'Session authorization expired — verify again to credit', 'amber');
          const verificationId = await requireVerification('Credit Deposit', 'admin_financial');
          showFeedback(modal, 'Processing...', 'amber');
          const retry = await supabase.rpc('admin_credit_verified_deposit', { p_deposit_id: depositId, p_verification_id: verificationId });
          if (retry.error) {
            showFeedback(modal, retry.error.message, 'red');
            return;
          }
        } else {
          creditContinuations.delete(depositId);
        }
      } else {
        const verificationId = await requireVerification('Credit Deposit', 'admin_financial');
        showFeedback(modal, 'Processing...', 'amber');
        const { error } = await supabase.rpc('admin_credit_verified_deposit', { p_deposit_id: depositId, p_verification_id: verificationId });
        if (error) {
          showFeedback(modal, error.message, 'red');
          return;
        }
      }
      showFeedback(modal, `Successfully credited ${formatAmount(amount)} USDT`, 'green');
      refreshWalletBalance();
      setTimeout(() => { overlay.remove(); loadDeposits(); }, 800);
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

  function checklistItem(key, label) {
    return `<label class="flex items-start gap-2.5 cursor-pointer"><input type="checkbox" class="checklist-cb mt-0.5 h-4 w-4 rounded border-border-light dark:border-border-dark accent-action dark:accent-action-dark" data-key="${escapeHtml(key)}" /><span class="text-[12px] text-text-primary dark:text-text-primary-dark">${escapeHtml(label)}</span></label>`;
  }

  loadDeposits();
  return page;
}
