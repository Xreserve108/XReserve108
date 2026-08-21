import { isAuthenticated } from '@/core/auth';
import { getWalletBalance, refreshWalletBalance } from '@/data/wallet-data';
import { getPlatformRate, DEV_FALLBACK_RATE } from '@/data/platform-rate';
import { createMarketPulse } from '@/components/MarketPulse';
import { TetherIcon } from '@/components/icons/TetherIcon';
import { InrIcon } from '@/components/icons/InrIcon';
import { openSellWorkflow } from '@/pages/sell';
import { navigate } from '@/core/router';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAmount(num) {
  const n = Number(num);
  if (!isFinite(n) || n < 0) return '0.00';
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function formatInr(num) {
  return `₹${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export async function renderHome() {
  const { rate } = await getPlatformRate();
  const authenticated = isAuthenticated();
  const walletBalance = authenticated ? await getWalletBalance() : null;
  const available = walletBalance ? walletBalance.available : 0;

  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  // ---- Hero ----
  const heroHtml = `
    <section class="flex flex-col items-start py-6 md:py-12 lg:py-20">
      <p class="text-muted mb-3 animate-fade-in">USDT → INR Exchange</p>
      <h1 class="display mb-2 md:text-[52px] lg:text-[56px]">
        Sell Crypto.<br/>Get INR.
      </h1>
      <p class="text-muted mt-3 max-w-[320px]">
        Fast, secure USDT to INR conversion. Deposit, sell, and receive directly to your bank.
      </p>
    </section>
  `;

  // ---- Rate card ----
  const rateCardHtml = `
    <div class="card mt-8 w-full p-5">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">Platform Rate</p>
          <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">1 USDT</p>
        </div>
        <div class="text-right">
          <p id="home-rate-value" class="text-[28px] font-bold tracking-tight text-text-primary dark:text-text-primary-dark">₹${rate.toFixed(2)}</p>
          <p class="text-[12px] font-medium text-green-600 dark:text-green-400">Live</p>
        </div>
      </div>
    </div>
  `;

  // ---- Market Pulse ----
  const marketPulseHtml = `<div id="market-pulse-slot" class="mt-4 w-full"></div>`;

  // ---- CTA buttons (always visible) ----
  const ctaHtml = `
    <div class="mt-6 flex w-full gap-3">
      <a href="#deposit" class="btn-primary flex-1 text-center">Deposit</a>
    </div>
  `;

  // ---- Instant Sell panel (authenticated users only) ----
  let instantSellHtml = '';
  if (authenticated) {
    instantSellHtml = buildInstantSellPanel(available, rate);
  }

  // ---- Value propositions ----
  const valuePropsHtml = buildValueProps();

  // ---- Footer ----
  const footerHtml = buildFooter();

  page.innerHTML = `
    ${heroHtml}
    ${rateCardHtml}
    ${marketPulseHtml}
    ${instantSellHtml}
    ${ctaHtml}
    ${valuePropsHtml}
    ${footerHtml}
  `;

  // Mount Market Pulse widget
  const mpSlot = page.querySelector('#market-pulse-slot');
  if (mpSlot) {
    mpSlot.appendChild(createMarketPulse());
  }

  // Setup Instant Sell interactions for authenticated users
  if (authenticated) {
    setupInstantSellInteractions(page, rate, available);
  }

  return page;
}

// ---------------------------------------------------------------------------
// Instant Sell panel builder
// ---------------------------------------------------------------------------

function buildInstantSellPanel(balance, rate) {
  const hasBalance = balance > 0;

  return `
    <div class="mt-8 w-full">
      <div class="card relative overflow-hidden p-5">
        <div class="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-500/30 to-transparent dark:via-emerald-400/25"></div>

        <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">Your USDT Balance</p>
        <div class="mt-1 flex items-center gap-2">
          <span id="home-balance" class="text-[22px] font-bold tracking-tight text-text-primary dark:text-text-primary-dark">${formatAmount(balance)}</span>
          <div class="flex items-center gap-1">
            ${TetherIcon({ className: 'h-3.5 w-3.5' })}
            <span class="text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark">USDT</span>
          </div>
        </div>

        <div class="divider my-4"></div>

        <label class="label" for="home-sell-amount">Amount to sell</label>
        <div class="relative">
          <input
            id="home-sell-amount"
            type="number"
            class="input-field pr-16"
            placeholder="0.00"
            min="0"
            step="0.01"
            inputmode="decimal"
            autocomplete="off"
            aria-label="USDT amount to sell"
          />
          <div class="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
            <button type="button" id="home-max-btn" class="rounded-full bg-[#ECECEF] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-text-secondary transition-colors duration-150 hover:bg-[#E2E2E7] active:bg-[#D9D9DE] dark:bg-[#161616] dark:text-text-secondary-dark dark:hover:bg-[#1F1F1F]" aria-label="Fill maximum amount">MAX</button>
            <div class="flex items-center gap-1">
              ${TetherIcon({ className: 'h-3.5 w-3.5' })}
              <span class="text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark">USDT</span>
            </div>
          </div>
        </div>

        <div class="mt-3 flex items-center justify-center">
          <svg class="h-4 w-4 text-text-secondary/40 dark:text-text-secondary-dark/40" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3"/></svg>
        </div>

        <div class="mt-2">
          <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">You receive (estimated)</p>
          <div class="mt-1 flex items-center gap-2">
            <p id="home-payout" class="text-[22px] font-bold tracking-tight text-text-primary dark:text-text-primary-dark">₹0.00</p>
            <div class="flex items-center gap-1">
              ${InrIcon({ className: 'h-4 w-4' })}
              <span class="text-[12px] font-medium text-text-secondary dark:text-text-secondary-dark">INR</span>
            </div>
          </div>
        </div>

        <div class="mt-3 flex items-center justify-between text-[12px]">
          <span class="text-text-secondary dark:text-text-secondary-dark">Rate</span>
          <span class="font-medium text-text-primary dark:text-text-primary-dark">1 USDT = ₹${rate.toFixed(2)}</span>
        </div>

        <button id="home-sell-btn" class="btn-primary mt-5 w-full" ${!hasBalance ? 'disabled' : ''}>Instant Sell</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Instant Sell interactions
// ---------------------------------------------------------------------------

function setupInstantSellInteractions(container, initialRate, balance) {
  const input = container.querySelector('#home-sell-amount');
  const maxBtn = container.querySelector('#home-max-btn');
  const payout = container.querySelector('#home-payout');
  const sellBtn = container.querySelector('#home-sell-btn');
  if (!input || !sellBtn) return;

  let RATE = initialRate;
  let BALANCE = balance;

  function updatePayout() {
    const amount = parseFloat(input.value) || 0;
    const inr = amount * RATE;
    if (payout) {
      payout.textContent = formatInr(inr);
    }
    if (sellBtn) {
      sellBtn.disabled = amount <= 0 || amount > BALANCE;
    }
  }

  input.addEventListener('input', updatePayout);

  if (maxBtn) {
    maxBtn.addEventListener('click', () => {
      input.value = BALANCE.toString();
      updatePayout();
      input.focus();
    });
  }

  // Refresh rate periodically to keep the displayed estimate current
  const rateInterval = setInterval(() => {
    getPlatformRate().then(({ rate: newRate }) => {
      RATE = newRate;
      updatePayout();
    });
  }, 20000);

  // Clean up interval when the page is replaced
  const observer = new MutationObserver(() => {
    if (!document.body.contains(container)) {
      clearInterval(rateInterval);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: false });

  sellBtn.addEventListener('click', () => {
    const amount = parseFloat(input.value) || 0;
    if (amount <= 0 || amount > BALANCE) return;

    openSellWorkflow(container, amount, RATE, async () => {
      // After successful order, refresh wallet and reset the panel
      await refreshWalletBalance();
      const fresh = await getWalletBalance();
      if (fresh && isFinite(fresh.available)) {
        BALANCE = fresh.available;
      }
      input.value = '';
      updatePayout();
    });
  });
}

// ---------------------------------------------------------------------------
// Value propositions (replaces "How the XReserve rate works")
// ---------------------------------------------------------------------------

function buildValueProps() {
  return `
    <section class="mt-12">
      <div class="card p-5">
        <div class="space-y-5">
          ${valuePropItem(
            vpIconBolt(),
            'Instant Settlement',
            'Submit your sell order and track its progress in real time through XReserve\u2019s streamlined transaction workflow.'
          )}
          <div class="divider"></div>
          ${valuePropItem(
            vpIconShield(),
            'Secure Architecture',
            'Built with row-level security, two-factor verification, and controlled transaction processing so your funds stay protected at every step.'
          )}
          <div class="divider"></div>
          ${valuePropItem(
            vpIconEye(),
            'Transparent Execution',
            'See the platform rate, order details, and estimated payout clearly before you confirm. No hidden calculations.'
          )}
        </div>
      </div>
    </section>
  `;
}

function valuePropItem(iconSvg, title, text) {
  return `
    <div class="flex gap-3.5">
      <div class="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl bg-black/[0.04] dark:bg-white/[0.06]">
        ${iconSvg}
      </div>
      <div>
        <h3 class="text-[14px] font-semibold text-text-primary dark:text-text-primary-dark">${title}</h3>
        <p class="mt-1 text-[13px] leading-relaxed text-text-secondary dark:text-text-secondary-dark">${text}</p>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function buildFooter() {
  return `
    <footer class="mt-12 pb-4">
      <div class="divider mb-6"></div>
      <div class="flex flex-col items-center text-center">
        <p class="text-[15px] font-semibold text-text-primary dark:text-text-primary-dark">XReserve</p>
        <p class="mt-0.5 text-[12px] text-text-secondary dark:text-text-secondary-dark">v2.0</p>
        <p class="mt-4 max-w-sm text-[11px] leading-relaxed text-text-secondary/70 dark:text-text-secondary-dark/70">
          Digital asset conversion involves risk. Rates may fluctuate. XReserve provides a platform for USDT-to-INR conversion and does not guarantee specific settlement timelines.
        </p>
        <p class="mt-4 text-[11px] text-text-secondary/50 dark:text-text-secondary-dark/50">&copy; 2026 XReserve</p>
      </div>
    </footer>
  `;
}

// ---------------------------------------------------------------------------
// Value-prop icon SVGs (compact, 16×16, stroke-based)
// ---------------------------------------------------------------------------

function vpIconBolt() {
  return `<svg class="h-4 w-4 text-amber-500 dark:text-amber-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"/></svg>`;
}

function vpIconShield() {
  return `<svg class="h-4 w-4 text-emerald-500 dark:text-emerald-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622A11.99 11.99 0 0020.402 6a11.959 11.959 0 00-8.402-3.286z"/></svg>`;
}

function vpIconEye() {
  return `<svg class="h-4 w-4 text-sky-500 dark:text-sky-400" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`;
}
