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
for (const file of ["i18n.js", "positions.js", "style.js", "equity.js", "analysis.js"]) {
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
      orderHistory.push({ symbol: "SOLUSDT", side: "BUY", positionSide: "LONG", executedQty: 10, avgPrice: 80 * (1 - 0.02 * add), totalPnl: 0, orderTime: time, orderUpdateTime: time, type: "LIMIT" });
    }
    time += 6 * hour;
    orderHistory.push({ symbol: "SOLUSDT", side: "SELL", positionSide: "LONG", executedQty: 40, avgPrice: 80 * 1.01, totalPnl: 60, orderTime: time, orderUpdateTime: time, type: "LIMIT" });
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
  assert.ok(result.strategy.labels.some((label) => /^風格依最近 \d+ 天的成交判斷$/.test(label)), `labels: ${result.strategy.labels}`);
  assert.ok(!result.strategy.labels.some((label) => label.includes("平均停利幅度")), "an averaging family does not repeat the averaging share");
  console.log("PASS: strategy renders the fill-based style");
}

// 2. Test Extreme Dead-loss Hard Veto (>= 300h)
{
  const meta = { days: 60, mdd: 10, pnl: 500, copierPnl: 10000, aum: 50000, marginBalance: 5000 };
  const summary = { closedTrades: 50, winRate: 0.90, payoffRatio: 0.8, expectancy: 10, maxLossHoldHours: 350, lossHoldEvents: [{ hours: 350, endedAt: Date.UTC(2026, 7, 1) }], avgLossHoldHours: 40, avgWinHoldHours: 10, comparableHoldHours: { win: 10, loss: 40 } };
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
  const summary = { closedTrades: 50, winRate: 0.90, payoffRatio: 1.2, expectancy: 10, maxLossHoldHours: 180, lossHoldEvents: [{ hours: 180, endedAt: Date.UTC(2026, 7, 1) }], avgLossHoldHours: 20, avgWinHoldHours: 10, comparableHoldHours: { win: 10, loss: 20 } };
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
  const summary = { closedTrades: 15, winRate: 0.85, payoffRatio: 1.0, expectancy: 50, maxLossHoldHours: 20, avgLossHoldHours: 5, avgWinHoldHours: 10, comparableHoldHours: { win: 10, loss: 5 } };
  const orders = { adverseAddRate: 0.05, openOrders: 15, initialOrderMedian: 100 };
  const transfers = { lossPeriodDepositCount: 0 };
  const live = { openUnrealizedLossToMargin: 0, openUnrealizedLoss: 0 };
  
  const verdict = analysis.buildVerdict(meta, summary, orders, transfers, live);
  assert.equal(verdict.level, "watch", `Expected watch for stagnant flatline, got ${verdict.level}`);
  assert.equal(verdict.momentumStatus, "stagnant", `Expected stagnant momentumStatus, got ${verdict.momentumStatus}`);
  console.log("PASS: Stagnant momentum flatline detection");
}

// 5. A large opening order is not graded against today's balance. That gate
//    fired on 1 of 225 backtested traders (2026-09-14) and paired a past size
//    with a present account; the size is read by the biggest bet instead.
{
  const meta = { days: 40, mdd: 15, pnl: 500, copierPnl: 5000, aum: 1000, marginBalance: 500 };
  const summary = { closedTrades: 40, winRate: 0.80, payoffRatio: 0.5, expectancy: 10, maxLossHoldHours: 30, avgLossHoldHours: 5, avgWinHoldHours: 10, comparableHoldHours: { win: 10, loss: 5 } };
  const orders = { adverseAddRate: 0.30, openOrders: 100, initialOrderMedian: 8000 };
  const transfers = { lossPeriodDepositCount: 0 };
  const live = { openUnrealizedLossToMargin: 0, openUnrealizedLoss: 0 };

  const verdict = analysis.buildVerdict(meta, summary, orders, transfers, live);
  assert.ok(!verdict.cautions.some((caution) => caution.includes("初始開倉") || caution.includes("InitialLeverage")), `cautions: ${verdict.cautions}`);
  assert.equal(zhTwMessages.cautionHighInitialLeverage, undefined);
  console.log("PASS: no opening-size gate against today's balance");
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
  const summary = { closedTrades: 80, winRate: 0.70, payoffRatio: 1.5, expectancy: 50, maxLossHoldHours: 20, avgLossHoldHours: 5, avgWinHoldHours: 10, comparableHoldHours: { win: 10, loss: 5 } };
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

// 8. A partially closed position is not a closed position (Binance's own
//    definition: "If the order is partially closed, it doesn't count as a
//    closed position"). Its row carries closed: null, an updateTime at the
//    latest partial close, and realized-so-far pnl. Counting it as a closed
//    trade put still-open positions into win rate, payoff and sample size.
{
  const start = Date.UTC(2026, 5, 26, 2, 30);
  const hour = 3600 * 1000;
  const day = 24 * hour;
  const closedWin = (symbol, openedDay) => ({ symbol, side: "Long", opened: start + openedDay * day, closed: start + openedDay * day + 6 * hour, updateTime: start + openedDay * day + 6 * hour, status: "All Closed", closingPnl: "500", maxOpenInterest: 5, closedVolume: 5, avgCost: 100, avgClosePrice: 110, leverage: "5" });
  const raw = {
    id: "partial-close",
    detail: { startTime: start, nickname: "partially closed rows", marginBalance: "100000" },
    positionHistory: [
      closedWin("SKHYNIXUSDT", 1),
      closedWin("MUUSDT", 3),
      // Still open, realized a profit on a partial close.
      { symbol: "CLUSDT", side: "Long", opened: start + 2 * day, closed: null, updateTime: start + 20 * day, status: "Partially Closed", closingPnl: "9000", maxOpenInterest: 50, closedVolume: 20, avgCost: 70, avgClosePrice: 80, leverage: "5" },
      // Still open, realized a loss on a partial close 400 hours in.
      { symbol: "BTCUSDT", side: "Short", opened: start + 4 * day, closed: null, updateTime: start + 4 * day + 400 * hour, status: "Partially Closed", closingPnl: "-300", maxOpenInterest: 1, closedVolume: 0.2, avgCost: 60000, avgClosePrice: 63000, leverage: "5" }
    ],
    orderHistory: [],
    transferHistory: [],
    livePositions: [],
    performanceWindows: {},
    historyStatus: {}
  };
  // The raw fixture leaves the fetch status empty, which withholds the verdict,
  // so the verdict rules are applied to the computed statistics directly.
  const verdictOf = (result) => analysis.buildVerdict(result.meta, result.summary, result.orders, result.transfers, result.live);
  const result = analysis.analyzeBinance(raw);
  const { summary } = result;
  const verdict = verdictOf(result);
  assert.equal(summary.closedTrades, 2, "only the two fully closed positions are closed trades");
  assert.equal(summary.openPositionsExcluded, 2, "the partially closed rows are reported, not silently dropped");
  assert.equal(summary.winRate, 1, "win rate is read from closed positions only");
  assert.equal(summary.lossCount, 0, "a partial close at a loss is not a losing trade");
  assert.ok(Math.abs(summary.maxLossHoldHours - 400) < 1e-6, `a still-open position underwater until its partial close still counts as a held loss (got ${summary.maxLossHoldHours})`);
  assert.ok(verdict.cautions.includes(zhTwMessages.cautionThinClosedTrades.message.replace("{0}", "2")), "the thin sample caution uses the closed count");

  const noneClosed = analysis.analyzeBinance({ ...raw, positionHistory: raw.positionHistory.slice(2) });
  assert.equal(noneClosed.summary.closedTrades, 0);
  assert.ok(verdictOf(noneClosed).cautions.includes(zhTwMessages.cautionNoClosedTrades.message), "no closed position must still be called out");
  console.log("PASS: partially closed positions stay out of closed-trade statistics");
}

// 9. A withheld style names the gate it failed, with the trader's number and
//    the bar. "Too little history" alone was read as a bug on a portfolio with
//    thousands of fills.
{
  const hour = 3600 * 1000;
  const start = Date.UTC(2026, 6, 1);
  // One round trip every `every` hours: buy, sell an hour later.
  const roundTrips = (count, every) => Array.from({ length: count }, (_, k) => [
    { symbol: "BTCUSDT", side: "BUY", positionSide: "LONG", executedQty: 0.01, avgPrice: 60000, totalPnl: 0, orderTime: start + k * every * hour, orderUpdateTime: start + k * every * hour, type: "LIMIT" },
    { symbol: "BTCUSDT", side: "SELL", positionSide: "LONG", executedQty: 0.01, avgPrice: 60300, totalPnl: 3, orderTime: start + (k * every + 1) * hour, orderUpdateTime: start + (k * every + 1) * hour, type: "LIMIT" }
  ]).flat();
  const style = global.CopyTradingLensStyle.classify(roundTrips(10, 2));
  assert.equal(style.family, "insufficient");
  assert.deepEqual([...style.insufficient], ["shortWindow"], "20 fills pass; 10 closed positions in 19 hours do not");
  const strategy = analysis.inferStrategy({ payoffRatio: null, winRate: 1, dominantSymbolShare: 1 }, style);
  assert.equal(strategy.family, zhTwMessages.familyInsufficient.message);
  assert.ok(strategy.labels.includes("成交紀錄只涵蓋 0.7 天、完整倉位 10 個；不滿 7 天時，要涵蓋至少 2 天且至少 16 個完整倉位"), `labels: ${strategy.labels}`);

  // A position trader (portfolio 5108371059752839168, 2026-09-14: 160 fills
  // over 59 days, 4 positions closed, 7 still held) fails on closed positions
  // with a long, complete record, so the reason counts what is still held and
  // the headline does not blame the record.
  assert.ok(!/紀錄/.test(zhTwMessages.familyInsufficient.message), "the headline does not say the record is short");
  const day = 24 * hour;
  const ladder = Array.from({ length: 20 }, (_, k) => ({ symbol: "CLUSDT", side: "BUY", positionSide: "LONG", executedQty: 100, avgPrice: 80 - k * 0.2, totalPnl: 0, orderTime: start + k * day / 2, orderUpdateTime: start + k * day / 2, type: "LIMIT" }));
  const holder = global.CopyTradingLensStyle.classify([...roundTrips(3, 50), ...ladder]);
  assert.deepEqual([...holder.insufficient], ["fewClosedPositions"]);
  const holderStrategy = analysis.inferStrategy({ payoffRatio: null, winRate: 1, dominantSymbolShare: 1 }, holder);
  assert.ok(holderStrategy.labels.includes("紀錄內從開倉到平倉完整看得到的倉位只有 3 個，至少要 5 個；另有 1 個倉位還抱著沒平完"), `labels: ${holderStrategy.labels}`);
  console.log("PASS: a withheld style says which gate it failed");

  // What makes a short record readable is how many positions it shows: a busy
  // trader's few days (Binance serves only the latest ~6,000 fills) are read,
  // as long as they cover two days.
  const Style = global.CopyTradingLensStyle;
  const busy = Style.classify(roundTrips(16, 4));
  assert.ok(busy.evidence.spanDays >= 2 && busy.evidence.spanDays < 7, `2-7 days (got ${busy.evidence.spanDays})`);
  assert.notEqual(busy.family, "insufficient", "16 closed positions over 2.5 days are enough");
  assert.equal(Style.classify(roundTrips(15, 4)).family, "insufficient", "15 are not");
  const burst = Style.classify(roundTrips(40, 1));
  assert.ok(burst.evidence.spanDays < 2 && burst.evidence.closedEpisodes === 40);
  assert.equal(burst.family, "insufficient", "40 positions inside two days are still a burst");
  console.log("PASS: a short window with enough closed positions over two days is read");
}

// 10. The loss-period deposit card dates the latest rescue deposit, not only
//     how many there were.
{
  const day = 24 * 3600 * 1000;
  const start = Date.UTC(2026, 7, 1);
  const losing = { symbol: "ETHUSDT", side: "Long", opened: start, closed: start + 10 * day, closingPnl: "-500", status: "All Closed" };
  const deposit = (offsetDays) => ({ time: start + offsetDays * day, coin: "USDT", amount: 100, transType: "LEAD_DEPOSIT" });
  const result = analysis.analyzeBinance({
    id: "rescue-dates",
    detail: { startTime: start, marginBalance: "10000" },
    positionHistory: [losing],
    orderHistory: [],
    transferHistory: [deposit(2), deposit(7), deposit(12)],
    livePositions: [],
    performanceWindows: {},
    historyStatus: {}
  });
  assert.equal(result.transfers.lossPeriodDepositCount, 2, "the deposit after the loss closed is not a rescue");
  assert.equal(result.transfers.lastLossPeriodDepositAt, start + 7 * day, "the latest rescue, not the latest deposit");
  console.log("PASS: the latest loss-period deposit is dated");
}

// 11. The dead-loss alert dates the latest hold at its bar — not the longest
//     one — and says so when that hold is still open.
{
  const day = 24 * 3600 * 1000;
  const start = Date.UTC(2026, 6, 1);
  const lossRow = (openedDay, closedDay, pnl = "-50") => ({ symbol: "ETHUSDT", side: "Long", opened: start + openedDay * day, closed: start + closedDay * day, closingPnl: pnl, status: "All Closed" });
  const run = (positionHistory) => analysis.analyzeBinance({
    id: "dead-loss-dates",
    detail: { startTime: start, marginBalance: "10000" },
    positionHistory,
    orderHistory: [],
    transferHistory: [],
    livePositions: [],
    performanceWindows: {},
    historyStatus: { positionHistory: { complete: true }, orderHistory: { complete: true }, transferHistory: { complete: true } }
  });
  const closedOnly = run([lossRow(1, 21), lossRow(22, 29), lossRow(34, 35)]);
  assert.equal(closedOnly.summary.maxLossHoldHours, 480);
  assert.ok(
    closedOnly.verdict.alerts.some((alert) => alert.includes(analysis.formatDateTime(start + 29 * day))),
    `the alert carries the end of the latest hold at the bar; alerts: ${closedOnly.verdict.alerts}`
  );
  const expected = zhTwMessages.alertSevereDeadLoss.message
    .replace("{0}", "20.0d")
    .replace("{1}", analysis.formatDateTime(start + 29 * day));
  assert.ok(closedOnly.verdict.alerts.includes(expected), `the 7-day hold ending on day 29 is the latest at the bar, not the 20-day one; alerts: ${closedOnly.verdict.alerts}`);

  const stillOpen = run([
    lossRow(1, 21),
    { symbol: "ETHUSDT", side: "Long", opened: start + 30 * day, closed: null, updateTime: start + 38 * day, closingPnl: "-20", status: "Partially Closed" }
  ]);
  assert.ok(
    stillOpen.verdict.alerts.includes(zhTwMessages.alertSevereDeadLossStillOpen.message.replace("{0}", "20.0d")),
    `a partial close is not the end of the hold; alerts: ${stillOpen.verdict.alerts}`
  );
  console.log("PASS: the dead-loss alert dates the latest hold at its bar");
}

// 12. A hold is timed per unit held. Portfolio 5172137479216744961 bought 6
//     CLUSDT, sold 5.9 ninety seconds later and the last 0.1 eleven days after:
//     the alert read an 11.5-day dead loss on a 0.69 USDT loss. A copier's
//     partial closes follow the lead's by percentage, so it held the same way.
{
  const row = { symbol: "CLUSDT", opened: 1787232044165, closed: 1788227882033, avgCost: 86.56, avgClosePrice: 86.50683333, closingPnl: "-0.68731005", maxOpenInterest: 6, closedVolume: 6, side: "Long", status: "All Closed", updateTime: 1788227882033, leverage: "2" };
  const fill = (side, type, qty, price, pnl, time) => ({ symbol: "CLUSDT", side, type, positionSide: "LONG", executedQty: qty, avgPrice: price, totalPnl: pnl, orderUpdateTime: time, orderTime: time });
  const result = analysis.analyzeBinance({
    id: "5172137479216744961",
    detail: { startTime: 1786241817347, marginBalance: "14310" },
    positionHistory: [row],
    orderHistory: [
      fill("BUY", "MARKET", 6, 86.56, 0, 1787232044164),
      fill("SELL", "MARKET", 5.9, 86.51, -0.295, 1787232134288),
      fill("SELL", "LIMIT", 0.1, 86.32, -0.024, 1788227882033)
    ],
    transferHistory: [],
    livePositions: [],
    performanceWindows: {},
    historyStatus: { positionHistory: { complete: true }, orderHistory: { complete: true }, transferHistory: { complete: true } }
  });
  const expectedHours = (6 * (1787232134288 - 1787232044165) + 0.1 * (1788227882033 - 1787232134288)) / 6 / 3600000;
  assert.ok(Math.abs(result.summary.maxLossHoldHours - expectedHours) < 1e-9, `unit hold ${expectedHours}h, got ${result.summary.maxLossHoldHours}h`);
  assert.ok(!result.verdict.alerts.some((alert) => alert.includes("死扛")), `no dead-loss alert for residue; alerts: ${result.verdict.alerts}`);

  const withoutFills = analysis.analyzeBinance({ ...result, id: "no-fills", detail: { startTime: 1786241817347, marginBalance: "14310" }, positionHistory: [row], orderHistory: [], transferHistory: [], livePositions: [], performanceWindows: {}, historyStatus: { positionHistory: { complete: true }, orderHistory: { complete: true }, transferHistory: { complete: true } } });
  assert.ok(Math.abs(withoutFills.summary.maxLossHoldHours - (row.closed - row.opened) / 3600000) < 1e-9, "without its fills a row keeps the first-entry-to-last-exit clock");
  console.log("PASS: holds are timed per unit held");
}

// 13. The biggest bet is read against the account counted back from today's
//     margin balance, so a history Binance has already trimmed cannot shrink
//     the account and inflate the bet.
{
  const day = 24 * 3600 * 1000;
  const start = Date.UTC(2026, 6, 1);
  const status = { positionHistory: { complete: true }, orderHistory: { complete: true }, transferHistory: { complete: true } };
  const result = analysis.analyzeBinance({
    id: "biggest-bet",
    detail: { startTime: start, marginBalance: "1000" },
    positionHistory: [
      { symbol: "ETHUSDT", side: "Long", opened: start + 1 * day, closed: start + 2 * day, closingPnl: "500", maxOpenInterest: 0.5, avgCost: 2000, status: "All Closed" },
      { symbol: "SOXLUSDT", side: "Short", opened: start + 3 * day, closed: start + 4 * day, closingPnl: "0", maxOpenInterest: 200, avgCost: 100, status: "All Closed" }
    ],
    orderHistory: [],
    transferHistory: [{ time: start, coin: "USDT", amount: 500, transType: "LEAD_INVEST" }],
    livePositions: [],
    performanceWindows: {},
    marketHistory: { nowMs: start + 10 * day, symbols: {} },
    historyStatus: status
  });
  assert.equal(result.biggestBet.symbol, "SOXLUSDT");
  assert.ok(Math.abs(result.biggestBet.account - 1000) < 1e-9, `account ${result.biggestBet.account}`);
  assert.ok(Math.abs(result.biggestBet.leverage - 20) < 1e-9);
  assert.ok(Math.abs(result.biggestBet.wipeOutMovePct - 5) < 1e-9);

  // Trim the first position and the deposit away, as Binance's retention does:
  // the second bet still reads 20x because the account is counted back.
  const trimmed = analysis.analyzeBinance({
    id: "biggest-bet-trimmed",
    detail: { startTime: start, marginBalance: "1000" },
    positionHistory: [{ symbol: "SOXLUSDT", side: "Short", opened: start + 3 * day, closed: start + 4 * day, closingPnl: "0", maxOpenInterest: 200, avgCost: 100, status: "All Closed" }],
    orderHistory: [],
    transferHistory: [],
    livePositions: [],
    performanceWindows: {},
    marketHistory: { nowMs: start + 10 * day, symbols: {} },
    historyStatus: status
  });
  assert.ok(Math.abs(trimmed.biggestBet.leverage - 20) < 1e-9, `trimmed history: ${trimmed.biggestBet.leverage}x`);

  // A 20x bet makes the verdict avoid and says so first.
  assert.equal(result.verdict.level, "avoid");
  assert.equal(result.verdict.cautions[0], zhTwMessages.cautionBiggestBet.message.replace("{0}", "20.0").replace("{1}", "SOXLUSDT 空單").replace("{2}", "5.0"));

  // The exchange will not open more notional than leverage x account, so a
  // count-back that says otherwise is capped at the position's own leverage.
  const bounded = analysis.analyzeBinance({
    id: "biggest-bet-bounded",
    detail: { startTime: start, marginBalance: "100" },
    positionHistory: [{ symbol: "SOXLUSDT", side: "Short", opened: start + 3 * day, closed: start + 4 * day, closingPnl: "0", maxOpenInterest: 200, avgCost: 100, leverage: "20", status: "All Closed" }],
    orderHistory: [],
    transferHistory: [],
    livePositions: [],
    performanceWindows: {},
    marketHistory: { nowMs: start + 10 * day, symbols: {} },
    historyStatus: status
  });
  assert.ok(Math.abs(bounded.biggestBet.leverage - 20) < 1e-9, `bounded by the row's leverage: ${bounded.biggestBet.leverage}x`);
  assert.equal(bounded.biggestBet.boundByLeverage, true);
  console.log("PASS: the biggest bet is read against the account counted back from today, bounded by leverage, and gates the verdict");
}

// 14. Replays portfolio 5108371059752839168 (2026-09-14): CLUSDT long opened
//     small, scaled up for weeks while most of the account was paid out, and
//     only partly closed. Its row pairs the eventual peak with the opening
//     day's account and leaves the partial close's pnl out of the count-back,
//     which read 2.4x. The fills date the peak, and equity then is today's
//     balance less the price moves, funding and transfers since, plus fees.
{
  const day = 24 * 3600 * 1000;
  const hour = 3600 * 1000;
  const start = Date.UTC(2026, 6, 1);
  const status = { positionHistory: { complete: true }, orderHistory: { complete: true }, transferHistory: { complete: true } };
  const fill = (symbol, side, positionSide, qty, price, pnl, time) => ({ symbol, side, type: "LIMIT", positionSide, executedQty: qty, avgPrice: price, totalPnl: pnl, orderUpdateTime: time, orderTime: time });
  const clFills = [
    fill("CLUSDT", "BUY", "LONG", 4, 100, 0, start + 1 * day),
    fill("CLUSDT", "BUY", "LONG", 36, 100, 0, start + 10 * day),
    fill("CLUSDT", "SELL", "LONG", 10, 150, 500, start + 20 * day)
  ];
  const market = {
    nowMs: start + 30 * day,
    symbols: {
      // CLUSDT marked at 100 until day 10 and 150 after; one settlement on day
      // 15 at -0.1% pays the 40 long 40 x 100 x 0.1% = 4.
      CLUSDT: { funding: [[start + 15 * day, -0.001, 100]], marks: [[start, 100, start + 10 * day - 1, 100], [start + 10 * day, 150, start + 30 * day, 150]] },
      XYZUSDT: { funding: [], marks: [[start + 2 * day, 110, start + 2 * day + hour, 110]] }
    }
  };
  const raw = {
    id: "biggest-bet-scaled-up",
    // 2,503.70 today = 500 at the day-10 fill + 2,000 of price move on the 40
    // held from 100 to 150 + 4 funding - 0.30 fees on the 1,500 sold on day 20.
    detail: { startTime: start, marginBalance: "2503.7" },
    positionHistory: [
      { symbol: "CLUSDT", side: "Long", opened: start + 1 * day, closed: null, closingPnl: "504", maxOpenInterest: 40, closedVolume: 10, avgCost: 100, leverage: "50", status: "Partially Closed" },
      // Whole life inside the fills: 100 gross, no funding, 99.58 closingPnl,
      // so fees are 0.42 on 2,100 traded, a 2 bps rate.
      { symbol: "XYZUSDT", side: "Long", opened: start + 2 * day, closed: start + 2 * day + hour, closingPnl: "99.58", maxOpenInterest: 10, closedVolume: 10, avgCost: 100, leverage: "20", status: "All Closed" }
    ],
    orderHistory: [
      ...clFills,
      fill("XYZUSDT", "BUY", "LONG", 10, 100, 0, start + 2 * day),
      fill("XYZUSDT", "SELL", "LONG", 10, 110, 100, start + 2 * day + hour)
    ],
    transferHistory: [
      { time: start, coin: "USDT", amount: 500, transType: "LEAD_INVEST" },
      { time: start + 5 * day, coin: "USDT", amount: 2000, from: "Lead Trading Account", to: "Fiat and Spot", transType: "LEAD_WITHDRAW" }
    ],
    livePositions: [],
    performanceWindows: {},
    marketHistory: market,
    historyStatus: status
  };
  const equity = global.CopyTradingLensEquity.equityCountBack({
    orders: raw.orderHistory,
    positionHistory: raw.positionHistory,
    flows: [{ time: start, amount: 500 }, { time: start + 5 * day, amount: -2000 }],
    marginBalance: 2503.7,
    market
  });
  assert.ok(Math.abs(equity.feeRate - 0.0002) < 1e-12, `fee rate read off the closed row: ${equity.feeRate}`);
  assert.ok(Math.abs(equity.equityAt(start + 10 * day) - 500) < 1e-9, `equity at the day-10 fill: ${equity.equityAt(start + 10 * day)}`);
  // Without the funding term it would read 504; without fees 499.70; without
  // marking the 30 still held it would not reach 500 either.
  const result = analysis.analyzeBinance(raw);
  assert.equal(result.biggestBet.at, start + 10 * day);
  assert.equal(result.biggestBet.symbol, "CLUSDT");
  assert.equal(result.biggestBet.side, "LONG");
  assert.ok(Math.abs(result.biggestBet.account - 500) < 1e-9, `account at the peak fill: ${result.biggestBet.account}`);
  assert.ok(Math.abs(result.biggestBet.leverage - 8) < 1e-9, `8x at the peak, got ${result.biggestBet.leverage}x`);

  // A hedge book whose fills close more than they open was already holding the
  // difference: ETHUSDT short opened before the history, 10 added inside it,
  // 30 bought back at the row's close. Its peak is dated inside the fills, so
  // the row's opening-day reading is not taken.
  const ethFills = [
    fill("ETHUSDT", "SELL", "SHORT", 10, 200, 0, start + 12 * day),
    fill("ETHUSDT", "BUY", "SHORT", 30, 200, 0, start + 30 * day)
  ];
  const preHistory = analysis.analyzeBinance({
    ...raw,
    id: "biggest-bet-pre-history",
    detail: { startTime: start, marginBalance: "1000" },
    positionHistory: [
      { symbol: "ETHUSDT", side: "Short", opened: start + 1 * day, closed: start + 30 * day, closingPnl: "0", maxOpenInterest: 30, closedVolume: 30, avgCost: 100, leverage: "100", status: "All Closed" }
    ],
    orderHistory: ethFills,
    transferHistory: [{ time: start + 5 * day, coin: "USDT", amount: 9000, from: "Lead Trading Account", to: "Fiat and Spot", transType: "LEAD_WITHDRAW" }],
    marketHistory: { nowMs: start + 30 * day, symbols: { ETHUSDT: { funding: [], marks: [[start, 200, start + 30 * day, 200]] } } }
  });
  const stretches = global.CopyTradingLensPositions.sizeAfterEachFill("ETHUSDT|SHORT", ethFills, [{ symbol: "ETHUSDT", side: "Short", closed: start + 30 * day }]);
  assert.deepEqual(stretches.map((stretch) => stretch.steps.map((step) => step.qty)), [[30, 0]], "the pre-history size is carried");
  // Fill reading: 30 x 200 = 6,000 over 1,000. The row's opening-day reading
  // (3,000 over 10,000 with the withdrawal added back) would have been 0.3x.
  assert.equal(preHistory.biggestBet.at, start + 12 * day);
  assert.ok(Math.abs(preHistory.biggestBet.leverage - 6) < 1e-9, `6x inside the fills, got ${preHistory.biggestBet.leverage}x`);

  // A one-way portfolio whose row opens 5.6s before its own first fill, the
  // oldest one fetched: the row falls before the history, and its peak is
  // still found on the one-way ("BOTH") book rather than read at the opening.
  // 5,000 paid in on day 5 makes the opening-day reading wrong: the row's
  // peak of 4,000 over the 500 held then is 8x, while the fills held 400 on
  // 500 that day (0.8x) and 4,000 on 5,500 at the peak (0.73x).
  const oneWay = analysis.analyzeBinance({
    ...raw,
    id: "biggest-bet-one-way",
    detail: { startTime: start, marginBalance: "7504" },
    positionHistory: [{ ...raw.positionHistory[0], opened: start + 1 * day - 5600 }],
    orderHistory: clFills.map((order) => ({ ...order, positionSide: "BOTH" })),
    transferHistory: [{ time: start + 5 * day, coin: "USDT", amount: 5000, from: "Fiat and Spot", to: "Lead Trading Account", transType: "LEAD_DEPOSIT" }]
  });
  assert.equal(oneWay.biggestBet.at, start + 1 * day, "read at the fills on a one-way book, not at the row's opening");
  assert.ok(Math.abs(oneWay.biggestBet.leverage - 0.8) < 1e-9, `one-way: ${oneWay.biggestBet.leverage}x`);
  // A one-way close that flips carries its remainder into the next position,
  // and a close with no opening fill is dated by its row's opening.
  const P = global.CopyTradingLensPositions;
  const flipFills = [
    fill("SOLUSDT", "BUY", "BOTH", 10, 100, 0, start + 1 * day),
    fill("SOLUSDT", "SELL", "BOTH", 15, 110, 100, start + 2 * day),
    fill("SOLUSDT", "BUY", "BOTH", 5, 105, 25, start + 3 * day)
  ];
  const flipRows = [
    { symbol: "SOLUSDT", side: "Long", opened: start + 1 * day, closed: start + 2 * day },
    { symbol: "SOLUSDT", side: "Short", opened: start + 2 * day, closed: start + 3 * day }
  ];
  const flipped = P.sizeAfterEachFill("SOLUSDT|NET", flipFills, flipRows);
  assert.deepEqual(flipped.map((stretch) => [stretch.openedByFlip, stretch.steps.map((step) => `${step.side}:${step.qty}`)]), [[false, ["LONG:10", "SHORT:5"]], [true, ["LONG:0"]]]);
  const orphan = P.sizeAfterEachFill("DOGEUSDT|LONG", [fill("DOGEUSDT", "SELL", "LONG", 10, 1, 2, start + 5 * day)], [{ symbol: "DOGEUSDT", side: "Long", opened: start + 4 * day, closed: start + 5 * day }]);
  assert.deepEqual([orphan[0].shortfall, orphan[0].heldFrom], [10, start + 4 * day]);

  // A position open on the exchange with no fill in the history was held the
  // whole time: 5 BNB long from before the history, marked 600 on day 20 and
  // 700 now, is 500 of the equity change after day 20.
  const untouched = global.CopyTradingLensEquity.equityCountBack({
    orders: [],
    positionHistory: [{ symbol: "BNBUSDT", side: "Long", opened: start - 10 * day, closed: null, maxOpenInterest: 6, closedVolume: 1, avgCost: 500 }],
    flows: [],
    marginBalance: 10000,
    market: { nowMs: start + 30 * day, symbols: { BNBUSDT: { funding: [], marks: [[start, 500, start + 20 * day, 600], [start + 20 * day, 600, start + 30 * day, 700]] } } }
  });
  assert.ok(Math.abs(untouched.equityAt(start + 20 * day) - 9500) < 1e-9, `untouched position marked: ${untouched.equityAt(start + 20 * day)}`);
  // 4763954199553903361: an open ETHUSDT long row closed 23.165 against a
  // 19.573 peak. Its size is unknown, not -3.592.
  const readded = global.CopyTradingLensEquity.equityCountBack({
    orders: [],
    positionHistory: [{ symbol: "ETHUSDT", side: "Long", opened: start - 10 * day, closed: null, maxOpenInterest: 19.573, closedVolume: 23.165, avgCost: 2000 }],
    flows: [],
    marginBalance: 10000,
    market: { nowMs: start + 30 * day, symbols: { ETHUSDT: { funding: [], marks: [[start, 1700, start + 30 * day, 1900]] } } }
  });
  assert.equal(readded.paths.size, 0, "a re-added position's size is not guessed");

  // Replays 5117780547953263617: a 100 ETHUSDT short opened and closed ten
  // minutes later for -6,246 with no closing fill in the history. Hourly marks
  // flat at 2,500 see no loss; the row's closingPnl is the loss, at its close.
  const liquidated = global.CopyTradingLensEquity.equityCountBack({
    orders: [fill("ETHUSDT", "SELL", "SHORT", 100, 2500, 0, start + 40 * day)],
    positionHistory: [{ symbol: "ETHUSDT", side: "Short", opened: start + 40 * day, closed: start + 40 * day + 600000, closingPnl: "-6246", maxOpenInterest: 100, closedVolume: 100, avgCost: 2500 }],
    flows: [],
    marginBalance: 1000,
    market: { nowMs: start + 50 * day, symbols: { ETHUSDT: { funding: [], marks: [[start + 40 * day, 2500, start + 50 * day, 2500]] } } }
  });
  assert.ok(Math.abs(liquidated.equityAt(start + 40 * day) - 7246) < 1e-9, `equity before the liquidation: ${liquidated.equityAt(start + 40 * day)}`);

  // Replays 4395375800392267008: an open row updated after the last fill its
  // book lists means the order history is missing fills; 5.6s is clock lead.
  const ahead = (updated) => analysis.analyzeBinance({
    ...raw,
    id: "fills-missing",
    positionHistory: [...raw.positionHistory, { symbol: "CLUSDT", side: "Long", opened: start + 1 * day, closed: null, closingPnl: "0", maxOpenInterest: 40, closedVolume: 10, avgCost: 100, leverage: "50", updateTime: updated }]
  });
  assert.ok(ahead(start + 21 * day).verdict.cautions.some((caution) => caution.includes(zhTwMessages.gapFillsMissing.message)), "a row a day past its last fill is a gap");
  assert.ok(!ahead(start + 20 * day + 5600).verdict.cautions.some((caution) => caution.includes(zhTwMessages.gapFillsMissing.message)), "5.6s of clock lead is not");

  // A symbol whose funding and marks could not be read leaves equity missing
  // that symbol's moves, so the analysis says the data is incomplete.
  const unread = analysis.analyzeBinance({ ...raw, id: "market-unread", marketHistory: { ...market, failed: [{ symbol: "CLUSDT", error: "HTTP 400" }] } });
  assert.equal(unread.verdict.level, "incomplete");
  assert.ok(unread.verdict.cautions.some((caution) => caution.includes(zhTwMessages.gapMarketHistory.message)), `cautions: ${unread.verdict.cautions}`);
  console.log("PASS: the biggest bet is read at the fill that made it that large, against equity counted back through moves, funding and fees");
}

console.log("\nALL ANALYSIS UNIT TESTS PASSED SUCCESSFULLY!");
