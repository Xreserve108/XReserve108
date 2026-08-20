import { getMarketRates } from '@/data/market-data';

/**
 * Platform rate module — single access point for the authoritative
 * XReserve USDT/INR rate.
 *
 * Production path (one source of truth):
 *   exchange_settings.platform_usdt_inr_rate
 *     → market-rates Edge Function (server-side read)
 *     → xreserveRate
 *     → this module
 *
 * Development fallback:
 *   When the market-rates Edge Function is not deployed (local dev),
 *   no secure client read path to exchange_settings exists, so this
 *   module falls back to DEV_FALLBACK_RATE — the same value the app
 *   has historically used for pricing in that environment. Once the
 *   Edge Function is deployed, the fallback is never reached.
 *
 * The rate is only ever WRITTEN through the admin_update_exchange_rate
 * RPC (admin + admin_settings 2FA). This module is read-only.
 */

export const DEV_FALLBACK_RATE = 92.15;

/**
 * Get the current XReserve platform rate.
 *
 * @returns {Promise<{rate: number, authoritative: boolean}>}
 *   rate          — the rate to display/use
 *   authoritative — true when read from exchange_settings via the
 *                   Edge Function, false when dev fallback is in use
 */
export async function getPlatformRate() {
  try {
    const data = await getMarketRates();
    if (data && typeof data.xreserveRate === 'number' && isFinite(data.xreserveRate) && data.xreserveRate > 0) {
      return { rate: data.xreserveRate, authoritative: true };
    }
  } catch (err) {
    console.warn('platform-rate: authoritative rate unavailable:', err?.message);
  }
  return { rate: DEV_FALLBACK_RATE, authoritative: false };
}
