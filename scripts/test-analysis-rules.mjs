import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const load = (file) => readFileSync(path.join(__dirname, "../src", file), "utf8");
const zhTwMessages = JSON.parse(readFileSync(path.join(__dirname, "../_locales/zh_TW/messages.json"), "utf8"));

global.window = global;
global.chrome = {
  i18n: {
    getMessage: (key) => zhTwMessages[key]?.message || key,
    getUILanguage: () => "zh_TW"
  }
};

// Same load order as manifest.json: analysis.js reads styles decided by
// style.js, which rebuilds positions through positions.js.
for (const file of ["i18n.js", "positions.js", "style.js", "analysis.js"]) {
  // eslint-disable-next-line no-eval
  eval(load(file));
}

const analysis = global.CopyTradingLensAnalysis;

console.log("=== RUNNING UNIT TESTS FOR ANALYSIS RULES ===");

// 1. The strategy shown is the style decided from the fills (src/style.js),
//    rendered in the page language, plus facts read off closed positions.
{
  const hour = 3600 * 1000;
  const orderHistory = [];
  let time = Date.UTC(2026, 6, 1);
  for (let episode = 0; episode < 12; episode += 1) {
    for (let add = 0; add < 4; add += 1) {
      time += 3 * hour;
      orderHistory.push({ symbol: "SOLUSDT", side: "BUY", positionSide: "LONG", executedQty: 10, avgPrice: 80 * (1 - 0.02 * add), totalPnl: 0, orderTime: time, type: "LIMIT" });
    }
    time += 6 * hour;
    orderHistory.push({ symbol: "SOLUSDT", side: "SELL", positionSide: "LONG", executedQty: 40, avgPrice: 80 * 1.01, totalPnl: 60, orderTime: time, type: "LIMIT" });
  }
  const result = analysis.analyzeBinance({
    id: "style-render", detail: {}, positionHistory: [], orderHistory, transferHistory: [], livePositions: [], performanceWindows: {},
    historyStatus: { positionHistory: { complete: true }, orderHistory: { complete: true }, transferHistory: { complete: true } }
  });
  assert.equal(result.strategy.style, "dcaNoStop");
  assert.equal(result.strategy.family, zhTwMessages.familyDcaNoStop.message);
  assert.ok(result.strategy.labels.includes(zhTwMessages.labelNeverRealisedLoss.message), `labels: ${result.strategy.labels}`);
  assert.equal(result.orders.openOrders, 48, "entries come from the shared position replay");
  assert.equal(result.orders.closeOrders, 12);
  console.log("PASS: strategy renders the fill-based style");
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

console.log("\nALL ANALYSIS UNIT TESTS PASSED SUCCESSFULLY!");
