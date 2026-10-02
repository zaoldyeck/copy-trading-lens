import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const context = vm.createContext({ window: {} });
for (const name of ["positions", "stoploss"]) {
  vm.runInContext(fs.readFileSync(new URL(`../src/${name}.js`, import.meta.url), "utf8"), context);
}
const S = context.window.CopyTradingLensStopLoss;
const T = Date.UTC(2026, 8, 1);
const MINUTE = 60000;
const near = (actual, expected, label) => {
  assert.ok(Math.abs(actual - expected) <= 1e-8, `${label}: ${actual} != ${expected}`);
};

// Enumerate every relaxed OHLC history without state merging or the production quantity helper. Between
// candles the clock is authoritative; inside a candle either barrier may be first. A partially overlapping
// candle may make its extreme outside the current holding interval, so no-hit remains a possible branch.
function enumerate(sim, stop, takeProfit, follow, executionModel) {
  let leadQty = 0;
  let histories = [{ qty: 0, entry: 0, anchor: 0, pnl: 0, out: false, stopHits: 0, profitHits: 0 }];
  for (let i = 0; i < sim.fills.length; i += 1) {
    const fill = sim.fills[i];
    const from = i ? sim.fills[i - 1].time : fill.time;
    const bars = fill.time > from ? sim.candles.filter((bar) => (
      bar.time < fill.time && bar.time + bar.step > from
    )).sort((a, b) => a.time - b.time) : [];
    for (const bar of bars) {
      const next = [];
      for (const history of histories) {
        if (history.qty <= 0) { next.push(history); continue; }
        const reference = executionModel === "static" ? history.anchor : history.entry;
        const stopPrice = stop === null ? null : reference * (1 - sim.direction * stop / (100 * sim.leverage));
        const profitPrice = takeProfit === null ? null : reference * (1 + sim.direction * takeProfit / (100 * sim.leverage));
        const stopped = stopPrice !== null && (sim.direction === 1 ? bar.low <= stopPrice : bar.high >= stopPrice);
        const profited = profitPrice !== null && (sim.direction === 1 ? bar.high >= profitPrice : bar.low <= profitPrice);
        const contained = bar.time >= from && bar.time + bar.step <= fill.time;
        if ((!stopped && !profited) || !contained) next.push({ ...history });
        if (stopped) next.push({
          ...history, qty: 0, out: true, stopHits: history.stopHits + 1,
          pnl: history.pnl + (stopPrice - history.entry) * sim.direction * history.qty
        });
        if (profited) next.push({
          ...history, qty: 0, out: true, profitHits: history.profitHits + 1,
          pnl: history.pnl + (profitPrice - history.entry) * sim.direction * history.qty
        });
      }
      histories = next;
    }
    if (fill.entry) leadQty += fill.qty;
    histories = histories.map((prior) => {
      const history = { ...prior };
      if (fill.entry && !(history.out && !follow)) {
        if (history.qty <= 0) history.anchor = fill.price;
        const nextQty = history.qty + fill.qty;
        history.entry = (history.qty * history.entry + fill.qty * fill.price) / nextQty;
        history.qty = nextQty;
        history.out = false;
      } else if (!fill.entry && history.qty > 0) {
        const reduced = history.qty * fill.qty / leadQty;
        history.pnl += (fill.price - history.entry) * sim.direction * reduced;
        history.qty -= reduced;
      }
      return history;
    });
    if (!fill.entry) leadQty -= fill.qty;
  }
  return {
    minimum: Math.min(...histories.map((history) => history.pnl)),
    maximum: Math.max(...histories.map((history) => history.pnl)),
    possible: histories.some((history) => history.stopHits + history.profitHits > 0),
    certain: histories.every((history) => history.stopHits + history.profitHits > 0)
  };
}

function compare(sim, stop, takeProfit, follow, executionModel, label) {
  const oracle = enumerate(sim, stop, takeProfit, follow, executionModel);
  const lower = S.simulateCopier(sim, stop, follow, false, takeProfit, executionModel);
  const upper = S.simulateCopier(sim, stop, follow, true, takeProfit, executionModel);
  near(lower.pnl, oracle.minimum, `${label}, minimum`);
  near(upper.pnl, oracle.maximum, `${label}, maximum`);
  for (const outcome of [lower, upper]) {
    assert.equal(outcome.triggerPossible, oracle.possible, `${label}, any exit possible`);
    assert.equal(outcome.triggerCertain, oracle.certain, `${label}, any exit certain`);
  }
  return { lower, upper };
}

let seed = 1743;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
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
    fills, direction: fixture % 2 ? 1 : -1, leverage: 10,
    candles: Array.from({ length: 4 }, (_, i) => ({
      time: T + i * MINUTE, step: MINUTE,
      high: 105 + Math.floor(random() * 15), low: 80 + Math.floor(random() * 20)
    }))
  };
  for (const follow of [false, true]) {
    for (const executionModel of ["static", "dynamic"]) {
      for (const [stop, takeProfit] of [[null, 30], [30, null], [20, 40], [70, 15]]) {
        compare(sim, stop, takeProfit, follow, executionModel,
          `fixture ${fixture}, side ${sim.direction}, follow ${follow}, ${executionModel}, SL ${stop}, TP ${takeProfit}`);
        checked += 1;
      }
    }
  }
}
assert.equal(checked, 1280);

const simple = (candles, extra = {}) => ({
  direction: 1, leverage: 10,
  fills: [{ time: T, entry: true, qty: 1, price: 100 }, { time: T + 2 * MINUTE, entry: false, qty: 1, price: 90 }],
  candles: candles.map(([high, low], i) => ({ time: T + i * MINUTE, step: MINUTE, high, low })),
  ...extra
});
for (const executionModel of ["static", "dynamic"]) {
  // Both barriers inside one bar have unknown first-hit order, with no no-hit branch when the bar is contained.
  const both = compare(simple([[103, 97], [100, 100]]), 20, 20, false, executionModel, "same-bar competing exits");
  near(both.lower.pnl, -2, "same-bar SL lower bound");
  near(both.upper.pnl, 2, "same-bar TP upper bound");
  assert.equal(both.lower.triggerCertain, true);

  // The earlier contained candle decides the exit before a later candle can reach the other barrier.
  const profitFirst = compare(simple([[104, 99], [101, 95]]), 20, 20, false, executionModel, "TP before later SL");
  near(profitFirst.lower.pnl, 2, "earlier mandatory TP lower");
  near(profitFirst.upper.pnl, 2, "earlier mandatory TP upper");
  const stopFirst = compare(simple([[101, 95], [104, 99]]), 20, 20, false, executionModel, "SL before later TP");
  near(stopFirst.lower.pnl, -2, "earlier mandatory SL lower");
  near(stopFirst.upper.pnl, -2, "earlier mandatory SL upper");

  const disabled = compare(simple([[130, 70], [130, 70]]), null, null, true, executionModel, "both exits disabled");
  near(disabled.lower.pnl, -10, "disabled baseline");
  assert.equal(disabled.lower.triggerPossible, false);
}

// Anchored orders survive adds: entry average moves from 100 to 105, while an initial TP50 order stays at105.
const anchorCase = {
  direction: 1, leverage: 10,
  fills: [
    { time: T, entry: true, qty: 1, price: 100 },
    { time: T + 2 * MINUTE, entry: true, qty: 1, price: 110 },
    { time: T + 4 * MINUTE, entry: false, qty: 2, price: 110 }
  ],
  candles: Array.from({ length: 4 }, (_, i) => ({
    time: T + i * MINUTE, step: MINUTE, high: i < 2 ? 100 : 110, low: i < 2 ? 100 : 110
  }))
};
near(compare(anchorCase, null, 50, false, "static", "static TP anchor survives add").lower.pnl, 0, "anchored exit uses current average");
near(compare(anchorCase, null, 50, false, "dynamic", "dynamic TP moves with average").lower.pnl, 10, "dynamic TP remains unhit");

// A copier-only TP followed by an add leaves the copier smaller than the lead; partial exits copy fractions.
const restartCase = {
  direction: 1, leverage: 10,
  fills: [
    { time: T, entry: true, qty: 10, price: 100 },
    { time: T + 2 * MINUTE, entry: true, qty: 10, price: 90 },
    { time: T + 4 * MINUTE, entry: false, qty: 10, price: 93 },
    { time: T + 6 * MINUTE, entry: false, qty: 10, price: 92 }
  ],
  candles: Array.from({ length: 6 }, (_, i) => ({
    time: T + i * MINUTE, step: MINUTE, high: i === 1 ? 105 : (i < 2 ? 100 : 93), low: i < 2 ? 100 : 90
  }))
};
for (const executionModel of ["static", "dynamic"]) {
  near(compare(restartCase, null, 50, true, executionModel, "TP restart copies partial-close fractions").lower.pnl, 75, "follow TP earns 50 + 15 + 10");
  near(compare(restartCase, null, 50, false, executionModel, "TP stay-out").lower.pnl, 50, "stay-out preserves TP result");
}

const instantaneous = simple([[130, 70]], {
  fills: [{ time: T + MINUTE / 2, entry: true, qty: 1, price: 100 }, { time: T + MINUTE / 2, entry: false, qty: 1, price: 105 }]
});
for (const executionModel of ["static", "dynamic"]) {
  const outcome = compare(instantaneous, 20, 20, true, executionModel, "zero exposure with both barriers crossed");
  near(outcome.lower.pnl, 5, "zero exposure baseline");
  assert.equal(outcome.lower.triggerPossible, false);
}

const selectorRow = (sim, symbol = "X") => ({
  symbol, side: sim.direction === 1 ? "LONG" : "SHORT", leverage: sim.leverage,
  opened: sim.fills[0].time, closed: sim.fills.at(-1).time,
  closingPnl: sim.fills.at(-1).price - sim.fills[0].price,
  maeRoe: 100, mfeRoe: 100, marksUsed: true, marksComplete: true, sim
});

// A known joint optimum at integer levels omitted by the previous 5% grid. These fully contained single-entry
// controls admit no intrabar no-hit reading, and their SL/TP collision is checked by the independent oracle.
const winners = Array.from({ length: 40 }, () => selectorRow(simple([[100.62, 99.64], [100.1, 100.1]], {
  fills: [{ time: T, entry: true, qty: 1, price: 100 }, { time: T + 2 * MINUTE, entry: false, qty: 1, price: 100.1 }]
})));
const losers = Array.from({ length: 3 }, () => selectorRow(simple([[100.42, 99.8], [100, 90]])));
const controls = [...winners, ...losers];
const selection = S.selectExit(controls, null, {
  stopMax: 8, takeProfitMax: 8, executionModel: "static", includeCurve: true, bootstrap: false
});
assert.equal(selection.optimal.stop, 4);
assert.equal(selection.optimal.takeProfit, 6);
near(selection.baselinePnl, -26, "joint control baseline");
near(selection.optimalPnlMin, 22.8, "known joint optimum minimum");
near(selection.optimalPnlMax, 22.8, "known joint optimum maximum");
assert.equal(selection.curve.length, 81, "every allowed SL/TP pair includes disabled alternatives");
const seen = new Set();
for (const point of selection.curve) {
  const key = `${point.stop}/${point.takeProfit}`;
  assert.ok(!seen.has(key), `duplicate joint candidate ${key}`);
  seen.add(key);
  const byFollow = [false, true].map((follow) => controls.map((row) => (
    enumerate(row.sim, point.stop, point.takeProfit, follow, "static")
  )));
  const lower = Math.min(...byFollow.map((results) => results.reduce((sum, result) => sum + result.minimum, 0)));
  const upper = Math.max(...byFollow.map((results) => results.reduce((sum, result) => sum + result.maximum, 0)));
  near(point.pnlMin, lower, `joint candidate ${key}, minimum`);
  near(point.pnlMax, upper, `joint candidate ${key}, maximum`);
}
for (const stop of [null, ...Array.from({ length: 8 }, (_, i) => i + 1)]) {
  for (const takeProfit of [null, ...Array.from({ length: 8 }, (_, i) => i + 1)]) {
    assert.ok(seen.has(`${stop}/${takeProfit}`), `missing joint candidate ${stop}/${takeProfit}`);
  }
}

// Identical PnL over the whole policy domain preserves the complete tie set; disabled SL/TP is a valid optimum.
const tiedRows = Array.from({ length: 3 }, () => selectorRow(simple([[100, 100], [100, 100]], {
  fills: [{ time: T, entry: true, qty: 1, price: 100 }, { time: T + 2 * MINUTE, entry: false, qty: 1, price: 100 }]
})));
const tied = S.selectExit(tiedRows, null, { stopMax: 3, takeProfitMax: 3, includeCurve: true, bootstrap: false });
assert.equal(tied.optimal.stop, null);
assert.equal(tied.optimal.takeProfit, null);
assert.equal(tied.optima.length, 16);

// Incomplete inventory, invalid lead quantity and missing MARK intervals cannot produce a joint recommendation.
const missingClose = controls.slice(0, 3).map((row) => ({
  ...row, sim: { ...row.sim, fills: row.sim.fills.slice(0, 1) }
}));
assert.equal(S.selectExit(missingClose, null, { stopMax: 3, takeProfitMax: 3, bootstrap: false }), null);
const overClose = controls.slice(0, 3).map((row) => ({
  ...row, sim: { ...row.sim, fills: [row.sim.fills[0], { ...row.sim.fills[1], qty: 2 }] }
}));
assert.equal(S.selectExit(overClose, null, { stopMax: 3, takeProfitMax: 3, bootstrap: false }), null);
const gap = controls.slice(0, 3).map((row) => ({
  ...row, sim: { ...row.sim, candles: row.sim.candles.slice(0, 1) }
}));
assert.equal(S.selectExit(gap, null, { stopMax: 3, takeProfitMax: 3, bootstrap: false }), null);

const cloneRows = (rows) => rows.map((row) => ({
  ...row, sim: { ...row.sim, fills: row.sim.fills.map((fill) => ({ ...fill })), candles: row.sim.candles.map((bar) => ({ ...bar })) }
}));
const corruptions = [];
for (const value of [NaN, Infinity, -Infinity]) {
  for (const field of ["price", "qty", "time"]) {
    corruptions.push({ label: `nonfinite fill ${field}: ${value}`, corrupt: (sim) => { sim.fills[0][field] = value; } });
  }
  corruptions.push({ label: `nonfinite leverage: ${value}`, corrupt: (sim) => { sim.leverage = value; } });
  for (const field of ["high", "low", "time", "step"]) {
    corruptions.push({ label: `nonfinite candle ${field}: ${value}`, corrupt: (sim) => { sim.candles[0][field] = value; } });
  }
}
corruptions.push({ label: "inverted candle extrema", corrupt: (sim) => { sim.candles[0].high = 99; sim.candles[0].low = 100; } });
corruptions.push({ label: "zero candle duration", corrupt: (sim) => { sim.candles[0].step = 0; } });
for (const { label, corrupt } of corruptions) {
  const damaged = cloneRows(controls.slice(0, 3));
  for (const row of damaged) corrupt(row.sim);
  const options = { stopMax: 3, takeProfitMax: 3, bootstrap: false };
  assert.equal(S.selectExit(damaged, null, options), null, `${label} rejects recommendation`);
  for (let i = 0; i < damaged.length; i += 1) damaged[i].sim = cloneRows(controls.slice(i, i + 1))[0].sim;
  assert.ok(S.selectExit(damaged, null, options), `${label} recovers when authoritative values return`);
}

// At 1x a short TP of100% would require price0, and a larger TP would require a negative price. Positive MARK
// candles cannot trigger those orders. The adjacent physically possible99% boundary remains executable.
const shortFloor = simple([[100, 1], [100, 90]], {
  direction: -1, leverage: 1,
  fills: [{ time: T, entry: true, qty: 1, price: 100 }, { time: T + 2 * MINUTE, entry: false, qty: 1, price: 90 }]
});
for (const takeProfit of [100, 200, 2000]) {
  for (const executionModel of ["static", "dynamic"]) {
    const outcome = compare(shortFloor, null, takeProfit, false, executionModel, `nonpositive short TP${takeProfit}`);
    near(outcome.lower.pnl, 10, "nonpositive short TP preserves lead exit");
    assert.equal(outcome.lower.triggerPossible, false);
    assert.equal(outcome.lower.profitTriggers, 0);
  }
}
near(compare(shortFloor, null, 99, false, "static", "positive short TP boundary").lower.pnl, 99, "positive TP at price1 triggers");

// Closed-form oracle for fully contained, disjoint single-entry candles. It converts each bar to adverse and
// favorable margin returns, chooses the first bar crossing either level, and evaluates both first-hit outcomes
// only when that same bar reaches both. This shares neither production DP, prefix search nor never-hit cache.
function singleEntryBounds(sim, stop, takeProfit) {
  const entry = sim.fills[0].price;
  const qty = sim.fills[0].qty;
  const margin = qty * entry / sim.leverage;
  for (const bar of sim.candles) {
    const adverse = (sim.direction === 1 ? entry - bar.low : bar.high - entry) / entry * sim.leverage * 100;
    const favorable = (sim.direction === 1 ? bar.high - entry : entry - bar.low) / entry * sim.leverage * 100;
    const stopped = stop !== null && adverse >= stop;
    const profited = takeProfit !== null && takeProfit < 100 * sim.leverage && favorable >= takeProfit;
    // A long target remains positive at any supported ROI, unlike the short price floor.
    const profitHit = sim.direction === 1 && takeProfit !== null ? favorable >= takeProfit : profited;
    if (stopped || profitHit) {
      const possible = [];
      if (stopped) possible.push(-stop / 100 * margin);
      if (profitHit) possible.push(takeProfit / 100 * margin);
      return { minimum: Math.min(...possible), maximum: Math.max(...possible) };
    }
  }
  const pnl = (sim.fills.at(-1).price - entry) * sim.direction * qty;
  return { minimum: pnl, maximum: pnl };
}

assert.equal(S.TAKE_PROFIT_MAX, 2000);
const FULL_DOMAIN = 96 * 2001;
function checkFullDomain(rows, label, options = {}) {
  const result = S.selectExit(rows, null, { includeCurve: true, bootstrap: false, ...options });
  assert.equal(result.curve.length, FULL_DOMAIN, `${label}, supported grid size`);
  assert.equal(result.search.fullDomain, FULL_DOMAIN, `${label}, certificate covers full grid`);
  assert.equal(result.search.certified, true, `${label}, completed refinement certificate`);
  let best = -Infinity;
  let ties = 0;
  for (let i = 0; i < FULL_DOMAIN; i += 1) {
    const stop = Math.floor(i / 2001) || null;
    const takeProfit = i % 2001 || null;
    const point = result.curve[i];
    assert.equal(point.stop, stop, `${label}, stop identity ${i}`);
    assert.equal(point.takeProfit, takeProfit, `${label}, TP identity ${i}`);
    let minimum = 0;
    let maximum = 0;
    for (const row of rows) {
      const value = singleEntryBounds(row.sim, stop, takeProfit);
      minimum += value.minimum;
      maximum += value.maximum;
    }
    near(point.pnlMin, minimum, `${label}, candidate ${stop}/${takeProfit}, minimum`);
    near(point.pnlMax, maximum, `${label}, candidate ${stop}/${takeProfit}, maximum`);
    near(point.score, minimum, `${label}, historical PnL objective`);
    if (minimum > best + 1e-8) { best = minimum; ties = 1; }
    else if (Math.abs(minimum - best) <= 1e-8) ties += 1;
  }
  near(result.optimalPnlMin, best, `${label}, independent global optimum`);
  assert.equal(result.optima.length, ties, `${label}, preserves all globally tied pairs`);
  return result;
}

// Interior optimum over the actual supported domain: belowSL37 winners stop prematurely; aboveTP20 the
// winners'20.6% favorable excursion is missed. Losses reachTP10 first or a later severe adverse candle.
const interiorRows = [
  ...Array.from({ length: 40 }, () => selectorRow(simple([[102.06, 96.38], [100.1, 100.1]], {
    fills: [{ time: T, entry: true, qty: 1, price: 100 }, { time: T + 2 * MINUTE, entry: false, qty: 1, price: 100.1 }]
  }))),
  ...Array.from({ length: 3 }, () => selectorRow(simple([[101, 100], [100, 85]], {
    fills: [{ time: T, entry: true, qty: 1, price: 100 }, { time: T + 2 * MINUTE, entry: false, qty: 1, price: 85 }]
  })))
];
const interior = checkFullDomain(interiorRows, "SL37/TP20 interior control", { capital: 1000 });
assert.equal(interior.optimal.stop, 37);
assert.equal(interior.optimal.takeProfit, 20);
near(interior.baselinePnl, -41, "interior baseline");
near(interior.optimalPnlMin, 68.9, "interior optimum price PnL");
near(interior.roiMin, 6.89, "fixed capital ROI denominator");
near(interior.baselineRoi, -4.1, "baseline uses same fixed capital");
const differentCapital = S.selectExit(interiorRows, null, { capital: 1000000, bootstrap: false });
assert.equal(differentCapital.optimal.stop, interior.optimal.stop);
assert.equal(differentCapital.optimal.takeProfit, interior.optimal.takeProfit);
near(differentCapital.roiMin, 0.00689, "rescaling fixed capital changes ROI but not optimal pair");
const unknownCapital = S.selectExit(interiorRows, null, { bootstrap: false });
assert.equal(unknownCapital.capital, null);
assert.equal(unknownCapital.roiMin, null, "unknown capital cannot invent an account ROI");

// Deterministic unlabeled controls cover directions, sizes, leverage and three successive bars without a
// chosen optimum. Every full-domain score is compared with the independent first-cross calculation.
let controlSeed = 20261003;
const controlRandom = () => {
  controlSeed = (Math.imul(controlSeed, 1664525) + 1013904223) >>> 0;
  return controlSeed / 4294967296;
};
const unlabelledRows = Array.from({ length: 9 }, (_, i) => {
  const entry = 80 + 5 * i;
  const leverage = 1 + i % 5;
  const qty = 1 + i % 3;
  const opened = T + i * 4 * MINUTE;
  const candles = Array.from({ length: 3 }, (_, j) => ({
    time: opened + j * MINUTE, step: MINUTE,
    high: entry * (1 + 0.002 + controlRandom() * 0.055),
    low: entry * (1 - 0.002 - controlRandom() * 0.055)
  }));
  const exit = (candles.at(-1).high + candles.at(-1).low) / 2;
  return selectorRow({ direction: i % 2 ? 1 : -1, leverage, candles,
    fills: [{ time: opened, entry: true, qty, price: entry }, { time: opened + 3 * MINUTE, entry: false, qty, price: exit }]
  }, `CONTROL${i}`);
});
checkFullDomain(unlabelledRows, "unlabelled closed-form controls");

// A never-hit equivalence class expands to all192,096 supported pairs, including the entire exact tie set.
const fullTies = S.selectExit(tiedRows, null, { includeCurve: true, bootstrap: false });
assert.equal(fullTies.search.certified, true);
assert.equal(fullTies.search.fullDomain, FULL_DOMAIN);
assert.equal(fullTies.search.distinctEvaluations, 4, "flat history certifies the full grid from four never-hit classes");
assert.equal(fullTies.optima.length, FULL_DOMAIN);
assert.equal(fullTies.curve.length, FULL_DOMAIN);
assert.equal(fullTies.optimal.stop, null);
assert.equal(fullTies.optimal.takeProfit, null);
assert.equal(fullTies.optima.at(-1).stop, 95);
assert.equal(fullTies.optima.at(-1).takeProfit, 2000);
assert.ok(fullTies.curve.every((point) => point.pnlMin === 0 && point.pnlMax === 0 && point.triggered === 0));

console.log("PASS: 1280 independent joint replay comparisons; first-hit/static anchors/reentry; full192096 grids and interior optimum; fixed-capital ROI; never-hit ties; nonfinite/invalid-data rejection and recovery");
