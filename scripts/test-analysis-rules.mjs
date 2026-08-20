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

console.log("\nALL ANALYSIS UNIT TESTS PASSED SUCCESSFULLY!");
