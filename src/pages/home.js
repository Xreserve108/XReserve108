import { getPlatformRate } from '@/data/platform-rate';
import { createMarketPulse } from '@/components/MarketPulse';

export async function renderHome() {
  const page = document.createElement('main');
  page.className = 'page-enter flex min-h-[calc(100dvh-80px)] flex-col px-5 pb-24 pt-8 md:px-8 md:pb-8 lg:px-12';

  page.innerHTML = `
    <section class="flex flex-col items-start py-6 md:py-12 lg:py-20">
      <p class="text-muted mb-3 animate-fade-in">USDT → INR Exchange</p>
      <h1 class="display mb-2 md:text-[52px] lg:text-[56px]">
        Sell Crypto.<br/>Get INR.
      </h1>
      <p class="text-muted mt-3 max-w-[320px]">
        Fast, secure USDT to INR conversion. Deposit, sell, and receive directly to your bank.
      </p>

      <div class="card mt-8 w-full p-5">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">Platform Rate</p>
            <p class="mt-1 text-[13px] text-text-secondary dark:text-text-secondary-dark">1 USDT</p>
          </div>
          <div class="text-right">
            <p id="home-rate-value" class="text-[28px] font-bold tracking-tight text-text-primary dark:text-text-primary-dark">--</p>
            <p class="text-[12px] font-medium text-green-600 dark:text-green-400">+0.32%</p>
          </div>
        </div>
      </div>

      <div id="market-pulse-slot" class="mt-4 w-full"></div>

      <div class="mt-6 flex w-full gap-3">
        <a href="#sell" class="btn-primary flex-1 text-center">Sell USDT</a>
        <a href="#wallet" class="btn-secondary flex-1 text-center">Deposit</a>
      </div>
    </section>

    <section class="mt-2">
      <div class="card p-5">
        <h2 class="section-heading mb-4">How the XReserve rate works</h2>
        <ul class="space-y-2.5">
          ${disclaimerItem('XReserve displays a platform rate for USDT/INR.')}
          ${disclaimerItem('The displayed rate can change as market conditions change.')}
          ${disclaimerItem('The rate shown at the time an order is created is the rate used for that order, subject to the platform\u2019s order rules.')}
          ${disclaimerItem('The amount shown before confirmation is an estimate based on the displayed platform rate.')}
          ${disclaimerItem('Actual payment timing for sell orders can vary depending on availability of funds and processing.')}
          ${disclaimerItem('Market or reference prices may differ from XReserve\u2019s platform rate.')}
        </ul>
      </div>
    </section>
  `;

  // Mount Market Pulse widget
  const mpSlot = page.querySelector('#market-pulse-slot');
  if (mpSlot) {
    mpSlot.appendChild(createMarketPulse());
  }

  // Load authoritative platform rate into the rate card
  getPlatformRate().then(({ rate }) => {
    const formatted = `₹${Number(rate).toFixed(2)}`;
    const rateEl = page.querySelector('#home-rate-value');
    if (rateEl) rateEl.textContent = formatted;
  });

  return page;
}

function disclaimerItem(text) {
  return `
    <li class="flex gap-2.5 text-[13px] leading-relaxed text-text-secondary dark:text-text-secondary-dark">
      <span class="mt-[7px] h-1 w-1 flex-shrink-0 rounded-full bg-current opacity-60"></span>
      <span>${text}</span>
    </li>
  `;
}
