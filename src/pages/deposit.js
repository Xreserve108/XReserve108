import { supabase } from '@/lib/supabase';
import { get2FAStatus } from '@/core/totp';
import { navigate } from '@/core/router';
import { requireVerification } from '@/components/TotpDialog';
import { TetherIcon } from '@/components/icons/TetherIcon';
import QRCode from 'qrcode';

const copyIcon = `<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const checkIcon = `<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`;
const checkCircleIcon = `<svg class="h-12 w-12" fill="none" stroke="currentColor" stroke-width="1" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`;
const warningIcon = `<svg class="h-5 w-5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>`;

export function renderDeposit() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';
  page.id = 'deposit-page';

  let screen = 'loading'; // loading, no-method, networks, submit, confirming, success, pending
  let activeMethod = null;
  let twoFAEnabled = null;

  // Form state
  let declaredAmount = '';
  let txid = '';
  let blockchainUrl = '';
  let confirmFunds = false;
  let confirmNetwork = false;
  let confirmTxid = false;
  let confirmAmount = false;

  // Success state
  let lastDeposit = null;

  // Pending deposits
  let pendingDeposits = [];

  // Check 2FA and load active methods
  (async () => {
    try {
      const status = await get2FAStatus();
      twoFAEnabled = status.enabled;
      if (twoFAEnabled) {
        await loadActiveMethods();
        await loadPendingDeposits();
        // If user has pending deposits and hasn't seen success screen, show pending
        if (pendingDeposits.length > 0 && screen === 'loading') {
          screen = 'pending';
        } else if (screen === 'loading') {
          screen = activeMethod ? 'networks' : 'no-method';
        }
      } else {
        screen = 'no-2fa';
      }
    } catch {
      twoFAEnabled = false;
      screen = 'no-2fa';
    }
    render();
  })();

  async function loadActiveMethods() {
    try {
      const { data, error } = await supabase.rpc('get_active_deposit_methods');
      if (error) throw error;
      // For now, only TRC20 is expected to be active
      activeMethod = (data || []).find(m => m.network === 'TRC20') || null;
    } catch (err) {
      console.error('Failed to load active deposit methods:', err);
      activeMethod = null;
    }
  }

  async function loadPendingDeposits() {
    try {
      const { data, error } = await supabase.rpc('get_user_pending_deposits');
      if (error) throw error;
      pendingDeposits = data || [];
    } catch (err) {
      console.error('Failed to load pending deposits:', err);
      pendingDeposits = [];
    }
  }

  function render() {
    page.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'step-enter mb-6';

    if (screen === 'success') {
      header.innerHTML = `
        <div class="flex items-center gap-3 mb-2">
          <h1 class="page-title">Deposit Submitted</h1>
        </div>
      `;
    } else if (screen === 'pending') {
      header.innerHTML = `
        <div class="flex items-center gap-3 mb-2">
          <h1 class="page-title">Deposit USDT</h1>
        </div>
        <p class="text-muted mt-1">Your pending deposit transactions</p>
      `;
    } else {
      header.innerHTML = `
        <div class="flex items-center gap-3 mb-2">
          ${screen !== 'loading' && screen !== 'no-2fa' && screen !== 'no-method' ? `<button id="step-back" class="flex h-8 w-8 items-center justify-center rounded-xl text-text-secondary transition-colors duration-150 hover:bg-black/[0.04] dark:hover:bg-white/[0.06]" aria-label="Go back"><svg class="h-[18px] w-[18px]" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg></button>` : ''}
          <h1 class="page-title">Deposit USDT</h1>
        </div>
        <p class="text-muted mt-1">Add USDT to your XReserve wallet</p>
      `;
    }
    page.appendChild(header);

    // Wire back button
    const backBtn = page.querySelector('#step-back');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        if (screen === 'submit') { screen = 'networks'; resetForm(); render(); }
        else if (screen === 'confirming') { screen = 'submit'; render(); }
      });
    }

    // Loading
    if (screen === 'loading' || twoFAEnabled === null) {
      const loading = document.createElement('div');
      loading.className = 'flex items-center justify-center py-12';
      loading.innerHTML = '<div class="auth-spinner"></div>';
      page.appendChild(loading);
      return;
    }

    // No 2FA gate
    if (screen === 'no-2fa' || !twoFAEnabled) {
      const gate = document.createElement('div');
      gate.className = 'step-enter card p-6 text-center';
      gate.innerHTML = `
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10 mx-auto mb-4">
          <svg class="h-6 w-6 text-amber-600 dark:text-amber-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>
        </div>
        <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-2">2FA Required</h2>
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark mb-4">You must enable two-factor authentication before making deposits.</p>
        <button class="btn-primary" id="setup-2fa-btn">Set Up 2FA</button>
      `;
      page.appendChild(gate);
      gate.querySelector('#setup-2fa-btn').addEventListener('click', () => navigate('security'));
      return;
    }

    // No active method
    if (screen === 'no-method') {
      const empty = document.createElement('div');
      empty.className = 'step-enter card p-6 text-center';
      empty.innerHTML = `
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-black/[0.04] dark:bg-white/[0.06] mx-auto mb-4">
          <svg class="h-6 w-6 text-text-secondary dark:text-text-secondary-dark" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>
        </div>
        <h2 class="text-[17px] font-semibold text-text-primary dark:text-text-primary-dark mb-2">No Deposit Methods Available</h2>
        <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Deposit methods are not currently configured. Please check back later.</p>
      `;
      page.appendChild(empty);
      return;
    }

    if (screen === 'networks') renderNetworksScreen(page);
    else if (screen === 'submit') renderSubmitScreen(page);
    else if (screen === 'confirming') renderConfirmScreen(page);
    else if (screen === 'success') renderSuccessScreen(page);
    else if (screen === 'pending') renderPendingScreen(page);
  }

  function resetForm() {
    declaredAmount = '';
    txid = '';
    blockchainUrl = '';
    confirmFunds = false;
    confirmNetwork = false;
    confirmTxid = false;
    confirmAmount = false;
  }

  // ===========================================================================
  // SCREEN: Networks (Screen 1)
  // ===========================================================================
  function renderNetworksScreen(container) {
    const content = document.createElement('div');
    content.className = 'step-enter space-y-5';

    // Network badge
    const netBadge = document.createElement('div');
    netBadge.className = 'flex items-center gap-3 card p-4';
    netBadge.innerHTML = `
      <div class="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/10 dark:bg-green-500/20">
        ${TetherIcon({ className: 'h-5 w-5' })}
      </div>
      <div class="flex-1">
        <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">${activeMethod.network}</p>
        <p class="text-[11px] text-text-secondary dark:text-text-secondary-dark">${activeMethod.asset} • Active</p>
      </div>
    `;
    content.appendChild(netBadge);

    // QR + Address card
    const addrCard = document.createElement('div');
    addrCard.className = 'card p-5';
    addrCard.innerHTML = `
      <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark mb-3">TRC20 Address</p>
      <div class="dm-qr-gen flex items-center justify-center rounded-xl bg-black/[0.03] dark:bg-white/[0.04] p-4 mb-4 min-h-[160px]">
        <div class="auth-spinner"></div>
      </div>
      <div class="rounded-2xl bg-black/[0.03] dark:bg-white/[0.04] px-4 py-3.5">
        <p class="break-all font-mono text-[14px] leading-relaxed text-text-primary dark:text-text-primary-dark select-all">${escapeHtml(activeMethod.deposit_address)}</p>
        <div class="mt-3 flex justify-center">
          <button id="copy-address" class="inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-[13px] font-medium text-text-secondary transition-colors duration-150 hover:bg-black/[0.06] hover:text-text-primary dark:text-text-secondary-dark dark:hover:bg-white/[0.08] dark:hover:text-text-primary-dark" aria-label="Copy TRC20 deposit address">${copyIcon}<span>Copy</span></button>
        </div>
      </div>
    `;
    content.appendChild(addrCard);

    // Generate QR
    generateQR(addrCard, activeMethod.deposit_address);

    // Wire copy
    addrCard.querySelector('#copy-address').addEventListener('click', () => {
      const btn = addrCard.querySelector('#copy-address');
      navigator.clipboard?.writeText(activeMethod.deposit_address);
      btn.innerHTML = checkIcon + '<span>Copied</span>';
      btn.classList.add('text-green-600', 'dark:text-green-400');
      setTimeout(() => {
        btn.innerHTML = copyIcon + '<span>Copy</span>';
        btn.classList.remove('text-green-600', 'dark:text-green-400');
      }, 2000);
    });

    // Warning card
    const warn = document.createElement('div');
    warn.className = 'card p-4';
    warn.innerHTML = `
      <div class="flex gap-3">
        <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
          ${warningIcon}
        </div>
        <div>
          <p class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">Important</p>
          <p class="mt-0.5 text-[12px] text-text-secondary dark:text-text-secondary-dark">Send only <strong>USDT</strong> using the <strong>${activeMethod.network}</strong> network to this address. Sending another asset or using another network may result in permanent loss of funds.</p>
        </div>
      </div>
    `;
    content.appendChild(warn);

    // Continue button
    const btn = document.createElement('button');
    btn.className = 'btn-primary w-full';
    btn.textContent = 'Continue';
    btn.addEventListener('click', () => { screen = 'submit'; render(); });
    content.appendChild(btn);

    // How-to instructions
    const howTo = document.createElement('div');
    howTo.className = 'card p-5';
    howTo.innerHTML = `
      <h2 class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">How Deposits Work</h2>
      <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark mb-4">Follow these three steps to complete your deposit.</p>
      <ol class="space-y-5">
        <li class="flex gap-3.5">
          <span class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-black/[0.05] dark:bg-white/[0.08] text-[12px] font-bold text-text-primary dark:text-text-primary-dark">1</span>
          <div class="min-w-0">
            <p class="text-[13px] font-semibold text-text-primary dark:text-text-primary-dark">Send USDT</p>
            <p class="mt-1 text-[12px] leading-relaxed text-text-secondary dark:text-text-secondary-dark">Scan the QR code or copy the <strong>${escapeHtml(activeMethod.network)}</strong> wallet address shown above, then send your desired USDT amount to <strong>that address only</strong>. Do not send funds to any other address.</p>
          </div>
        </li>
        <li class="flex gap-3.5">
          <span class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-black/[0.05] dark:bg-white/[0.08] text-[12px] font-bold text-text-primary dark:text-text-primary-dark">2</span>
          <div class="min-w-0">
            <p class="text-[13px] font-semibold text-text-primary dark:text-text-primary-dark">Continue</p>
            <p class="mt-1 text-[12px] leading-relaxed text-text-secondary dark:text-text-secondary-dark">Once your blockchain transaction has been submitted, tap <strong>Continue</strong> above to proceed.</p>
          </div>
        </li>
        <li class="flex gap-3.5">
          <span class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-black/[0.05] dark:bg-white/[0.08] text-[12px] font-bold text-text-primary dark:text-text-primary-dark">3</span>
          <div class="min-w-0">
            <p class="text-[13px] font-semibold text-text-primary dark:text-text-primary-dark">Submit Transaction Details</p>
            <p class="mt-1 text-[12px] leading-relaxed text-text-secondary dark:text-text-secondary-dark">On the next page, enter the details of your transaction:</p>
            <ul class="mt-2 space-y-1.5 text-[12px] leading-relaxed text-text-secondary dark:text-text-secondary-dark">
              <li class="flex gap-2"><span class="text-text-primary dark:text-text-primary-dark">•</span><span><strong>Exact USDT amount</strong> you deposited — required</span></li>
              <li class="flex gap-2"><span class="text-text-primary dark:text-text-primary-dark">•</span><span><strong>Transaction Hash (TX ID)</strong> — required</span></li>
              <li class="flex gap-2"><span class="text-text-primary dark:text-text-primary-dark">•</span><span>Blockchain URL — <strong class="font-bold text-green-600 dark:text-green-400">OPTIONAL</strong></span></li>
            </ul>
            <p class="mt-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] px-3 py-2.5 text-[12px] leading-relaxed text-text-secondary dark:text-text-secondary-dark">You can find the Transaction Hash (TX ID) in the transaction details of your crypto wallet app, or by searching for your transaction on a blockchain explorer such as Tronscan.</p>
          </div>
        </li>
      </ol>
    `;
    content.appendChild(howTo);

    // Pending deposits link
    if (pendingDeposits.length > 0) {
      const pendingLink = document.createElement('button');
      pendingLink.className = 'w-full text-center text-[13px] text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark transition-colors mt-2';
      pendingLink.textContent = `View Pending Transactions (${pendingDeposits.length})`;
      pendingLink.addEventListener('click', () => { screen = 'pending'; render(); });
      content.appendChild(pendingLink);
    }

    container.appendChild(content);
  }

  // ===========================================================================
  // SCREEN: Submit Deposit (Screen 2)
  // ===========================================================================
  function renderSubmitScreen(container) {
    const content = document.createElement('div');
    content.className = 'step-enter space-y-5';

    // Intro text
    const intro = document.createElement('p');
    intro.className = 'text-[13px] text-text-secondary dark:text-text-secondary-dark';
    intro.textContent = 'Enter the details of the USDT transaction you sent to the XReserve deposit address.';
    content.appendChild(intro);

    // Amount field
    const amountGroup = document.createElement('div');
    amountGroup.innerHTML = `
      <label class="label" for="dep-amount">Amount Deposited <span class="text-red-500">*</span></label>
      <div class="relative">
        <input type="text" inputmode="decimal" class="input-field pr-16" placeholder="0.00" id="dep-amount" autocomplete="off" value="${escapeHtml(declaredAmount)}" />
        <span class="absolute right-4 top-1/2 -translate-y-1/2 text-[13px] font-medium text-text-secondary dark:text-text-secondary-dark">USDT</span>
      </div>
      <p class="mt-1.5 text-[11px] text-text-secondary dark:text-text-secondary-dark">Enter the exact amount of USDT sent to the deposit address. Network or wallet transaction fees are not included in the deposit amount.</p>
      <div class="dep-amount-error hidden mt-1 text-[12px] text-red-600 dark:text-red-400"></div>
    `;
    content.appendChild(amountGroup);

    // TXID field
    const txidGroup = document.createElement('div');
    txidGroup.innerHTML = `
      <label class="label" for="dep-txid">Transaction Hash (TX ID) <span class="text-red-500">*</span></label>
      <input type="text" class="input-field font-mono text-[13px]" placeholder="Enter transaction hash" id="dep-txid" autocomplete="off" spellcheck="false" value="${escapeHtml(txid)}" />
      <p class="mt-1.5 text-[11px] text-text-secondary dark:text-text-secondary-dark">Enter the transaction hash of your USDT transfer.</p>
      <div class="dep-txid-error hidden mt-1 text-[12px] text-red-600 dark:text-red-400"></div>
    `;
    content.appendChild(txidGroup);

    // Blockchain URL field (optional)
    const urlGroup = document.createElement('div');
    urlGroup.innerHTML = `
      <label class="label" for="dep-url">Blockchain Transaction Link <span class="text-[11px] font-bold text-green-600 dark:text-green-400">— OPTIONAL</span></label>
      <input type="url" class="input-field text-[13px]" placeholder="https://tronscan.org/#/transaction/..." id="dep-url" autocomplete="off" value="${escapeHtml(blockchainUrl)}" />
      <p class="mt-1.5 text-[11px] text-text-secondary dark:text-text-secondary-dark">If available, provide a link to the transaction on the blockchain explorer.</p>
      <div class="dep-url-error hidden mt-1 text-[12px] text-red-600 dark:text-red-400"></div>
    `;
    content.appendChild(urlGroup);

    // Confirmation checkboxes
    const checks = document.createElement('div');
    checks.className = 'space-y-3 pt-2';
    checks.innerHTML = `
      <label class="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" id="chk-funds" class="mt-0.5 h-4 w-4 rounded border-border-light dark:border-border-dark accent-action dark:accent-action-dark" ${confirmFunds ? 'checked' : ''} />
        <span class="text-[13px] text-text-primary dark:text-text-primary-dark">I sent the funds to the XReserve deposit address shown above.</span>
      </label>
      <label class="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" id="chk-network" class="mt-0.5 h-4 w-4 rounded border-border-light dark:border-border-dark accent-action dark:accent-action-dark" ${confirmNetwork ? 'checked' : ''} />
        <span class="text-[13px] text-text-primary dark:text-text-primary-dark">I used the <strong>${activeMethod.network}</strong> network.</span>
      </label>
      <label class="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" id="chk-txid" class="mt-0.5 h-4 w-4 rounded border-border-light dark:border-border-dark accent-action dark:accent-action-dark" ${confirmTxid ? 'checked' : ''} />
        <span class="text-[13px] text-text-primary dark:text-text-primary-dark">The transaction hash is correct.</span>
      </label>
      <label class="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" id="chk-amount" class="mt-0.5 h-4 w-4 rounded border-border-light dark:border-border-dark accent-action dark:accent-action-dark" ${confirmAmount ? 'checked' : ''} />
        <span class="text-[13px] text-text-primary dark:text-text-primary-dark">The amount entered matches the amount sent.</span>
      </label>
    `;
    content.appendChild(checks);

    // Submit button
    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn-primary w-full';
    submitBtn.id = 'submit-deposit-btn';
    submitBtn.textContent = 'Submit Deposit';
    submitBtn.disabled = true;
    content.appendChild(submitBtn);

    // Feedback area
    const feedback = document.createElement('div');
    feedback.className = 'dep-feedback hidden';
    feedback.id = 'dep-feedback';
    content.appendChild(feedback);

    container.appendChild(content);

    // Wire up events
    const amountInput = content.querySelector('#dep-amount');
    const txidInput = content.querySelector('#dep-txid');
    const urlInput = content.querySelector('#dep-url');

    function updateSubmitState() {
      // Validate amount
      const amtErr = content.querySelector('.dep-amount-error');
      const amt = parseAmount(amountInput.value);
      if (amountInput.value.trim() && (amt === null || amt <= 0)) {
        amtErr.textContent = 'Please enter a valid USDT amount greater than zero.';
        amtErr.classList.remove('hidden');
      } else {
        amtErr.classList.add('hidden');
      }

      // Validate URL if provided
      const urlErr = content.querySelector('.dep-url-error');
      const urlVal = urlInput.value.trim();
      if (urlVal && !urlVal.toLowerCase().startsWith('https://')) {
        urlErr.textContent = 'URL must use HTTPS protocol.';
        urlErr.classList.remove('hidden');
      } else {
        urlErr.classList.add('hidden');
      }

      // Read state
      declaredAmount = amountInput.value;
      txid = txidInput.value;
      blockchainUrl = urlInput.value;
      confirmFunds = content.querySelector('#chk-funds').checked;
      confirmNetwork = content.querySelector('#chk-network').checked;
      confirmTxid = content.querySelector('#chk-txid').checked;
      confirmAmount = content.querySelector('#chk-amount').checked;

      // Enable submit if all valid
      const valid = amt !== null && amt > 0
        && txid.trim().length > 0
        && (!urlVal || urlVal.toLowerCase().startsWith('https://'))
        && confirmFunds && confirmNetwork && confirmTxid && confirmAmount;
      submitBtn.disabled = !valid;
    }

    amountInput.addEventListener('input', updateSubmitState);
    txidInput.addEventListener('input', updateSubmitState);
    urlInput.addEventListener('input', updateSubmitState);
    content.querySelector('#chk-funds').addEventListener('change', updateSubmitState);
    content.querySelector('#chk-network').addEventListener('change', updateSubmitState);
    content.querySelector('#chk-txid').addEventListener('change', updateSubmitState);
    content.querySelector('#chk-amount').addEventListener('change', updateSubmitState);

    // Submit handler
    submitBtn.addEventListener('click', async () => {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<div class="auth-spinner"></div><span>Submitting...</span>';
      const fb = content.querySelector('#dep-feedback');

      try {
        // Require 2FA verification
        submitBtn.innerHTML = '<div class="auth-spinner"></div><span>Verifying...</span>';
        const verificationId = await requireVerification('Confirm Deposit Submission', 'user_transaction');

        submitBtn.innerHTML = '<div class="auth-spinner"></div><span>Submitting Deposit...</span>';

        // Call submit_deposit RPC
        const { data, error } = await supabase.rpc('submit_deposit', {
          p_network: activeMethod.network,
          p_declared_amount: parseAmount(declaredAmount),
          p_tx_hash: txid.trim(),
          p_blockchain_url: blockchainUrl.trim() || null,
          p_verification_id: verificationId,
        });

        if (error) throw error;

        // Trigger blockchain verification queue (idempotent, non-blocking on failure)
        try {
          await supabase.rpc('request_blockchain_verification', { p_deposit_id: data.deposit_id });
        } catch (queueErr) {
          // Non-fatal — audit record may still be written
          console.warn('Failed to enqueue blockchain verification:', queueErr);
        }

        // Invoke the verification Edge Function directly as the deposit
        // owner (server enforces ownership). Non-fatal: manual admin
        // verification remains the fallback path.
        try {
          await supabase.functions.invoke('verify-trc20-deposit', {
            body: { deposit_id: data.deposit_id }
          });
        } catch (invokeErr) {
          console.warn('Blockchain verification invoke failed:', invokeErr);
        }

        // Success
        lastDeposit = data;
        screen = 'success';
        render();
      } catch (err) {
        if (err.message === 'cancelled') {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit Deposit';
          updateSubmitState();
          return;
        }
        const msg = err.message || 'We couldn\'t submit your deposit at this time. Please try again.';
        fb.className = 'dep-feedback mt-3 rounded-xl bg-red-500/10 px-4 py-2.5 text-[13px] font-medium text-red-600 dark:text-red-400';
        fb.textContent = msg;
        fb.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Deposit';
        updateSubmitState();
      }
    });

    // Initial state
    updateSubmitState();
  }

  // ===========================================================================
  // SCREEN: Confirming (brief transition state)
  // ===========================================================================
  function renderConfirmScreen(container) {
    const content = document.createElement('div');
    content.className = 'step-enter flex flex-col items-center py-12 text-center';
    content.innerHTML = `
      <div class="auth-spinner mb-4"></div>
      <p class="text-[14px] text-text-secondary dark:text-text-secondary-dark">Processing your deposit...</p>
    `;
    container.appendChild(content);
  }

  // ===========================================================================
  // SCREEN: Success
  // ===========================================================================
  function renderSuccessScreen(container) {
    const content = document.createElement('div');
    content.className = 'step-enter flex flex-col items-center py-8 text-center';

    content.innerHTML = `
      <div class="mb-6 text-green-500 dark:text-green-400">${checkCircleIcon}</div>
      <h2 class="text-[20px] font-bold text-text-primary dark:text-text-primary-dark mb-2">Deposit Transaction Under Verification</h2>
      <p class="text-[14px] text-text-secondary dark:text-text-secondary-dark max-w-[320px] mb-6">
        Your deposit has been submitted successfully.
      </p>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark max-w-[320px] mb-6">
        We are currently verifying the transaction on the blockchain. Please allow approximately <strong>5 minutes</strong> for the verification process to complete.
      </p>
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark max-w-[320px] mb-8">
        Once the transaction has been successfully verified and the received amount has been confirmed on the blockchain, the verified USDT amount will be credited to your XReserve wallet.
      </p>
    `;

    // Deposit summary card
    if (lastDeposit) {
      const summary = document.createElement('div');
      summary.className = 'card w-full p-4 mb-6 text-left';
      summary.innerHTML = `
        <div class="flex items-center justify-between py-1.5">
          <span class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Amount</span>
          <span class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">${formatAmount(lastDeposit.declared_amount)} ${lastDeposit.asset}</span>
        </div>
        <div class="divider my-2"></div>
        <div class="flex items-center justify-between py-1.5">
          <span class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Network</span>
          <span class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">${lastDeposit.network}</span>
        </div>
        <div class="divider my-2"></div>
        <div class="flex items-center justify-between py-1.5">
          <span class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Status</span>
          <span class="text-[13px] font-medium text-amber-600 dark:text-amber-400">Under Verification</span>
        </div>
      `;
      content.appendChild(summary);
    }

    // Duplicate warning
    const dupWarn = document.createElement('div');
    dupWarn.className = 'card w-full p-4 mb-6';
    dupWarn.innerHTML = `
      <div class="flex gap-3">
        <div class="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
          ${warningIcon}
        </div>
        <div>
          <p class="text-[13px] font-semibold text-text-primary dark:text-text-primary-dark mb-1">Please do not submit this transaction again.</p>
          <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark">If your deposit does not appear under <strong>Pending Transactions</strong> immediately, please wait a few minutes and refresh the page. The pending transaction list may take some time to update.</p>
          <p class="text-[12px] text-text-secondary dark:text-text-secondary-dark mt-2">Submitting the same transaction multiple times is unnecessary and may delay processing.</p>
        </div>
      </div>
    `;
    content.appendChild(dupWarn);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'flex flex-col gap-3 w-full max-w-[320px]';
    actions.innerHTML = `
      <button class="btn-primary w-full" id="view-pending-btn">View Pending Transactions</button>
      <button class="btn-secondary w-full" id="back-to-wallet-btn">Back to Wallet</button>
      <button class="w-full text-center text-[13px] text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark transition-colors mt-1" id="success-support-link">Need help? Create a support ticket</button>
    `;
    content.appendChild(actions);

    container.appendChild(content);

    // Wire up
    content.querySelector('#view-pending-btn').addEventListener('click', async () => {
      await loadPendingDeposits();
      screen = 'pending';
      render();
    });
    content.querySelector('#back-to-wallet-btn').addEventListener('click', () => {
      navigate('wallet');
    });
    content.querySelector('#success-support-link').addEventListener('click', () => {
      navigate('create-ticket?ctx=deposit');
    });
  }

  // ===========================================================================
  // SCREEN: Pending Transactions
  // ===========================================================================
  function renderPendingScreen(container) {
    const content = document.createElement('div');
    content.className = 'step-enter space-y-4';

    if (pendingDeposits.length === 0) {
      content.innerHTML = `
        <div class="card p-8 text-center">
          <p class="text-[14px] text-text-secondary dark:text-text-secondary-dark mb-4">No pending transactions</p>
          <button class="btn-secondary" id="back-to-deposit">Back to Deposit</button>
        </div>
      `;
      container.appendChild(content);
      content.querySelector('#back-to-deposit').addEventListener('click', () => {
        screen = 'networks';
        render();
      });
      return;
    }

    pendingDeposits.forEach(dep => {
      const card = document.createElement('div');
      card.className = 'card p-4';
      const shortTxid = dep.tx_hash && dep.tx_hash.length > 16
        ? dep.tx_hash.slice(0, 10) + '...' + dep.tx_hash.slice(-6)
        : (dep.tx_hash || '—');
      const statusLabel = dep.status === 'PENDING_VERIFICATION' ? 'Under Verification' : 'Pending';
      const statusClass = 'bg-amber-500/10 text-amber-600 dark:text-amber-400';

      card.innerHTML = `
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span class="text-[13px] font-semibold text-text-primary dark:text-text-primary-dark">${dep.network}</span>
            <span class="text-[11px] text-text-secondary dark:text-text-secondary-dark">${dep.asset || 'USDT'}</span>
          </div>
          <span class="badge ${statusClass}">${statusLabel}</span>
        </div>
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Amount</span>
            <span class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">${dep.declared_amount ? formatAmount(dep.declared_amount) : '—'} USDT</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Transaction Hash (TX ID)</span>
            <div class="flex items-center gap-1.5">
              <span class="font-mono text-[12px] text-text-primary dark:text-text-primary-dark">${escapeHtml(shortTxid)}</span>
              ${dep.tx_hash ? `<button class="pending-copy-txid flex h-6 w-6 items-center justify-center rounded-md text-text-secondary hover:bg-black/[0.04] dark:hover:bg-white/[0.06]" data-txid="${escapeHtml(dep.tx_hash)}" aria-label="Copy transaction hash"><svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-12A1.125 1.125 0 011.5 20.625V7.5a1.125 1.125 0 011.125-1.125H6m11.5-3v10.5a1.125 1.125 0 01-1.125 1.125H5.625m12.75-12.75h.008v.008h-.008V3.75zM19.5 8.25h.008v.008H19.5V8.25zm0 4.5h.008v.008H19.5v-.008zm0 4.5h.008v.008H19.5v-.008zM15 3.75h.008v.008H15V3.75zm4.5 0h.008v.008H19.5V3.75z"/></svg></button>` : ''}
            </div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-[12px] text-text-secondary dark:text-text-secondary-dark">Submitted</span>
            <span class="text-[12px] text-text-primary dark:text-text-primary-dark">${formatTime(dep.created_at)}</span>
          </div>
        </div>
      `;
      content.appendChild(card);

      // Copy TXID
      const copyBtn = card.querySelector('.pending-copy-txid');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard?.writeText(copyBtn.dataset.txid);
          copyBtn.innerHTML = `<svg class="h-3.5 w-3.5 text-green-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5"/></svg>`;
          setTimeout(() => {
            copyBtn.innerHTML = `<svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-12A1.125 1.125 0 011.5 20.625V7.5a1.125 1.125 0 011.125-1.125H6m11.5-3v10.5a1.125 1.125 0 01-1.125 1.125H5.625m12.75-12.75h.008v.008h-.008V3.75zM19.5 8.25h.008v.008H19.5V8.25zm0 4.5h.008v.008H19.5v-.008zm0 4.5h.008v.008H19.5v-.008zM15 3.75h.008v.008H15V3.75zm4.5 0h.008v.008H19.5V3.75z"/></svg>`;
          }, 2000);
        });
      }
    });

    // Refresh + back buttons
    const actions = document.createElement('div');
    actions.className = 'flex flex-col gap-3 pt-2';
    actions.innerHTML = `
      <button class="btn-secondary w-full" id="refresh-pending">Refresh</button>
      <button class="btn-secondary w-full" id="back-to-networks">New Deposit</button>
      <button class="w-full text-center text-[13px] text-text-secondary dark:text-text-secondary-dark hover:text-text-primary dark:hover:text-text-primary-dark transition-colors mt-1" id="pending-support-link">Need help with a deposit? Create a support ticket</button>
    `;
    content.appendChild(actions);

    container.appendChild(content);

    content.querySelector('#refresh-pending').addEventListener('click', async () => {
      await loadPendingDeposits();
      render();
    });
    content.querySelector('#back-to-networks').addEventListener('click', () => {
      screen = 'networks';
      render();
    });
    content.querySelector('#pending-support-link').addEventListener('click', () => {
      navigate('create-ticket?ctx=deposit');
    });
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================
  async function generateQR(container, address) {
    const qrContainer = container.querySelector('.dm-qr-gen');
    if (!qrContainer) return;
    try {
      const dataUrl = await QRCode.toDataURL(address, {
        width: 180,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      });
      qrContainer.innerHTML = `<img src="${dataUrl}" alt="QR code for deposit address" class="rounded-lg" style="width:160px;height:160px" />`;
    } catch {
      qrContainer.innerHTML = `<p class="text-[12px] text-text-secondary dark:text-text-secondary-dark text-center">QR code generation failed</p>`;
    }
  }

  function parseAmount(str) {
    if (!str || !str.trim()) return null;
    const cleaned = str.trim().replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
    const num = parseFloat(cleaned);
    if (isNaN(num) || !isFinite(num)) return null;
    if (num <= 0) return null;
    return num;
  }

  function formatAmount(num) {
    if (num === null || num === undefined) return '—';
    return Number(num).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
  }

  function formatTime(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch {
      return '—';
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  render();
  return page;
}
