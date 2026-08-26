// Unit tests for src/positions.js — the open-position reconstruction that
// makes a private lead trader's current book readable.
//
// The cases below are the failure modes the 2026-08-26 hold-out run against
// public portfolios actually produced: one-way ("BOTH") position side,
// scale-back-in after a partial close, direction flips, and float residue on
// 8-decimal quantities. Each one used to return the wrong size.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandbox = { console };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/positions.js"), "utf8"), sandbox, { filename: "positions.js" });
const Positions = sandbox.CopyTradingLensPositions;

let clock = 1700000000000;
function order(symbol, side, positionSide, executedQty, avgPrice, totalPnl = 0) {
  clock += 1000;
  return { symbol, side, positionSide, executedQty, avgPrice, totalPnl, orderUpdateTime: clock, orderTime: clock, type: "MARKET" };
}

function closedPosition(symbol, side, closedAt, extra = {}) {
  return {
    symbol,
    side,
    opened: closedAt - 3600000,
    closed: closedAt,
    avgCost: 1,
    avgClosePrice: 1,
    closingPnl: 0,
    maxOpenInterest: 1,
    closedVolume: 1,
    isolated: "Cross",
    status: "All Closed",
    updateTime: closedAt,
    leverage: "10",
    ...extra
  };
}

// The portfolio start defaults to just before the first fill, i.e. the fills
// provably cover the whole portfolio. Tests that want the opposite — an order
// history that starts after the portfolio did — pass an earlier startTime.
function reconstruct(orderHistory, positionHistory = [], startTime = null) {
  const firstFill = orderHistory.length
    ? Math.min(...orderHistory.map((order) => order.orderUpdateTime))
    : Date.parse("2026-01-01T00:00:00Z");
  return Positions.reconstructBinanceOpenPositions({
    detail: { startTime: startTime === null ? firstFill - 1 : startTime },
    orderHistory,
    positionHistory,
    historyStatus: { orderHistory: { complete: true, fetched: orderHistory.length, total: orderHistory.length } }
  });
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("single long fill reports size and entry", () => {
  const { positions } = reconstruct([order("BTCUSDT", "BUY", "LONG", 10, 100)]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, "LONG");
  assert.equal(positions[0].qty, 10);
  assert.equal(positions[0].entryPrice, 100);
  assert.equal(positions[0].partiallyClosed, false);
  assert.equal(positions[0].confidence, "exact");
});

test("scale-in averages the entry", () => {
  const { positions } = reconstruct([
    order("BTCUSDT", "BUY", "LONG", 10, 100),
    order("BTCUSDT", "BUY", "LONG", 10, 120)
  ]);
  assert.equal(positions[0].qty, 20);
  assert.equal(positions[0].entryPrice, 110);
  assert.equal(positions[0].addCount, 1);
});

test("partial close leaves the entry price alone and marks the position", () => {
  const { positions } = reconstruct([
    order("BTCUSDT", "BUY", "LONG", 10, 100),
    order("BTCUSDT", "BUY", "LONG", 10, 120),
    order("BTCUSDT", "SELL", "LONG", 5, 130, 100)
  ]);
  assert.equal(positions[0].qty, 15);
  assert.equal(positions[0].entryPrice, 110);
  assert.equal(positions[0].closedQty, 5);
  assert.equal(positions[0].partiallyClosed, true);
  assert.equal(positions[0].reduceCount, 1);
  assert.equal(positions[0].realizedPnl, 100);
});

test("scale back in after a partial close beats the peak-minus-closed estimate", () => {
  // maxOpenInterest would be 25 and closedVolume 5, so the position-history
  // remainder formula answers 20. The true size is 25. This is the exact case
  // that made position-history-first reconstruction understate live books.
  const { positions } = reconstruct([
    order("BTCUSDT", "BUY", "LONG", 10, 100),
    order("BTCUSDT", "SELL", "LONG", 5, 110, 50),
    order("BTCUSDT", "BUY", "LONG", 20, 105)
  ]);
  assert.equal(positions[0].qty, 25);
  assert.equal(positions[0].qtySource, "orderNetting");
});

test("one-way (BOTH) fills bucket together and derive their own direction", () => {
  const { positions } = reconstruct([
    order("ETHUSDT", "SELL", "BOTH", 4, 2000),
    order("ETHUSDT", "SELL", "BOTH", 2, 2100)
  ]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, "SHORT");
  assert.equal(positions[0].qty, 6);
  assert.ok(Math.abs(positions[0].entryPrice - (4 * 2000 + 2 * 2100) / 6) < 1e-9);
  assert.equal(positions[0].oneWayMode, true);
});

test("hedge-mode short bucket nets on the short leg only", () => {
  const { positions } = reconstruct([
    order("ETHUSDT", "SELL", "SHORT", 10, 2000),
    order("ETHUSDT", "BUY", "SHORT", 4, 1900, 400),
    order("ETHUSDT", "BUY", "LONG", 3, 1950)
  ]);
  const short = positions.find((p) => p.side === "SHORT");
  const long = positions.find((p) => p.side === "LONG");
  assert.equal(short.qty, 6);
  assert.equal(short.entryPrice, 2000);
  assert.equal(long.qty, 3);
});

test("a fill through zero flips the position and restarts the basis", () => {
  const { positions } = reconstruct([
    order("BTCUSDT", "BUY", "BOTH", 10, 100),
    order("BTCUSDT", "SELL", "BOTH", 25, 90, -100)
  ]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, "SHORT");
  assert.equal(positions[0].qty, 15);
  assert.equal(positions[0].entryPrice, 90);
  assert.equal(positions[0].partiallyClosed, false);
});

test("a flat bucket reports nothing", () => {
  const { positions } = reconstruct([
    order("BTCUSDT", "BUY", "LONG", 10, 100),
    order("BTCUSDT", "SELL", "LONG", 10, 110, 100)
  ]);
  assert.equal(positions.length, 0);
});

test("8-decimal quantities net to exactly flat", () => {
  const { positions } = reconstruct([
    order("XRPUSDT", "BUY", "LONG", 0.00000001, 3),
    order("XRPUSDT", "BUY", "LONG", 0.00000002, 3),
    order("XRPUSDT", "SELL", "LONG", 0.00000003, 3, 0)
  ]);
  assert.equal(positions.length, 0);
});

test("fills before the last full close are ignored", () => {
  const older = order("BTCUSDT", "BUY", "LONG", 999, 10);
  const closeTime = older.orderUpdateTime + 500;
  const newer = order("BTCUSDT", "BUY", "LONG", 3, 200);
  const { positions } = reconstruct([older, newer], [closedPosition("BTCUSDT", "Long", closeTime)]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].qty, 3);
  assert.equal(positions[0].entryPrice, 200);
});

test("a one-way symbol's flat anchor ignores the closed row's direction", () => {
  const older = order("BTCUSDT", "SELL", "BOTH", 50, 10);
  const closeTime = older.orderUpdateTime + 500;
  const newer = order("BTCUSDT", "BUY", "BOTH", 2, 300);
  const { positions } = reconstruct([older, newer], [closedPosition("BTCUSDT", "Short", closeTime)]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, "LONG");
  assert.equal(positions[0].qty, 2);
});

test("an unclosed position-history row with no reachable fills is reported as estimated", () => {
  const openRow = {
    symbol: "SOLUSDT",
    side: "Long",
    opened: 1699000000000,
    closed: null,
    avgCost: 150,
    avgClosePrice: 160,
    closingPnl: 500,
    maxOpenInterest: 100,
    closedVolume: 40,
    isolated: "Cross",
    status: "Partially Closed",
    updateTime: 1699500000000,
    leverage: "20"
  };
  const { positions } = reconstruct([], [openRow]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].qty, 60);
  assert.equal(positions[0].confidence, "estimated");
  assert.equal(positions[0].qtySource, "positionHistoryRemainder");
  assert.equal(positions[0].leverage, 20);
  assert.equal(positions[0].leverageSource, "position");
});

test("leverage falls back to the same symbol's last closed position and says so", () => {
  const older = order("BTCUSDT", "BUY", "LONG", 1, 100);
  const closeTime = older.orderUpdateTime + 500;
  const newer = order("BTCUSDT", "BUY", "LONG", 2, 200);
  const { positions } = reconstruct(
    [older, newer],
    [closedPosition("BTCUSDT", "Long", closeTime, { leverage: "7" })]
  );
  assert.equal(positions[0].leverage, 7);
  assert.equal(positions[0].leverageSource, "inferredFromSameSymbol");
});

test("depth-capped order history downgrades confidence instead of lying", () => {
  const closeTime = 1699000000000;
  const fill = order("BTCUSDT", "BUY", "LONG", 5, 100);
  const result = Positions.reconstructBinanceOpenPositions({
    orderHistory: [fill],
    positionHistory: [closedPosition("BTCUSDT", "Long", closeTime)],
    historyStatus: { orderHistory: { complete: false, fetched: 6100, total: 20000 } }
  });
  assert.equal(result.positions[0].confidence, "partialFills");
  assert.equal(result.coverage.orderHistoryComplete, false);
});

test("mark enrichment values the book on mark price, both directions", () => {
  const { positions } = reconstruct([
    order("BTCUSDT", "BUY", "LONG", 2, 100),
    order("ETHUSDT", "SELL", "SHORT", 10, 50)
  ], [
    closedPosition("BTCUSDT", "Long", 1, { leverage: "10" }),
    closedPosition("ETHUSDT", "Short", 1, { leverage: "5" })
  ]);
  const priced = Positions.enrichWithMarks(positions, { BTCUSDT: 110, ETHUSDT: 45 }, {
    nowMs: clock + 3600000,
    marginBalance: 1000
  });
  const long = priced.find((p) => p.symbol === "BTCUSDT");
  const short = priced.find((p) => p.symbol === "ETHUSDT");
  assert.equal(long.unrealizedPnl, 20);
  assert.ok(Math.abs(long.roi - 1) < 1e-9);          // +10% price on 10x
  assert.equal(short.unrealizedPnl, 50);
  assert.ok(Math.abs(short.roi - 0.5) < 1e-9);       // -10% price on 5x short
  assert.equal(short.notional, 450);

  const summary = Positions.summarizePortfolio(priced, 1000);
  assert.equal(summary.openCount, 2);
  assert.equal(summary.grossNotional, 220 + 450);
  assert.equal(summary.longNotional, 220);
  assert.equal(summary.shortNotional, 450);
  assert.equal(summary.unrealizedPnl, 70);
  assert.ok(Math.abs(summary.grossLeverage - 0.67) < 1e-9);
});

test("an unpriced symbol degrades to null instead of a zero-priced position", () => {
  const { positions } = reconstruct([order("NEWUSDT", "BUY", "LONG", 5, 3)]);
  const priced = Positions.enrichWithMarks(positions, {}, { nowMs: clock + 1000, marginBalance: 100 });
  assert.equal(priced[0].markPrice, null);
  assert.equal(priced[0].unrealizedPnl, null);
  assert.equal(priced[0].notional, null);
});

test("a size the fills understate is repaired from the exchange's own aggregates", () => {
  // Live case (portfolio 5156305122364875520, SPCXUSDT, 2026-08-26): order
  // history omitted one opening fill, so netting reported 400 against a real
  // 440. The position row's peak size proves the missing volume existed, and
  // its closed volume proves that volume was never closed.
  const fills = [
    order("SPCXUSDT", "SELL", "BOTH", 400, 140.8),
    order("SPCXUSDT", "BUY", "BOTH", 40, 133.63, 267.8),
    order("SPCXUSDT", "SELL", "BOTH", 40, 139.45)
  ];
  const openRow = {
    symbol: "SPCXUSDT",
    side: "Short",
    opened: fills[0].orderUpdateTime,
    closed: null,
    avgCost: 140.25,
    closingPnl: 267.8,
    maxOpenInterest: 440,
    closedVolume: 40,
    isolated: "Cross",
    status: "Partially Closed",
    updateTime: 1699500000000,
    leverage: "9"
  };
  const { positions } = reconstruct(fills, [openRow]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].qty, 440);
  assert.equal(positions[0].confidence, "reconciled");
  assert.equal(positions[0].qtySource, "exchangePeakReconciled");
  assert.equal(positions[0].reconciliation.missingOpenVolume, 40);
  assert.equal(positions[0].reconciliation.missingCloseVolume, 0);
});

test("fills that agree with the exchange aggregates stay exact and untouched", () => {
  const fills = [
    order("ZORAUSDT", "BUY", "BOTH", 1100000, 0.00688),
    order("ZORAUSDT", "SELL", "BOTH", 300000, 0.0072, 96)
  ];
  const openRow = {
    symbol: "ZORAUSDT",
    side: "Long",
    opened: fills[0].orderUpdateTime,
    closed: null,
    avgCost: 0.00688,
    closingPnl: 10,
    maxOpenInterest: 1100000,
    closedVolume: 300000,
    isolated: "Cross",
    status: "Partially Closed",
    updateTime: 1699500000000,
    leverage: "10"
  };
  const { positions } = reconstruct(fills, [openRow]);
  assert.equal(positions[0].qty, 800000);
  assert.equal(positions[0].confidence, "exact");
  assert.equal(positions[0].reconciliation.correction, 0);
});

test("a position scaled back in past its old peak is not falsely repaired", () => {
  // maxOpenInterest is a running maximum, so a bucket whose fills already reach
  // that peak must be left alone — repairing it would double-count the re-add.
  const fills = [
    order("TRUMPUSDT", "BUY", "BOTH", 42000, 2.49),
    order("TRUMPUSDT", "SELL", "BOTH", 26000, 2.6, 2860),
    order("TRUMPUSDT", "BUY", "BOTH", 15000, 2.55)
  ];
  const openRow = {
    symbol: "TRUMPUSDT",
    side: "Long",
    opened: fills[0].orderUpdateTime,
    closed: null,
    avgCost: 2.49,
    closingPnl: 100,
    maxOpenInterest: 42000,
    closedVolume: 26000,
    isolated: "Cross",
    status: "Partially Closed",
    updateTime: 1699500000000,
    leverage: "10"
  };
  const { positions } = reconstruct(fills, [openRow]);
  assert.equal(positions[0].qty, 31000);
  assert.equal(positions[0].confidence, "exact");
});

test("a hedge long book whose opening fills predate the history is not reported as a short", () => {
  // Live case (portfolio 5108371059752839168, 2026-08-26): the ETH long book was
  // opened before Binance's order history begins, so the only visible ETH long
  // fills are SELLs. Treating the first of them as an opening trade invented an
  // "ETHUSDT SHORT" that the trader did not hold — on top of the real ETH short,
  // so the same symbol and side appeared twice.
  const { positions } = reconstruct([
    order("ETHUSDT", "SELL", "LONG", 50, 2509),
    order("ETHUSDT", "SELL", "SHORT", 100, 2476.5)
  ]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, "SHORT");
  assert.equal(positions[0].qty, 100);
});

test("one-way mode still flips, because there is only one book to flip", () => {
  const { positions } = reconstruct([
    order("ETHUSDT", "BUY", "BOTH", 10, 2000),
    order("ETHUSDT", "SELL", "BOTH", 25, 2100, 1000)
  ]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].side, "SHORT");
  assert.equal(positions[0].qty, 15);
});

test("a position dated before the oldest fill proves the history is cut off", () => {
  // Binance served an order history starting three days after the portfolio did
  // while still reporting the fetch complete. A position the exchange dates
  // inside that gap is the proof; the gap on its own is not, since a trader who
  // simply did not trade for three days looks identical.
  const fills = [order("BTCUSDT", "SELL", "SHORT", 50, 77649)];
  const staleOpenRow = {
    symbol: "ETHUSDT",
    side: "Long",
    opened: fills[0].orderUpdateTime - 86400000,
    closed: null,
    avgCost: 1730,
    closingPnl: 100,
    maxOpenInterest: 423,
    closedVolume: 403,
    isolated: "Cross",
    status: "Partially Closed",
    updateTime: fills[0].orderUpdateTime,
    leverage: "20"
  };
  const { positions, coverage } = reconstruct(fills, [staleOpenRow]);
  assert.equal(coverage.orderHistoryTruncatedAtOldEnd, true);
  const btc = positions.find((p) => p.symbol === "BTCUSDT");
  assert.equal(btc.confidence, "partialFills", "no anchor and a truncated history cannot be exact");
  const eth = positions.find((p) => p.symbol === "ETHUSDT");
  assert.equal(eth.qty, 20);
  assert.equal(eth.confidence, "estimated");
});

test("a still-open position with no derivable size is reported, not dropped", () => {
  // closedVolume can exceed maxOpenInterest after repeated close-and-re-enter.
  // Dropping the row would tell the reader the trader holds nothing on that
  // symbol while the exchange is explicitly still listing the position.
  const openRow = {
    symbol: "SKHYNIXUSDT",
    side: "Short",
    opened: Date.parse("2026-07-01T00:00:00Z"),
    closed: null,
    avgCost: 1391.06,
    closingPnl: 188230,
    maxOpenInterest: 395,
    closedVolume: 685.06,
    isolated: "Cross",
    status: "Partially Closed",
    updateTime: Date.parse("2026-08-05T00:00:00Z"),
    leverage: "19"
  };
  const { positions } = reconstruct([], [openRow]);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].qty, null);
  assert.equal(positions[0].qtySource, "sizeNotDerivable");
  assert.equal(positions[0].entryPrice, 1391.06);
  const priced = Positions.enrichWithMarks(positions, { SKHYNIXUSDT: 1200 }, { nowMs: Date.now(), marginBalance: 1000 });
  assert.equal(priced[0].markPrice, 1200);
  assert.equal(priced[0].notional, null, "an unknown size must not produce a notional");
  assert.equal(priced[0].unrealizedPnl, null);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
