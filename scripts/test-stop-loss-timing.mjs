import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = vm.createContext({ window: {} });
for (const name of ["positions", "stoploss"]) {
  vm.runInContext(fs.readFileSync(new URL(`../src/${name}.js`, import.meta.url), "utf8"), context);
}
const { simulateCopier } = context.window.CopyTradingLensStopLoss;
const T = Date.UTC(2026, 8, 1);
const MINUTE = 60000;

// Independent reference: enumerate every relaxed stop/no-stop history, with no state merging or dominance.
// Fixtures use small integer lead quantities, so this oracle can keep an exact Number lead quantity without
// sharing the implementation's scaled-quantity helper. Its bounds are for the disclosed OHLC relaxation.
function enumerateHistories(sim, stop, follow) {
  let leadQty = 0;
  let histories = [{ qty: 0, entry: 0, pnl: 0, stopped: false, triggers: 0 }];
  for (let i = 0; i < sim.fills.length; i += 1) {
    const fill = sim.fills[i];
    const from = i ? sim.fills[i - 1].time : fill.time;
    const branched = [];
    for (const history of histories) {
      const threshold = history.entry * (1 - sim.direction * stop / (100 * sim.leverage));
      const crossing = history.qty > 0 && fill.time > from
        ? sim.candles.filter((bar) => (
          bar.time < fill.time && bar.time + bar.step > from
          && (sim.direction === 1 ? bar.low <= threshold : bar.high >= threshold)
        )) : [];
      const mustStop = crossing.some((bar) => bar.time >= from && bar.time + bar.step <= fill.time);
      if (!mustStop) branched.push({ ...history });
      if (crossing.length) {
        branched.push({
          ...history,
          qty: 0,
          pnl: history.pnl - (stop / 100) * history.qty * history.entry / sim.leverage,
          stopped: true,
          triggers: history.triggers + 1
        });
      }
    }
    if (fill.entry) leadQty += fill.qty;
    for (const history of branched) {
      if (fill.entry && !(history.stopped && !follow)) {
        const nextQty = history.qty + fill.qty;
        history.entry = (history.qty * history.entry + fill.qty * fill.price) / nextQty;
        history.qty = nextQty;
        history.stopped = false;
      } else if (!fill.entry && history.qty > 0) {
        const reduced = history.qty * fill.qty / leadQty;
        history.pnl += (fill.price - history.entry) * sim.direction * reduced;
        history.qty -= reduced;
      }
    }
    if (!fill.entry) leadQty -= fill.qty;
    histories = branched;
  }
  return {
    minimum: Math.min(...histories.map((history) => history.pnl)),
    maximum: Math.max(...histories.map((history) => history.pnl)),
    possible: histories.some((history) => history.triggers > 0),
    certain: histories.every((history) => history.triggers > 0)
  };
}

let seed = 1743;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
const near = (actual, expected, label) => {
  assert.ok(Math.abs(actual - expected) <= 1e-8, `${label}: ${actual} != ${expected}`);
};

let checked = 0;
for (let fixture = 0; fixture < 80; fixture += 1) {
  let leadQty = 1;
  const fills = [{ time: T, entry: true, qty: 1, price: 100 }];
  for (let i = 1; i < 6; i += 1) {
    const entry = i % 2 === 1 || leadQty === 1;
    const qty = entry ? 1 + Math.floor(random() * 4) : Math.max(1, Math.floor(leadQty / 2));
    leadQty += entry ? qty : -qty;
    fills.push({ time: T + i * 40000, entry, qty, price: 90 + Math.floor(random() * 25) });
  }
  fills.push({ time: T + 4 * MINUTE, entry: false, qty: leadQty, price: 90 + Math.floor(random() * 25) });
  const sim = {
    fills,
    direction: fixture % 2 ? 1 : -1,
    leverage: 10,
    candles: Array.from({ length: 4 }, (_, i) => ({
      time: T + i * MINUTE,
      step: MINUTE,
      high: 105 + Math.floor(random() * 15),
      low: 80 + Math.floor(random() * 20)
    }))
  };
  for (const follow of [false, true]) {
    for (const stop of [1, 30, 50, 95]) {
      const reference = enumerateHistories(sim, stop, follow);
      const lower = simulateCopier(sim, stop, follow, false, null, "dynamic");
      const upper = simulateCopier(sim, stop, follow, true, null, "dynamic");
      const label = `fixture ${fixture}, direction ${sim.direction}, follow ${follow}, stop ${stop}`;
      near(lower.pnl, reference.minimum, `${label}, minimum`);
      near(upper.pnl, reference.maximum, `${label}, maximum`);
      for (const outcome of [lower, upper]) {
        assert.equal(outcome.triggerPossible, reference.possible, `${label}, trigger possible`);
        assert.equal(outcome.triggerCertain, reference.certain, `${label}, trigger certain`);
      }
      checked += 1;
    }
  }
}
assert.equal(checked, 640);

// Two fills at the same clock have no intervening exposure interval. A candle containing that clock must
// not lend its earlier or later low to a zero-duration position, even though it crosses the stop threshold.
const instantaneous = {
  direction: 1,
  leverage: 10,
  fills: [
    { time: T + MINUTE / 2, entry: true, qty: 1, price: 100 },
    { time: T + MINUTE / 2, entry: false, qty: 1, price: 105 }
  ],
  candles: [{ time: T, step: MINUTE, high: 110, low: 90 }]
};
for (const follow of [false, true]) {
  for (const optimisticTiming of [false, true]) {
    const outcome = simulateCopier(instantaneous, 50, follow, optimisticTiming);
    near(outcome.pnl, 5, "zero-duration position preserves both fills");
    assert.equal(outcome.triggers, 0);
    assert.equal(outcome.triggerPossible, false);
    assert.equal(outcome.triggerCertain, false);
  }
}

console.log("PASS: 640 independent exhaustive OHLC timing comparisons, dominance/reachability, and zero-duration fills");
