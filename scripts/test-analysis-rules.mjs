import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const i18nSrc = readFileSync(path.join(__dirname, "../src/i18n.js"), "utf8");
const analysisSrc = readFileSync(path.join(__dirname, "../src/analysis.js"), "utf8");
const zhTwMessages = JSON.parse(readFileSync(path.join(__dirname, "../_locales/zh_TW/messages.json"), "utf8"));

global.window = global;
global.chrome = {
  i18n: {
    getMessage: (key) => zhTwMessages[key]?.message || key,
    getUILanguage: () => "zh_TW"
  }
};

// eslint-disable-next-line no-eval
eval(i18nSrc);
// eslint-disable-next-line no-eval
eval(analysisSrc);

const analysis = global.CopyTradingLensAnalysis;

console.log("=== RUNNING UNIT TESTS FOR ANALYSIS RULES ===");

// 1. Test Sliced Scalping vs Controlled Martingale vs Destructive Martingale
{
  const scalpSummary = {
    closedTrades: 275,
    avgLossHoldHours: 1.9,
    maxLossHoldHours: 9.2,
    payoffRatio: 0.95,
    expectancy: 11.1,
    winRate: 0.945,
    avgWinHoldHours: 0.2, // sub-minute scalp
    dominantSymbolShare: 0.2
  };
  const scalpOrders = {
    adverseAddRate: 0.56,
    maxLayers: 29,
    addSizeExpansion: true,
    initialOrderMedian: 26.7,
    addOrderMedian: 54.7,
    medianOrderIntervalSec: 5.1,
    orderBurstRate60s: 0.76
  };
  const scalpStrat = analysis.inferStrategy(scalpSummary, scalpOrders);
  assert.ok(scalpStrat.family.includes("分片拆單剝頭皮"), `Expected sliced scalping, got: ${scalpStrat.family}`);
  assert.ok(scalpStrat.labels.includes("分片拆單剝頭皮"), `Expected labelSlicedScalping, got: ${scalpStrat.labels}`);
  console.log("PASS: Sliced Scalping detection");

  const controlledSummary = {
    closedTrades: 100,
    avgLossHoldHours: 2.5,
    maxLossHoldHours: 10.0,
    payoffRatio: 1.1,
    expectancy: 20,
    winRate: 0.85,
    avgWinHoldHours: 5.0,
    dominantSymbolShare: 0.2
  };
  const controlledOrders = {
    adverseAddRate: 0.40,
    maxLayers: 5,
    addSizeExpansion: true,
    initialOrderMedian: 100,
    addOrderMedian: 200,
    medianOrderIntervalSec: 3600,
    orderBurstRate60s: 0.05
  };
  const controlledStrat = analysis.inferStrategy(controlledSummary, controlledOrders);
  assert.ok(controlledStrat.family.includes("受控馬丁"), `Expected controlled martingale, got: ${controlledStrat.family}`);
  assert.ok(controlledStrat.labels.includes("受控快速止損馬丁"), `Expected labelControlledMartingale, got: ${controlledStrat.labels}`);
  console.log("PASS: Controlled Martingale detection");
}

// 2. Test Extreme Dead-loss Hard Veto (>= 300h)
{
  const meta = { days: 60, mdd: 10, pnl: 500, copierPnl: 10000, aum: 50000, marginBalance: 5000 };
  const summary = { closedTrades: 50, winRate: 0.90, payoffRatio: 0.8, expectancy: 10, maxLossHoldHours: 350, avgLossHoldHours: 40, avgWinHoldHours: 10 };
  const orders = { adverseAddRate: 0.10, openOrders: 50, initialOrderMedian: 100 };
  const transfers = { lossPeriodDepositCount: 0 };
  const live = { openUnrealizedLossToMargin: 0, openUnrealizedLoss: 0 };
  
  const verdict = analysis.buildVerdict(meta, summary, orders, transfers, live);
  assert.equal(verdict.level, "avoid", `Expected avoid for extreme dead-loss >= 300h, got ${verdict.level}`);
  assert.ok(verdict.alerts.some(a => a.includes("歷史死扛虧損")), "Expected dead loss alert in alerts");
  console.log("PASS: Extreme dead-loss hard veto (>= 300h)");
}

// 3. Test Severe Dead-loss Gate (>= 150h capped at risky)
{
  const meta = { days: 60, mdd: 10, pnl: 500, copierPnl: 60000, aum: 50000, marginBalance: 5000 };
  const summary = { closedTrades: 50, winRate: 0.90, payoffRatio: 1.2, expectancy: 10, maxLossHoldHours: 180, avgLossHoldHours: 20, avgWinHoldHours: 10 };
  const orders = { adverseAddRate: 0.10, openOrders: 50, initialOrderMedian: 100 };
  const transfers = { lossPeriodDepositCount: 0 };
  const live = { openUnrealizedLossToMargin: 0, openUnrealizedLoss: 0 };
  
  const verdict = analysis.buildVerdict(meta, summary, orders, transfers, live);
  assert.equal(verdict.level, "risky", `Expected risky for severe dead-loss >= 150h, got ${verdict.level}`);
  console.log("PASS: Severe dead-loss gate (>= 150h)");
}

// 4. Test Stagnant Momentum Flatline Detection
{
  const meta = {
    days: 120,
    mdd: 10,
    pnl: 5000,
    copierPnl: 10000,
    aum: 50000,
    marginBalance: 5000,
    performanceWindows: {
      "30D": { roi: 0.8 },
      "90D": { roi: 5.0 }
    }
  };
  const summary = { closedTrades: 15, winRate: 0.85, payoffRatio: 1.0, expectancy: 50, maxLossHoldHours: 20, avgLossHoldHours: 5, avgWinHoldHours: 10 };
  const orders = { adverseAddRate: 0.05, openOrders: 15, initialOrderMedian: 100 };
  const transfers = { lossPeriodDepositCount: 0 };
  const live = { openUnrealizedLossToMargin: 0, openUnrealizedLoss: 0 };
  
  const verdict = analysis.buildVerdict(meta, summary, orders, transfers, live);
  assert.equal(verdict.level, "watch", `Expected watch for stagnant flatline, got ${verdict.level}`);
  assert.equal(verdict.momentumStatus, "stagnant", `Expected stagnant momentumStatus, got ${verdict.momentumStatus}`);
  console.log("PASS: Stagnant momentum flatline detection");
}

// 5. Test High Initial Leverage Risk
{
  const meta = { days: 40, mdd: 15, pnl: 500, copierPnl: 5000, aum: 1000, marginBalance: 500 };
  const summary = { closedTrades: 40, winRate: 0.80, payoffRatio: 0.5, expectancy: 10, maxLossHoldHours: 30, avgLossHoldHours: 5, avgWinHoldHours: 10 };
  const orders = { adverseAddRate: 0.35, openOrders: 100, initialOrderMedian: 8000 }; // 16x initial leverage!
  const transfers = { lossPeriodDepositCount: 0 };
  const live = { openUnrealizedLossToMargin: 0, openUnrealizedLoss: 0 };
  
  const verdict = analysis.buildVerdict(meta, summary, orders, transfers, live);
  assert.equal(verdict.level, "risky", `Expected risky for high initial leverage, got ${verdict.level}`);
  assert.ok(verdict.cautions.some(c => c.includes("初始開倉名義槓桿高達")), "Expected high initial leverage caution");
  console.log("PASS: High initial leverage risk detection");
}

// 6. Test Active Momentum Status
{
  const meta = {
    days: 60,
    mdd: 12,
    pnl: 5000,
    copierPnl: 30000,
    aum: 100000,
    marginBalance: 10000,
    performanceWindows: {
      "30D": { roi: 45.0 }
    }
  };
  const summary = { closedTrades: 80, winRate: 0.70, payoffRatio: 1.5, expectancy: 50, maxLossHoldHours: 20, avgLossHoldHours: 5, avgWinHoldHours: 10 };
  const orders = { adverseAddRate: 0.05, openOrders: 80, initialOrderMedian: 1000 };
  const transfers = { lossPeriodDepositCount: 0 };
  const live = { openUnrealizedLossToMargin: 0, openUnrealizedLoss: 0 };
  
  const verdict = analysis.buildVerdict(meta, summary, orders, transfers, live);
  assert.equal(verdict.momentumStatus, "active", `Expected active momentumStatus, got ${verdict.momentumStatus}`);
  console.log("PASS: Active momentum status detection");
}

// 7. Positions that closed before this lead portfolio started must not enter
//    the behaviour statistics. Reproduces portfolio 5108371059752839168,
//    which showed a 102.3-day dead loss on a portfolio only 59 days
//    old: the losing position opened 2026-03-03 and closed 2026-06-13, while
//    the portfolio started 2026-06-26.
{
  const start = Date.UTC(2026, 5, 26, 2, 30);
  const hour = 3600 * 1000;
  const day = 24 * hour;
  const raw = {
    id: "5108371059752839168",
    detail: { startTime: start, nickname: "pre-round contamination", marginBalance: "100000" },
    positionHistory: [
      // Pre-round disaster: opened ~115 days before the portfolio, closed 13
      // days before it started.
      { symbol: "RIVERUSDT", side: "Long", opened: start - 115 * day, closed: start - 13 * day, closingPnl: "-352318.3", maxOpenInterest: 10, closedVolume: 10, avgCost: 100, avgClosePrice: 60, leverage: "10" },
      // Straddler: opened before the start, closed 2 days into the round —
      // the copier only held it for those 2 days.
      { symbol: "ETHUSDT", side: "Long", opened: start - 30 * day, closed: start + 2 * day, closingPnl: "-1000", maxOpenInterest: 5, closedVolume: 5, avgCost: 100, avgClosePrice: 95, leverage: "5" },
      // Clean in-round trades.
      { symbol: "SKHYNIXUSDT", side: "Long", opened: start + 5 * day, closed: start + 5 * day + 6 * hour, closingPnl: "2000", maxOpenInterest: 5, closedVolume: 5, avgCost: 100, avgClosePrice: 110, leverage: "5" },
      { symbol: "MUUSDT", side: "Short", opened: start + 9 * day, closed: start + 9 * day + 3 * hour, closingPnl: "600", maxOpenInterest: 5, closedVolume: 5, avgCost: 100, avgClosePrice: 95, leverage: "5" }
    ],
    orderHistory: [],
    transferHistory: [],
    livePositions: [],
    performanceWindows: {},
    historyStatus: {}
  };

  const result = analysis.analyzeBinance(raw);
  assert.equal(result.summary.closedTrades, 3, "pre-round position must be excluded from the sample");
  assert.equal(result.summary.preRoundPositionsExcluded, 1, "the exclusion must be reported, not silent");
  assert.equal(result.rawCounts.positionHistoryPreRound, 1, "raw counts must show what was dropped");
  assert.ok(
    Math.abs(result.summary.maxLossHoldHours - 48) < 1e-6,
    `dead-loss clock must start at the portfolio start (expected 48h, got ${result.summary.maxLossHoldHours})`
  );
  assert.equal(result.summary.holdClampedToRoundStart, 1, "the straddling position's clock must be reported as clamped");
  assert.ok(result.summary.avgLoss > -352318, "the pre-round disaster must not set the average loss");
  console.log("PASS: pre-round position history excluded from behaviour stats");

  // No start time (or OKX) means no filtering — the guard must not silently
  // eat history when the portfolio start is unknown.
  const noStart = analysis.analyzeBinance({ ...raw, detail: { ...raw.detail, startTime: 0 } });
  assert.equal(noStart.summary.closedTrades, 4, "without a start time nothing may be dropped");
  assert.equal(noStart.summary.preRoundPositionsExcluded, 0, "nothing excluded when the round start is unknown");
  console.log("PASS: unknown portfolio start disables the filter instead of dropping data");
}

// 8. Grid means layered RESTING orders. Reproduces two real portfolios as
//    analysed on 2026-09-13, with every field the classifier read at the time
//    (including the retired isEquidistantLadder flag, which was true for both).
//    - 5159399805711344897 was labelled Grid. 99% of its entries
//      are MARKET clips fired seconds apart with hand-picked sizes (8.888,
//      58.888), losers held up to 464h: many "layers" a few bps apart that are
//      one decision sliced up, not a lattice.
//    - 5194131644237409792 was taken for a grid: every
//      entry a resting LIMIT order, each closed a few dozen bps later.
{
  const grid = "網格";
  const slicer = analysis.inferStrategy(
    { closedTrades: 85, winRate: 0.7647, payoffRatio: 1.0482, expectancy: 6329.9, avgWinHoldHours: 31.54, avgLossHoldHours: 132.61, maxLossHoldHours: 464.38, tpMedianBps: 162.32, dominantSymbolShare: 0.2353 },
    { openOrders: 587, closeOrders: 171, adverseAdds: 270, adverseAddRate: 0.46, maxLayers: 31, initialOrderMedian: 93229.6, addOrderMedian: 51976.2, addSizeExpansion: false, medianOrderIntervalSec: 107.85, orderBurstRate60s: 0.428, adverseStepMedianBps: 19.67, adverseStepCv: 1.80, isEquidistantLadder: true, restingEntryShare: 0.0119, dominantSymbolShare: 0.2718 }
  );
  assert.ok(!slicer.labels.includes(grid), `market-clip slicer must not be Grid, got: ${slicer.family}`);
  console.log("PASS: market-order clip slicing is not a grid");

  const ladder = analysis.inferStrategy(
    { closedTrades: 167, winRate: 1, payoffRatio: null, expectancy: 257.86, avgWinHoldHours: 3.67, avgLossHoldHours: 0, maxLossHoldHours: 0, tpMedianBps: 37.72, dominantSymbolShare: 0.3593 },
    { openOrders: 235, closeOrders: 172, adverseAdds: 69, adverseAddRate: 0.2936, maxLayers: 12, initialOrderMedian: 58737.2, addOrderMedian: 24495.2, addSizeExpansion: false, medianOrderIntervalSec: 900.99, orderBurstRate60s: 0.209, adverseStepMedianBps: 82.54, adverseStepCv: 0.83, isEquidistantLadder: true, restingEntryShare: 1, dominantSymbolShare: 0.3661 }
  );
  assert.ok(ladder.labels.includes(grid), `resting-order ladder must stay Grid, got: ${ladder.family}`);
  console.log("PASS: resting-order ladder stays a grid");

  // The share is read off the order type the exchange reports; a feed without
  // order types must yield "unknown", never "all resting" or "none resting".
  const ordersOf = (orderHistory) => analysis.analyzeBinance({
    id: "resting-share", detail: {}, positionHistory: [], orderHistory, transferHistory: [], livePositions: [], performanceWindows: {}, historyStatus: {}
  }).orders;
  const orders = ordersOf([
    { symbol: "ETHUSDT", side: "BUY", positionSide: "LONG", type: "LIMIT", executedQty: 1, avgPrice: 100, totalPnl: 0, orderTime: 1 },
    { symbol: "ETHUSDT", side: "BUY", positionSide: "LONG", type: "LIMIT", executedQty: 1, avgPrice: 99, totalPnl: 0, orderTime: 2 },
    { symbol: "ETHUSDT", side: "BUY", positionSide: "LONG", type: "MARKET", executedQty: 1, avgPrice: 98, totalPnl: 0, orderTime: 3 },
    { symbol: "ETHUSDT", side: "SELL", positionSide: "LONG", type: "MARKET", executedQty: 3, avgPrice: 101, totalPnl: 6, orderTime: 4 }
  ]);
  assert.ok(Math.abs(orders.restingEntryShare - 2 / 3) < 1e-9, `closing orders must not enter the entry share, got ${orders.restingEntryShare}`);
  const untyped = ordersOf([
    { symbol: "ETHUSDT", side: "BUY", positionSide: "LONG", executedQty: 1, avgPrice: 100, totalPnl: 0, orderTime: 1 }
  ]);
  assert.equal(untyped.restingEntryShare, null, "no order type in the feed means the share is unknown");
  console.log("PASS: resting entry share counts entries only and reports unknown when untyped");
}

console.log("\nALL ANALYSIS UNIT TESTS PASSED SUCCESSFULLY!");
