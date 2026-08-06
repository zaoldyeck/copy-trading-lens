// Fetch one lead trader's full history through the shared runtime, with
// disk caching. This is the single call site CLI commands should use instead
// of hand-rolling pagination — providers.js already handles retry/backoff
// and the order-history depth-limit correctly (see providers.js history).
import { hasCachedRaw, readCachedRaw, writeCachedRaw } from "./cache.mjs";

/**
 * @param {ReturnType<typeof import('./runtime.mjs').createRuntime>} runtime
 * @param {{platform: 'Binance'|'OKX', id: string}} context
 * @param {{baseDir: string, force?: boolean}} opts
 */
export async function fetchTrader(runtime, context, { baseDir, force = false }) {
  if (!force && hasCachedRaw(baseDir, context.id)) {
    return { raw: readCachedRaw(baseDir, context.id), cached: true };
  }
  runtime.sandbox.location.href = context.platform === "Binance"
    ? `https://www.binance.com/zh-TC/copy-trading/lead-details/${context.id}?timeRange=30D`
    : `https://www.okx.com/copy-trading/account/${context.id}`;
  const raw = await runtime.providers.fetchLeadData(context);
  writeCachedRaw(baseDir, context.id, raw);
  return { raw, cached: false };
}

/**
 * Fetch + analyze in one call, using the trader's own detected platform.
 */
export async function fetchAndAnalyze(runtime, context, opts) {
  const { raw } = await fetchTrader(runtime, context, opts);
  const result = context.platform === "Binance"
    ? runtime.analysis.analyzeBinance(raw)
    : runtime.analysis.analyzeOkx(raw);
  return { raw, result };
}
