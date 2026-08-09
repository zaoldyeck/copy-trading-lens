// Turns a batch of analyzeBinance() results into a flat summary row and a
// markdown table. Text fields (verdict title/cautions, strategy family) are
// expected to already be human-readable — i.e. produced by a runtime created
// with a locale dict (see runtime.mjs) — this module does no translation of
// its own.

/**
 * @param {{rank: number, row: object}} rankEntry - from ranking.mjs (row has leadPortfolioId, roi, etc.)
 * @param {object} result - analyzeBinance() return value
 */
export function summarizeResult(rankEntry, result) {
  const meta = result.meta;
  const summary = result.summary;
  const orders = result.orders;
  const transfers = result.transfers;
  const live = result.live;
  const verdict = result.verdict;
  const strategy = result.strategy;
  return {
    rank: rankEntry?.rank ?? null,
    pid: meta.id,
    name: meta.name,
    rankRoi30D: rankEntry?.row?.roi ?? null,
    roi30D: meta.performanceWindows?.["30D"]?.roi ?? null,
    days: meta.days,
    roi: meta.roi,
    annualizedReturn: meta.annualizedReturn,
    annualizedSource: meta.annualizedSource,
    mdd: meta.mdd,
    pnl: meta.pnl,
    aum: meta.aum,
    copierPnl: meta.copierPnl,
    profitSharingRate: meta.profitSharingRate,
    closedTrades: summary.closedTrades,
    winCount: summary.winCount,
    lossCount: summary.lossCount,
    winRate: summary.winRate,
    avgWin: summary.avgWin,
    avgLoss: summary.avgLoss,
    payoffRatio: summary.payoffRatio,
    expectancy: summary.expectancy,
    avgLossHoldHours: summary.avgLossHoldHours,
    maxLossHoldHours: summary.maxLossHoldHours,
    dominantSymbol: summary.dominantSymbol,
    dominantSymbolShare: summary.dominantSymbolShare,
    adverseAddRate: orders.adverseAddRate,
    maxLayers: orders.maxLayers,
    adverseStepMedianBps: orders.adverseStepMedianBps,
    lossPeriodDepositCount: transfers.lossPeriodDepositCount,
    lossPeriodDepositTotal: transfers.lossPeriodDepositTotal,
    openUnrealizedLoss: live.openUnrealizedLoss,
    openUnrealizedLossToMargin: live.openUnrealizedLossToMargin,
    openCount: live.openCount,
    family: strategy.family,
    labels: strategy.labels,
    verdictLevel: verdict.level,
    verdictTitle: verdict.title,
    positives: verdict.positives,
    cautions: verdict.cautions,
    evidence: verdict.evidence,
    reliable: meta.allPeriodPerformance?.reliable,
    preStartHistoryDays: meta.allPeriodPerformance?.preStartHistoryDays,
    closeLeadCount: meta.closeLeadCount,
    currentCopyCount: meta.currentCopyCount,
    maxCopyCount: meta.maxCopyCount
  };
}

const VERDICT_ORDER = ["preferred", "followable", "watch", "risky", "avoid"];

function fmtPct(v, digits = 1) {
  return Number.isFinite(v) ? `${v.toFixed(digits)}%` : "N/A";
}
function fmtMoney(v) {
  return Number.isFinite(v) ? `${Math.round(v).toLocaleString()} USDT` : "N/A";
}
function fmtRatio(v) {
  return v === null || v === undefined || !Number.isFinite(v) ? "N/A" : v.toFixed(2);
}
// Annualizing a short window compounds it to nonsense — a 12-day account up
// 2242% extrapolates to ~1e42%, which Number#toFixed renders in scientific
// notation and makes the table unreadable. Past ~1000x the figure carries no
// information beyond "the extrapolation broke", so say that instead of
// printing the digits. The neighbouring 30-day-ROI column is what's actually
// readable for these accounts (see the report's methodology section).
const ANNUALIZED_ABSURD_PCT = 100000;
function fmtAnnualized(v) {
  if (!Number.isFinite(v)) return "N/A";
  if (Math.abs(v) >= ANNUALIZED_ABSURD_PCT) return "外推失真（天數過短）";
  return `${v.toFixed(0)}%`;
}
function escapeCell(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * @param {ReturnType<typeof summarizeResult>[]} summaries
 * @param {{sortBy?: 'rank'|'verdict', binanceLinkPrefix?: string}} [opts]
 */
export function toMarkdownTable(summaries, opts = {}) {
  const { sortBy = "rank" } = opts;
  const sorted = [...summaries].sort((a, b) => {
    if (sortBy === "verdict") {
      const diff = VERDICT_ORDER.indexOf(a.verdictLevel) - VERDICT_ORDER.indexOf(b.verdictLevel);
      if (diff !== 0) return diff;
    }
    return (a.rank ?? 0) - (b.rank ?? 0);
  });

  const header = "| 排名 | 交易員 | 天數 | 年化(CAGR/XIRR) | 近30天ROI | MDD | 勝率 | 盈虧比 | 逆勢加倉 | 虧損期入金 | 策略型態 | 判定 |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = sorted.map((s) => {
    const link = `[${escapeCell(s.name)}](https://www.binance.com/zh-TC/copy-trading/lead-details/${s.pid}?timeRange=30D)`;
    const deposit = s.lossPeriodDepositCount > 0 ? `${s.lossPeriodDepositCount} 次 / ${fmtMoney(s.lossPeriodDepositTotal)}` : "無";
    const adverseAdd = Number.isFinite(s.adverseAddRate) ? `${fmtPct(s.adverseAddRate * 100)}（${s.maxLayers}層）` : "N/A";
    return `| ${s.rank ?? ""} | ${link} | ${Math.round(s.days)} | ${fmtAnnualized(s.annualizedReturn)} | ${fmtPct(s.roi30D)} | ${fmtPct(s.mdd)} | ${fmtPct((s.winRate ?? 0) * 100)} | ${fmtRatio(s.payoffRatio)} | ${adverseAdd} | ${deposit} | ${escapeCell(s.family)} | ${escapeCell(s.verdictTitle)} |`;
  });
  return [header, sep, ...rows].join("\n");
}

export { fmtPct, fmtMoney, fmtRatio, fmtAnnualized, VERDICT_ORDER };
