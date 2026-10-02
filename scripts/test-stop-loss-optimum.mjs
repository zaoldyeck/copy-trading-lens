import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = vm.createContext({ window: {} });
for (const file of ["positions", "stoploss"]) vm.runInContext(fs.readFileSync(new URL(`../src/${file}.js`, import.meta.url), "utf8"), context);
const S = context.window.CopyTradingLensStopLoss;
const T = Date.UTC(2026, 8, 1); const M = 60000;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const plain = (value) => JSON.parse(JSON.stringify(value));
const row = (mae, exit, opened = T) => ({
  opened, closed: opened + 2 * M, symbol: "X", side: "LONG", leverage: 10, marksUsed: true,
  maeRoe: mae, sim: { direction: 1, leverage: 10,
    fills: [{ time: opened, entry: true, qty: 1, price: 100 }, { time: opened + 2 * M, entry: false, qty: 1, price: exit }],
    candles: [{ time: opened, step: M, high: 100, low: 100 - mae / 10 }, { time: opened + M, step: M, high: 100, low: 100 }]
  }
});

// Independent analytical oracle for a single-entry position: MAE reaches L => -L% of initial margin.
const controls = [...Array.from({ length: 40 }, () => row(36.2, 103)), ...Array.from({ length: 3 }, () => row(200, 85))];
const sel = S.selectStop(controls, null);
assert.equal(sel.optimal, 37, "the old 5% grid misses the exact 1% optimum");
assert.equal(sel.curve.length, 96);
assert.deepEqual(plain(sel.curve.map((point) => point.stop)), [null, ...Array.from({ length: 95 }, (_, i) => i + 1)]);
for (const point of sel.curve) {
  const expected = controls.reduce((sum, r) => sum + (point.stop !== null && r.maeRoe >= point.stop ? -point.stop / 10 : r.sim.fills[1].price - 100), 0);
  near(point.pnlMin, expected); near(point.pnlMax, expected);
}

// Exact ties are a set; no stop wins deterministic tie-breaking, and every equal stop remains visible.
const tied = S.selectStop([row(0, 103), row(0, 103), row(0, 103)], null);
assert.equal(tied.optimal, null);
assert.equal(tied.optima.length, 96);
assert.equal(tied.band.length, 95);
assert.equal(tied.insuranceStop, 1);

// Undefined/negative/NaN reconstructed equity must never be invented from future position size.
for (const value of [undefined, 0, -100, NaN]) assert.equal(S.selectStop(controls, { equityAt: () => value }).objective, "pnl");
assert.equal(S.selectStop(controls, { equityAt: () => 50, unpriced: ["X"] }).objective, "pnl");

// Genuine log utility cannot reward bankruptcy with a clipped finite penalty, regardless of many winners.
const ruin = [...Array.from({ length: 40 }, () => row(0, 103)), row(200, 85)];
const growth = S.selectStop(ruin, { equityAt: () => 10 });
assert.equal(growth.curve[0].score, -Infinity);
assert.equal(growth.optimal, 1);

// MARK triggers cannot be inferred from execution-price MAE.
const markFlat = [row(100, 90), row(100, 90), row(100, 90)];
for (const r of markFlat) for (const c of r.sim.candles) c.low = 100;
const flat = S.selectStop(markFlat, null);
assert.ok(flat.curve.every((point) => point.triggered === 0));
assert.equal(S.tradeoffOf(flat, 10).triggered, 0);

// Partial exits after a stopped copier rejoins must mirror the LEAD'S FRACTION closed.
const restart = { direction: 1, leverage: 10,
  fills: [
    { time: T, entry: true, qty: 10, price: 100 },
    { time: T + 2 * M, entry: true, qty: 10, price: 90 },
    { time: T + 4 * M, entry: false, qty: 10, price: 100 },
    { time: T + 6 * M, entry: false, qty: 10, price: 95 }
  ],
  candles: Array.from({ length: 6 }, (_, i) => ({ time: T + i * M, step: M, high: i < 2 ? 100 : 100, low: i === 1 ? 90 : (i < 2 ? 100 : 90) }))
};
near(S.simulateCopier(restart, 50, true).pnl, 25);
near(S.simulateCopier(restart, 50, false).pnl, -50);

// Unknown intrabar order is represented as sensitivity, rather than retroactively asserted as fact.
const intrabar = { direction: 1, leverage: 10,
  fills: [{ time: T, entry: true, qty: 10, price: 100 }, { time: T + M / 2, entry: false, qty: 9, price: 110 }, { time: T + M, entry: false, qty: 1, price: 95 }],
  candles: [{ time: T, step: M, high: 110, low: 90 }]
};
near(S.simulateCopier(intrabar, 50, false, false).pnl, -50);
near(S.simulateCopier(intrabar, 50, false, true).pnl, 85);

// Earliest trigger is NOT the worst loss: waiting until after an add can stop much more margin.
const uncertainAdd = { direction: 1, leverage: 10,
  fills: [{ time: T, entry: true, qty: 1, price: 100 }, { time: T + M / 2, entry: true, qty: 9, price: 96 }, { time: T + M, entry: false, qty: 10, price: 96 }],
  candles: [{ time: T, step: M, high: 100, low: 91.4 }]
};
near(S.simulateCopier(uncertainAdd, 50, false, false).pnl, -48.2);
near(S.simulateCopier(uncertainAdd, 50, true, false).pnl, -48.2);
near(S.simulateCopier(uncertainAdd, 50, false, true).pnl, -4);

const equalPnlTrigger = { direction: 1, leverage: 10,
  fills: [{ time: T + 10000, entry: true, qty: 1, price: 100 }, { time: T + 50000, entry: false, qty: 1, price: 95 }],
  candles: [{ time: T, step: M, high: 100, low: 90 }]
};
for (const optimistic of [false, true]) {
  const outcome = S.simulateCopier(equalPnlTrigger, 50, false, optimistic);
  near(outcome.pnl, -5);
  assert.equal(outcome.triggerPossible, true, "equal money is not proof a stop never triggers");
  assert.equal(outcome.triggerCertain, false);
}

// Missing close, incompatible quantity and incomplete candles are excluded at the shared admission boundary.
const positions = Array.from({ length: 3 }, (_, i) => ({ symbol: `X${i}`, side: "LONG", leverage: 10, avgCost: 100,
  avgClosePrice: 90, closingPnl: -10, roi: -1, opened: T, closed: T + 3 * M, maxOpenInterest: 1, closedVolume: 1 }));
const orders = positions.map((p) => ({ symbol: p.symbol, side: "BUY", executedQty: 1, avgPrice: 100, orderUpdateTime: T }));
const symbols = Object.fromEntries(positions.map((p) => [p.symbol, { minutes: Array.from({ length: 3 }, (_, i) => [T + i * M, 110, 90]), hours: [] }]));
assert.equal(S.analyzeStopLossRadar(positions, orders, { symbols }, null).insufficientData, true);
for (const p of positions) orders.push({ symbol: p.symbol, side: "SELL", executedQty: 1, avgPrice: 90, orderUpdateTime: p.closed });
assert.equal(S.analyzeStopLossRadar(positions, orders, { symbols }, null).insufficientData, false, "recovery after complete fills");
for (const p of positions) symbols[p.symbol].minutes.splice(1, 1);
assert.equal(S.analyzeStopLossRadar(positions, orders, { symbols }, null).insufficientData, true);
for (const p of positions) symbols[p.symbol].minutes.splice(1, 0, [T + M, 110, 90]);
assert.equal(S.analyzeStopLossRadar(positions, orders, { symbols }, null).insufficientData, false, "recovery after candle gap repaired");
assert.equal(S.analyzeStopLossRadar(positions.map((p) => ({ ...p, maxOpenInterest: 2 })), orders, { symbols }, null).insufficientData, true);
const excursions = S.positionExcursions(positions, orders, { symbols });
near(excursions[0].maeRoe, 100); near(excursions[0].mfeRoe, 100);
const flatSymbols = Object.fromEntries(positions.map((p) => [p.symbol, { minutes: Array.from({ length: 3 }, (_, i) => [T + i * M, 100, 100]), hours: [] }]));
const tight = S.analyzeStopLossRadar(positions.map((p) => ({ ...p, leverage: 50 })), orders, { symbols: flatSymbols }, null);
assert.equal(tight.recommendedRoe, 1);
assert.equal(tight.recommendedPriceDrop, 0.02, "1% ROE at50x must not display as a zero price move");
assert.equal(S.lifeCandles({ minutes: [[T, 100, 90], [T + M, 200, 1]], hours: [] }, T, T + M).length, 1, "a candle opening at the exact close belongs to the future");

console.log("PASS: exact 1% optimum, complete tie set, valid sizing/ruin, mark triggers, proportional reentry exits, timing sensitivity, coverage and recovery, MAE/MFE");
