// XReserve — Market Rates Edge Function
//
// Fetches USDT/USD reference prices from Binance, OKX, and Bybit,
// derives a USD/INR cross rate from CoinGecko, and returns
// per-exchange USDT/INR reference prices.
//
// Also reads the authoritative XReserve platform rate from
// exchange_settings (server-side only — never exposed to browser directly).
//
// PRICE TYPE: Non-P2P reference/conversion prices (spot USDT/USD).
// None of the three exchanges offer a direct USDT/INR spot pair.
// USDT/INR is derived: exchange_usdt_usd × (coingecko_usdt_inr / coingecko_usdt_usd)
//
// No client authentication required — public market data + read-only DB access.

import { CORS, serviceClient } from "../_shared/common.ts";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const TIMEOUT_MS = 8000;

interface ExchangeResult {
  name: string;
  rate: number | null;
  usdRate: number | null;
  error: string | null;
}

// -----------------------------------------------------------------------------
// Fetch with timeout
// -----------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs = TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Exchange fetchers — each returns USDT/USD spot price
// -----------------------------------------------------------------------------

async function fetchBinance(): Promise<ExchangeResult> {
  // Binance data API (market-data only, CORS-enabled)
  // Price type: spot reference price for USDTUSD
  const res = await fetchWithTimeout(
    "https://data-api.binance.vision/api/v3/ticker/price?symbol=USDTUSD",
  );
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const data = await res.json();
  const price = parseFloat(data.price);
  if (!isFinite(price) || price <= 0) throw new Error("Binance invalid price");
  return { name: "Binance", rate: null, usdRate: price, error: null };
}

async function fetchOKX(): Promise<ExchangeResult> {
  // OKX v5 public market API
  // Price type: spot last price for USDT-USD
  const res = await fetchWithTimeout(
    "https://www.okx.com/api/v5/market/ticker?instId=USDT-USD",
  );
  if (!res.ok) throw new Error(`OKX HTTP ${res.status}`);
  const data = await res.json();
  if (data.code !== "0" || !data.data?.[0]) {
    throw new Error("OKX invalid response");
  }
  const price = parseFloat(data.data[0].last);
  if (!isFinite(price) || price <= 0) throw new Error("OKX invalid price");
  return { name: "OKX", rate: null, usdRate: price, error: null };
}

async function fetchBybit(): Promise<ExchangeResult> {
  // Bybit v5 public market API
  // Price type: spot last price for USDTUSD
  const res = await fetchWithTimeout(
    "https://api.bybit.com/v5/market/tickers?category=spot&symbol=USDTUSD",
  );
  if (!res.ok) throw new Error(`Bybit HTTP ${res.status}`);
  const data = await res.json();
  if (data.retCode !== 0 || !data.result?.list?.[0]) {
    throw new Error("Bybit invalid response");
  }
  const price = parseFloat(data.result.list[0].lastPrice);
  if (!isFinite(price) || price <= 0) throw new Error("Bybit invalid price");
  return { name: "Bybit", rate: null, usdRate: price, error: null };
}

// -----------------------------------------------------------------------------
// CoinGecko — aggregate USDT prices for USD/INR cross rate
// -----------------------------------------------------------------------------

async function fetchCrossRate(): Promise<number | null> {
  // CoinGecko keyless public API (no auth, CORS-enabled)
  // Returns aggregate USDT/USD and USDT/INR
  // Cross rate = USDT_INR / USDT_USD
  try {
    const res = await fetchWithTimeout(
      "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd,inr",
      undefined,
      10000,
    );
    if (!res.ok) return null;
    const data = await res.json();
    const usd = data?.tether?.usd;
    const inr = data?.tether?.inr;
    if (!usd || !inr || usd <= 0) return null;
    return inr / usd;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return CORS.preflight();
  }
  if (req.method !== "GET") return CORS.error("Method not allowed", 405);

  try {
    // Read authoritative XReserve rate from exchange_settings (server-side only)
    let xreserveRate: number | null = null;
    try {
      const supabase = serviceClient();
      const { data: setting } = await supabase
        .from("exchange_settings")
        .select("setting_value")
        .eq("setting_key", "platform_usdt_inr_rate")
        .single();
      if (setting?.setting_value?.rate != null) {
        const parsed = Number(setting.setting_value.rate);
        if (isFinite(parsed) && parsed > 0) {
          xreserveRate = parsed;
        }
      }
    } catch (dbErr) {
      console.warn("market-rates: could not read exchange_settings:", (dbErr as Error).message);
      // Non-fatal — continue without xreserveRate
    }

    // Fetch all sources in parallel
    const [binanceResult, okxResult, bybitResult, crossRate] =
      await Promise.allSettled([
        fetchBinance(),
        fetchOKX(),
        fetchBybit(),
        fetchCrossRate(),
      ]);

    // Extract results with error handling
    const exchanges: ExchangeResult[] = [];

    // Binance
    if (binanceResult.status === "fulfilled") {
      exchanges.push(binanceResult.value);
    } else {
      exchanges.push({
        name: "Binance",
        rate: null,
        usdRate: null,
        error: binanceResult.reason?.message || "Unavailable",
      });
    }

    // OKX
    if (okxResult.status === "fulfilled") {
      exchanges.push(okxResult.value);
    } else {
      exchanges.push({
        name: "OKX",
        rate: null,
        usdRate: null,
        error: okxResult.reason?.message || "Unavailable",
      });
    }

    // Bybit
    if (bybitResult.status === "fulfilled") {
      exchanges.push(bybitResult.value);
    } else {
      exchanges.push({
        name: "Bybit",
        rate: null,
        usdRate: null,
        error: bybitResult.reason?.message || "Unavailable",
      });
    }

    // Cross rate
    const usdInrRate =
      crossRate.status === "fulfilled" ? crossRate.value : null;

    // Calculate per-exchange USDT/INR
    if (usdInrRate && usdInrRate > 0) {
      for (const ex of exchanges) {
        if (ex.usdRate !== null) {
          ex.rate = Math.round(ex.usdRate * usdInrRate * 100) / 100;
        }
      }
    }

    return CORS.json({
      xreserveRate,
      exchanges: exchanges.map((ex) => ({
        name: ex.name,
        rate: ex.rate,
        usdRate: ex.usdRate,
        error: ex.error,
      })),
      usdInrRate: usdInrRate
        ? Math.round(usdInrRate * 100) / 100
        : null,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    console.error("market-rates error:", msg);
    return CORS.error(msg, 500);
  }
});
