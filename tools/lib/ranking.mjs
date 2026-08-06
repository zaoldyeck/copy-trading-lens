// Binance copy-trade ranking list (/home-page/query-list), for discovering
// candidates rather than looking up one already-known trader (that's
// providers.js's fetchBinanceListItem, used internally for performance
// windows). Thin by design: the endpoint here needs no deep pagination or
// depth-limit handling, so there's no hard-won retry logic to duplicate —
// see runtime.mjs's header comment for what *does* have to stay singular.
const DEFAULT_SMART_FILTER = {
  portfolioType: "ALL",
  useAiRecommended: true,
  apiKeyOnly: false,
  lockPeriod: null
};

/**
 * @param {ReturnType<typeof import('./runtime.mjs').createRuntime>} runtime
 * @param {{timeRange?: string, pageSize?: number, minDaysTrading?: number, extraParams?: object}} [opts]
 * @returns {AsyncGenerator<{rank: number, row: object}>} yields rows in ranked order, page by page
 */
export async function* iterateRanking(runtime, opts = {}) {
  const {
    timeRange = "30D",
    pageSize = 20,
    minDaysTrading = null,
    extraParams = {}
  } = opts;
  const params = {
    ...DEFAULT_SMART_FILTER,
    ...(minDaysTrading !== null ? { daysTrading: minDaysTrading } : {}),
    pageSize,
    ...extraParams
  };
  let page = 1;
  let rank = 0;
  while (true) {
    const { rows } = await runtime.providers.fetchBinanceListPage(timeRange, page, "", params);
    if (!rows.length) return;
    for (const row of rows) {
      rank += 1;
      yield { rank, row };
    }
    if (rows.length < pageSize) return;
    page += 1;
  }
}

/**
 * Collect every ranked entry strictly above targetPortfolioId (i.e. better
 * ranked). Returns [] with `found: false` if the target never appears —
 * callers should treat that as "check the target's own filters/timeRange",
 * not silently treat it as "target is rank 1".
 */
export async function rankedAbove(runtime, targetPortfolioId, opts = {}) {
  const above = [];
  for await (const { rank, row } of iterateRanking(runtime, opts)) {
    if (String(row.leadPortfolioId) === String(targetPortfolioId)) {
      return { found: true, targetRank: rank, above };
    }
    above.push({ rank, ...row });
  }
  return { found: false, targetRank: null, above };
}
