import { getMarketRates, refreshMarketRates } from '@/data/market-data';
import { DEV_FALLBACK_RATE } from '@/data/platform-rate';
import { TetherIcon } from '@/components/icons/TetherIcon';

const REFRESH_INTERVAL_MS = 20_000;
const STALE_THRESHOLD_S = 60;

const tetherIcon = TetherIcon({ className: 'h-4 w-4' });

const infoIcon = `<svg class="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/></svg>`;

const TOOLTIP_TEXT = 'Market reference rates are derived from exchange USDT/USD prices and a USD/INR market reference. They are for comparison only and are not P2P or executable INR quotes.';

/**
 * Create the Market Pulse widget DOM element.
 * Starts fetching immediately and auto-refreshes.
 * @returns {HTMLElement}
 */
export function createMarketPulse() {
  const container = document.createElement('div');
  container.id = 'market-pulse';
  container.className = 'card overflow-hidden p-0';

  // Render skeleton immediately
  container.innerHTML = skeletonHTML();

  // Start data lifecycle
  let refreshTimer = null;
  let tickTimer = null;

  async function load(showSkeleton = false) {
    if (showSkeleton) {
      container.querySelector('#mp-body').innerHTML = skeletonBodyHTML();
      updateStatus(container, 'updating');
    }

    const data = await getMarketRates();
    if (data) {
      renderData(container, data);
    } else {
      renderError(container);
    }
  }

  // Initial load
  load(false);

  // Auto-refresh
  refreshTimer = setInterval(() => load(true), REFRESH_INTERVAL_MS);

  // Tick the freshness counter every second
  tickTimer = setInterval(() => updateFreshness(container), 1000);

  // Cleanup on disconnect
  const observer = new MutationObserver(() => {
    if (!document.getElementById('market-pulse')) {
      clearInterval(refreshTimer);
      clearInterval(tickTimer);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return container;
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

function renderData(container, data) {
  const body = container.querySelector('#mp-body');
  if (!body) return;

  const xreserveRate = (data.xreserveRate !== null && data.xreserveRate !== undefined)
    ? data.xreserveRate
    : DEV_FALLBACK_RATE;
  const availableExchanges = data.exchanges.filter((ex) => ex.rate !== null);
  const hasAny = availableExchanges.length > 0;

  // Calculate XReserve vs market
  let diff = null;
  let diffPct = null;
  if (xreserveRate !== null && hasAny && data.marketAverage !== null) {
    diff = round2(xreserveRate - data.marketAverage);
    diffPct = round2((diff / data.marketAverage) * 100);
  }

  body.innerHTML = `
    <div class="divide-y divide-border-light dark:divide-border-dark">
      <!-- XReserve rate -->
      <div class="mp-row flex items-center justify-between px-4 py-3">
        <div class="flex items-center gap-2">
          ${tetherIcon}
          <span class="text-[13px] font-semibold text-text-primary dark:text-text-primary-dark">XReserve</span>
        </div>
        <span class="text-[15px] font-bold tabular-nums text-text-primary dark:text-text-primary-dark">${xreserveRate !== null ? '₹' + formatRate(xreserveRate) : '--'}</span>
      </div>

      <!-- Market reference section -->
      ${hasAny ? `
      <div class="px-4 pt-3 pb-1">
        <div class="flex items-center gap-1.5">
          <span class="text-[11px] font-medium uppercase tracking-wider text-text-secondary dark:text-text-secondary-dark">Market reference</span>
          <span class="mp-tooltip-wrap relative inline-flex">
            <button class="mp-tooltip-trigger flex items-center justify-center text-text-secondary/50 hover:text-text-secondary dark:text-text-secondary-dark/50 dark:hover:text-text-secondary-dark transition-colors" aria-label="About market reference rates">
              ${infoIcon}
            </button>
            <span class="mp-tooltip absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-lg border border-border-light bg-surface-light px-3 py-2 text-[11px] leading-snug text-text-secondary shadow-card dark:border-border-dark dark:bg-surface-dark dark:text-text-secondary-dark dark:shadow-card-dark opacity-0 pointer-events-none transition-opacity duration-150">
              ${escapeHTML(TOOLTIP_TEXT)}
            </span>
          </span>
        </div>
      </div>
      ${data.exchanges.map((ex) => exchangeRowHTML(ex)).join('')}
      <div class="mp-row flex items-center justify-between px-4 py-3">
        <span class="text-[13px] font-medium text-text-primary dark:text-text-primary-dark">
          Average${data.sourceCount < 3 ? ` <span class="text-[11px] font-normal text-text-secondary dark:text-text-secondary-dark">· ${data.sourceCount} source${data.sourceCount !== 1 ? 's' : ''}</span>` : ''}
        </span>
        <span class="text-[13px] font-semibold tabular-nums text-text-primary dark:text-text-primary-dark">₹${formatRate(data.marketAverage)}</span>
      </div>
      ` : ''}

      <!-- XReserve vs market -->
      ${diff !== null ? `
      <div class="flex items-center justify-between px-4 py-3">
        <span class="text-[12px] text-text-secondary dark:text-text-secondary-dark">XReserve vs market</span>
        <span class="text-[12px] font-medium tabular-nums ${diff >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}">
          ${diff >= 0 ? '+' : ''}₹${formatRate(Math.abs(diff))} · ${diff >= 0 ? '+' : ''}${diffPct.toFixed(2)}%
        </span>
      </div>
      ` : ''}
    </div>

    <!-- Freshness -->
    <div class="flex items-center justify-between border-t border-border-light px-4 py-2 dark:border-border-dark">
      <span id="mp-freshness" class="text-[11px] text-text-secondary dark:text-text-secondary-dark" data-fetched-at="${data.fetchedAt}">
        ${freshnessText(data.fetchedAt)}
      </span>
      <button id="mp-refresh-btn" class="flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-black/[0.04] dark:text-text-secondary-dark dark:hover:bg-white/[0.06]" aria-label="Refresh market data">
        <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          <path d="M21 3v9h-9"/>
        </svg>
      </button>
    </div>
  `;

  // Status indicator
  updateStatus(container, 'live');

  // Tooltip interactions
  const tooltipTrigger = body.querySelector('.mp-tooltip-trigger');
  const tooltipContent = body.querySelector('.mp-tooltip');
  if (tooltipTrigger && tooltipContent) {
    tooltipTrigger.addEventListener('mouseenter', () => { tooltipContent.style.opacity = '1'; });
    tooltipTrigger.addEventListener('mouseleave', () => { tooltipContent.style.opacity = '0'; });
    tooltipTrigger.addEventListener('focus', () => { tooltipContent.style.opacity = '1'; });
    tooltipTrigger.addEventListener('blur', () => { tooltipContent.style.opacity = '0'; });
  }

  // Refresh button
  const refreshBtn = body.querySelector('#mp-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      await refreshMarketRates();
      const newData = await getMarketRates();
      if (newData) renderData(container, newData);
      refreshBtn.disabled = false;
    });
  }
}

function renderError(container) {
  const body = container.querySelector('#mp-body');
  if (!body) return;

  body.innerHTML = `
    <div class="px-4 py-6 text-center">
      <p class="text-[13px] text-text-secondary dark:text-text-secondary-dark">Market data temporarily unavailable</p>
      <p class="mt-1 text-[12px] text-text-secondary/60 dark:text-text-secondary-dark/60">Retrying automatically</p>
      <button id="mp-retry-btn" class="mt-3 text-[12px] font-medium text-action dark:text-action-dark underline-offset-2 hover:underline">
        Retry now
      </button>
    </div>
  `;

  updateStatus(container, 'delayed');

  const retryBtn = body.querySelector('#mp-retry-btn');
  if (retryBtn) {
    retryBtn.addEventListener('click', async () => {
      container.querySelector('#mp-body').innerHTML = skeletonBodyHTML();
      updateStatus(container, 'updating');
      await refreshMarketRates();
      const data = await getMarketRates();
      if (data) renderData(container, data);
      else renderError(container);
    });
  }
}

function exchangeRowHTML(ex) {
  const name = escapeHTML(ex.name);
  const logo = getExchangeLogo(ex.name);
  if (ex.rate !== null) {
    return `
      <div class="mp-row flex items-center justify-between px-4 py-3">
        <div class="flex items-center gap-2">
          ${logo}
          <span class="text-[13px] font-semibold text-[#1a1a1a] dark:text-[#f5f5f5]">${name}</span>
        </div>
        <span class="text-[13px] font-medium tabular-nums text-text-primary dark:text-text-primary-dark">₹${formatRate(ex.rate)}</span>
      </div>
    `;
  }
  return `
    <div class="mp-row flex items-center justify-between px-4 py-3">
      <div class="flex items-center gap-2">
        ${logo}
        <span class="text-[13px] font-semibold text-[#1a1a1a] dark:text-[#f5f5f5]">${name}</span>
      </div>
      <span class="text-[12px] text-text-secondary/50 dark:text-text-secondary-dark/50">Unavailable</span>
    </div>
  `;
}

function getExchangeLogo(name) {
  const lower = (name || '').toLowerCase();
  if (lower.includes('binance')) {
    // Binance diamond logo
    return `<svg class="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 126 126" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M38.76 53.2L63 29l24.24 24.24L63 77.44 38.76 53.2z" fill="#F0B90B"/>
      <path d="M63 14.76L38.76 39l-14-14L49 0l14 14.76zM63 14.76L87.24 39l14-14L77 0 63 14.76zM14.76 63L39 38.76l-14-14L0 49l14.76 14zM14.76 63L39 87.24l-14 14L0 77l14.76-14zM63 111.24L38.76 87l-14 14L49 126l14-14.76zM63 111.24L87.24 87l14 14L77 126l-14-14.76zM111.24 63L87 38.76l14-14L126 49l-14.76 14zM111.24 63L87 87.24l14 14L126 77l-14.76-14z" fill="#F0B90B"/>
    </svg>`;
  }
  if (lower.includes('okx')) {
    // OKX logo - simple geometric (black squares)
    return `<svg class="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="8" height="8" rx="1" fill="#000000" class="dark:fill-white"/>
      <rect x="14" y="2" width="8" height="8" rx="1" fill="#000000" class="dark:fill-white"/>
      <rect x="2" y="14" width="8" height="8" rx="1" fill="#000000" class="dark:fill-white"/>
      <rect x="14" y="14" width="8" height="8" rx="1" fill="#000000" class="dark:fill-white"/>
    </svg>`;
  }
  if (lower.includes('bybit')) {
    // Bybit logo - stylized B (black)
    return `<svg class="h-3.5 w-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 4h8.5c2.5 0 4.5 2 4.5 4.5 0 1.8-1 3.3-2.5 4 2 .7 3.5 2.5 3.5 4.8 0 2.8-2.2 5-5 5H5V4zm4 4v3h4c.8 0 1.5-.7 1.5-1.5S13.8 8 13 8H9zm0 6v3h4.5c1 0 1.8-.8 1.8-1.8 0-.9-.8-1.7-1.8-1.7H9z" fill="#000000" class="dark:fill-white"/>
    </svg>`;
  }
  // Default: small dot
  return `<span class="h-2 w-2 flex-shrink-0 rounded-full bg-text-secondary/40 dark:bg-text-secondary-dark/40"></span>`;
}

// -----------------------------------------------------------------------------
// Skeleton / Loading
// -----------------------------------------------------------------------------

function skeletonHTML() {
  return `
    <div class="flex items-center justify-between border-b border-border-light px-4 py-2.5 dark:border-border-dark">
      <div class="flex items-center gap-2">
        ${tetherIcon}
        <span class="text-[12px] font-semibold text-text-primary dark:text-text-primary-dark">USDT / INR Market Pulse</span>
      </div>
      <span id="mp-status" class="flex items-center gap-1.5 text-[11px] text-text-secondary dark:text-text-secondary-dark">
        <span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400"></span>
        Updating
      </span>
    </div>
    <div id="mp-body">
      ${skeletonBodyHTML()}
    </div>
  `;
}

function skeletonBodyHTML() {
  const rateWidth = `<div class="h-3.5 w-14 animate-pulse rounded bg-black/[0.06] dark:bg-white/[0.08]"></div>`;
  return `
    <div class="divide-y divide-border-light dark:divide-border-dark">
      <div class="flex items-center justify-between px-4 py-3">
        <div class="h-3.5 w-16 animate-pulse rounded bg-black/[0.06] dark:bg-white/[0.08]"></div>
        ${rateWidth}
      </div>
      <div class="px-4 pt-3 pb-1">
        <div class="h-2.5 w-28 animate-pulse rounded bg-black/[0.04] dark:bg-white/[0.06]"></div>
      </div>
      ${[1, 2, 3].map(() => `
        <div class="mp-row flex items-center justify-between px-4 py-3">
          <div class="h-3 w-12 animate-pulse rounded bg-black/[0.04] dark:bg-white/[0.06]"></div>
          ${rateWidth}
        </div>
      `).join('')}
      <div class="mp-row flex items-center justify-between px-4 py-3">
        <div class="h-3 w-20 animate-pulse rounded bg-black/[0.04] dark:bg-white/[0.06]"></div>
        ${rateWidth}
      </div>
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Status / Freshness
// -----------------------------------------------------------------------------

function updateStatus(container, status) {
  const statusEl = container.querySelector('#mp-status');
  if (!statusEl) return;

  const configs = {
    live: { dot: 'bg-green-500', text: 'Live', animate: false },
    updating: { dot: 'bg-amber-400', text: 'Updating', animate: true },
    delayed: { dot: 'bg-red-400', text: 'Delayed', animate: false },
  };

  const cfg = configs[status] || configs.live;
  statusEl.innerHTML = `
    <span class="inline-block h-1.5 w-1.5 ${cfg.animate ? 'animate-pulse' : ''} rounded-full ${cfg.dot}"></span>
    ${cfg.text}
  `;
}

function updateFreshness(container) {
  const el = container.querySelector('#mp-freshness');
  if (!el) return;
  const fetchedAt = el.dataset.fetchedAt;
  if (!fetchedAt) return;
  el.textContent = freshnessText(fetchedAt);
}

function freshnessText(isoTimestamp) {
  const seconds = Math.round((Date.now() - new Date(isoTimestamp).getTime()) / 1000);
  if (seconds < 5) return 'Updated just now';
  if (seconds < 60) return `Updated ${seconds}s ago`;
  if (seconds < STALE_THRESHOLD_S) return `Updated ${Math.round(seconds / 60)}m ago`;
  return 'Data delayed';
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function formatRate(n) {
  if (n === null || n === undefined || !isFinite(n)) return '--';
  return n.toFixed(2);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}
