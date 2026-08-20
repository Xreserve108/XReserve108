import { supabase } from '@/lib/supabase';

/**
 * Market data module — fetches USDT/INR reference rates from
 * Binance, OKX, and Bybit via the market-rates Edge Function.
 *
 * Price type: Non-P2P reference/conversion prices.
 * Each exchange provides USDT/USD spot price; USD/INR cross rate
 * is derived from CoinGecko aggregate.
 *
 * Architecture:
 *   Frontend → Edge Function (market-rates) → Exchange APIs + CoinGecko
 *   → Normalize → Return per-exchange USDT/INR
 */

const CACHE_TTL_MS = 20_000; // 20 seconds

let cache = null;
let cacheTimestamp = 0;
let inflightRequest = null;

/**
 * Fetch market rates. Returns cached data if fresh (< 20s old).
 * Deduplicates concurrent requests.
 *
 * @returns {Promise<MarketData|null>}
 */
export async function getMarketRates() {
  const now = Date.now();

  // Return fresh cache
  if (cache && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cache;
  }

  // Deduplicate concurrent requests
  if (inflightRequest) {
    return inflightRequest;
  }

  inflightRequest = _fetchRates().finally(() => {
    inflightRequest = null;
  });

  return inflightRequest;
}

/**
 * Force a fresh fetch, bypassing cache.
 * @returns {Promise<MarketData|null>}
 */
export async function refreshMarketRates() {
  cache = null;
  cacheTimestamp = 0;
  return getMarketRates();
}

/**
 * Get the age of the cached data in seconds, or null if no cache.
 */
export function getCacheAgeSeconds() {
  if (!cache) return null;
  return Math.round((Date.now() - cacheTimestamp) / 1000);
}

// -----------------------------------------------------------------------------
// Internal
// -----------------------------------------------------------------------------

async function _fetchRates() {
  // Try Edge Function first (preferred: fetches all 3 exchanges server-side)
  // The Edge Function only accepts GET; supabase.functions.invoke defaults to POST.
  try {
    const { data, error } = await supabase.functions.invoke('market-rates', { method: 'GET' });

    if (data && !error) {
      const rates = _normalizeResponse(data);
      cache = rates;
      cacheTimestamp = Date.now();
      return rates;
    }
    console.warn('market-rates invoke error:', error);
  } catch (err) {
    console.warn('market-rates Edge Function unavailable, trying direct fallback:', err.message);
  }

  // Fallback: direct browser calls (Binance data API supports CORS)
  try {
    const rates = await _fetchDirectFallback();
    if (rates) {
      cache = rates;
      cacheTimestamp = Date.now();
    }
    return rates;
  } catch (err) {
    console.warn('market-rates direct fallback failed:', err);
    return null;
  }
}

/**
 * Direct browser fallback — calls CORS-enabled APIs only.
 * Binance data API (CORS ✓) + CoinGecko keyless API (CORS ✓).
 * OKX and Bybit don't support CORS, so they're marked unavailable.
 */
async function _fetchDirectFallback() {
  const [binanceRes, coingeckoRes] = await Promise.allSettled([
    fetch('https://data-api.binance.vision/api/v3/ticker/price?symbol=USDTUSD').then((r) => r.ok ? r.json() : Promise.reject()),
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd,inr').then((r) => r.ok ? r.json() : Promise.reject()),
  ]);

  const binanceUsd = binanceRes.status === 'fulfilled' ? parseFloat(binanceRes.value?.price) : null;
  const cgUsd = coingeckoRes.status === 'fulfilled' ? coingeckoRes.value?.tether?.usd : null;
  const cgInr = coingeckoRes.status === 'fulfilled' ? coingeckoRes.value?.tether?.inr : null;

  const usdInr = (cgUsd && cgInr && cgUsd > 0) ? cgInr / cgUsd : null;

  const exchanges = [
    {
      name: 'Binance',
      rate: (binanceUsd && usdInr) ? round2(binanceUsd * usdInr) : null,
      usdRate: (binanceUsd && isFinite(binanceUsd)) ? binanceUsd : null,
      error: binanceUsd ? null : 'Unavailable',
    },
    { name: 'OKX', rate: null, usdRate: null, error: 'Unavailable' },
    { name: 'Bybit', rate: null, usdRate: null, error: 'Unavailable' },
  ];

  return _normalizeResponse({
    exchanges,
    usdInrRate: usdInr ? round2(usdInr) : null,
    fetchedAt: new Date().toISOString(),
  });
}

function _normalizeResponse(raw) {
  const exchanges = (raw.exchanges || []).map((ex) => ({
    name: ex.name,
    rate: typeof ex.rate === 'number' && isFinite(ex.rate) && ex.rate > 0
      ? ex.rate
      : null,
    usdRate: typeof ex.usdRate === 'number' && isFinite(ex.usdRate) && ex.usdRate > 0
      ? ex.usdRate
      : null,
    error: ex.error || null,
  }));

  const availableRates = exchanges
    .filter((ex) => ex.rate !== null)
    .map((ex) => ex.rate);

  const marketAverage = availableRates.length > 0
    ? round2(availableRates.reduce((a, b) => a + b, 0) / availableRates.length)
    : null;

  const marketRange = availableRates.length >= 2
    ? {
        low: round2(Math.min(...availableRates)),
        high: round2(Math.max(...availableRates)),
      }
    : null;

  return {
    xreserveRate: typeof raw.xreserveRate === 'number' && isFinite(raw.xreserveRate) && raw.xreserveRate > 0
      ? raw.xreserveRate
      : null,
    exchanges,
    marketAverage,
    marketRange,
    sourceCount: availableRates.length,
    usdInrRate: typeof raw.usdInrRate === 'number' ? raw.usdInrRate : null,
    fetchedAt: raw.fetchedAt || new Date().toISOString(),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
