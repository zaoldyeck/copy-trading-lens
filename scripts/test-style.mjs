// Unit tests for src/style.js — trading style read from position episodes.
// Each fixture is built from the textbook formula it names, so a failure
// means the classifier no longer recognises the formula, not that a sample
// drifted. The one-way flip case replays real fills from a public lead
// portfolio whose flip was dropped by the first style rebuild.
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
for (const file of ["positions.js", "style.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), sandbox, { filename: file });
}
const Style = sandbox.CopyTradingLensStyle;

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok   ${name}`);
}

const HOUR = 3600 * 1000;
const START = Date.UTC(2026, 6, 1);
function orderAt(t, symbol, side, positionSide, qty, price, pnl = 0, type = "LIMIT") {
  return { symbol, side, positionSide, executedQty: qty, avgPrice: price, totalPnl: pnl, orderTime: t, orderUpdateTime: t, type };
}
const round = (value) => Math.round(value * 1e8) / 1e8;

// Long grid: levels every `step` from `low`, `lot` per level; price walks a
// saw-tooth, buying a level on the way down and selling it one level up.
function gridOrders({ symbol = "ETCUSDT", low = 7, step = 0.1, levels = 8, lot = 3, cycles = 12, lotAfter = null, hoursPerFill = 2 }) {
  const orders = [];
  let t = START;
  for (let c = 0; c < cycles; c += 1) {
    const size = lotAfter && c >= cycles / 2 ? lotAfter : lot;
    for (let i = levels - 1; i >= 1; i -= 1) {
      t += hoursPerFill * HOUR;
      orders.push(orderAt(t, symbol, "BUY", "LONG", size, round(low + (i - 1) * step)));
    }
    for (let i = 1; i < levels; i += 1) {
      t += hoursPerFill * HOUR;
      orders.push(orderAt(t, symbol, "SELL", "LONG", size, round(low + i * step), size * step));
    }
  }
  return orders;
}

// Martingale: each add is `multiplier` times the previous, 1% further against,
// then the whole position exits 0.5% above the average.
function martingaleOrders({ symbol = "HYPEUSDT", multiplier = 2, layers = 5, episodes = 20, base = 1, price = 60, linear = false }) {
  const orders = [];
  let t = START;
  for (let e = 0; e < episodes; e += 1) {
    let qty = base;
    let held = 0;
    let cost = 0;
    for (let k = 0; k < layers; k += 1) {
      t += HOUR;
      const p = round(price * (1 - 0.01 * k));
      orders.push(orderAt(t, symbol, "BUY", "LONG", round(qty), p));
      held += qty;
      cost += qty * p;
      qty = linear ? qty + base : qty * multiplier;
    }
    t += 4 * HOUR;
    orders.push(orderAt(t, symbol, "SELL", "LONG", round(held), round((cost / held) * 1.005), cost * 0.005));
  }
  return orders;
}

// Averaging in with equal adds 2% apart; `losers` of the episodes are closed below cost.
function averagingOrders({ symbol = "SOLUSDT", episodes = 20, losers = 0 }) {
  const orders = [];
  let t = START;
  for (let e = 0; e < episodes; e += 1) {
    const price = 80;
    for (let k = 0; k < 4; k += 1) {
      t += 3 * HOUR;
      orders.push(orderAt(t, symbol, "BUY", "LONG", 10, round(price * (1 - 0.02 * k))));
    }
    t += 6 * HOUR;
    const losing = e < losers;
    const exit = losing ? price * 0.9 : price * 1.01;
    orders.push(orderAt(t, symbol, "SELL", "LONG", 40, round(exit), losing ? -300 : 60));
  }
  return orders;
}

// A discretionary trader who fires one decision as five market clips seconds
// apart at jittered prices, then holds for two days and exits once.
function slicedOrders({ symbol = "BTCUSDT", episodes = 12 }) {
  const orders = [];
  let t = START;
  for (let e = 0; e < episodes; e += 1) {
    const price = 60000 + e * 300;
    const jitter = [0, 3, -2, 5, 1];
    for (let k = 0; k < 5; k += 1) {
      t += 5000;
      orders.push(orderAt(t, symbol, "BUY", "BOTH", 0.3, price + jitter[k], 0, "MARKET"));
    }
    t += 48 * HOUR;
    orders.push(orderAt(t, symbol, "SELL", "BOTH", 1.5, price * (e % 3 === 0 ? 0.98 : 1.03), e % 3 === 0 ? -900 : 1350, "MARKET"));
  }
  return orders;
}

// Grid on a lattice that follows price: short a lot, cover it
// one step lower, short again at the covered price, walking down and back.
function movingGridOrders({ symbol = "SATSUSDT", step = 0.009, cycles = 60, lot = 1000 }) {
  const orders = [];
  let t = START;
  let price = 10;
  for (let c = 0; c < cycles; c += 1) {
    const direction = c % 20 < 10 ? -1 : 1;
    t += 2 * HOUR;
    orders.push(orderAt(t, symbol, "SELL", "SHORT", lot, round(price)));
    t += HOUR;
    orders.push(orderAt(t, symbol, "BUY", "SHORT", lot, round(price * (1 - step)), lot * price * step));
    price = direction < 0 ? price * (1 - step) : price * (1 + step);
  }
  return orders;
}

// An evenly spaced ladder placed once per position and closed level by level,
// never re-entering a level: averaging in, not a grid.
function oneShotLadderOrders({ symbol = "BTWUSDT", episodes = 10 }) {
  const orders = [];
  let t = START;
  for (let e = 0; e < episodes; e += 1) {
    const base = 1 + e * 0.5;
    for (let k = 0; k < 6; k += 1) {
      t += 60 * 1000;
      orders.push(orderAt(t, symbol, "SELL", "SHORT", 200, round(base * (1 + 0.02 * k))));
    }
    for (let k = 5; k >= 0; k -= 1) {
      t += 2 * HOUR;
      orders.push(orderAt(t, symbol, "BUY", "SHORT", 200, round(base * (1 + 0.02 * k) * 0.98), 4));
    }
    t += 12 * HOUR;
  }
  return orders;
}

test("a textbook grid is a grid", () => {
  assert.equal(Style.classify(gridOrders({})).family, "grid");
});

test("a grid that changes its lot halfway is still a grid", () => {
  assert.equal(Style.classify(gridOrders({ lotAfter: 5 })).family, "grid");
});

test("a grid on a lattice that follows price is a grid", () => {
  assert.equal(Style.classify(movingGridOrders({})).family, "grid");
});

test("an evenly spaced ladder that never re-enters a level is not a grid", () => {
  const result = Style.classify(oneShotLadderOrders({}));
  assert.notEqual(result.family, "grid");
  assert.equal(result.evidence.gridBooks, 0);
});

test("an evenly spaced book traded again only a few times is not a grid", () => {
  // 5 cycles over 4 levels: 12 re-entries, under the 15 a grid has to show
  const result = Style.classify(gridOrders({ cycles: 5, levels: 4, hoursPerFill: 8 }));
  assert.notEqual(result.family, "insufficient", "the fixture must reach the grid test");
  assert.equal(result.evidence.gridBooks, 0);
});

test("a doubling martingale is a martingale", () => {
  const result = Style.classify(martingaleOrders({}));
  assert.equal(result.family, "martingale");
  assert.ok(Math.abs(result.evidence.multiplierMedian - 2) < 0.05, `multiplier ${result.evidence.multiplierMedian}`);
});

test("a x1.45 martingale is a martingale", () => {
  assert.equal(Style.classify(martingaleOrders({ multiplier: 1.45, layers: 8 })).family, "martingale");
});

test("a linear ramp (constant step in size) is not a martingale", () => {
  const result = Style.classify(martingaleOrders({ linear: true, layers: 7 }));
  assert.notEqual(result.family, "martingale");
  assert.equal(result.family, "dcaNoStop");
});

test("equal adds against the position without realised losses average in without stops", () => {
  assert.equal(Style.classify(averagingOrders({})).family, "dcaNoStop");
});

test("equal adds against the position with realised losses average in with stops", () => {
  assert.equal(Style.classify(averagingOrders({ losers: 5 })).family, "dcaWithStop");
});

test("one decision sliced into market clips is neither a grid nor a martingale", () => {
  const result = Style.classify(slicedOrders({}));
  assert.equal(result.family, "swing");
});

test("too few closed positions is insufficient, not a style", () => {
  assert.equal(Style.classify(averagingOrders({ episodes: 3 })).family, "insufficient");
});

test("more exits of unseen positions than positions seen whole is insufficient", () => {
  const orders = averagingOrders({ episodes: 6 });
  let t = START - 30 * 24 * HOUR;
  for (let k = 0; k < 7; k += 1) {
    t += HOUR;
    orders.push(orderAt(t + 40 * 24 * HOUR, "ETHUSDT", "SELL", "LONG", 1, 2000, 10));
  }
  const result = Style.classify(orders);
  assert.equal(result.evidence.orphanExits, 7);
  assert.equal(result.family, "insufficient");
});

test("a one-way fill larger than the position closes it and opens the rest on the other side", () => {
  // HYPEUSDT, one-way mode: long 2.64 + 4.73, then a 15.81 sell.
  const orders = [
    orderAt(1, "HYPEUSDT", "BUY", "BOTH", 2.64, 64.577),
    orderAt(2, "HYPEUSDT", "BUY", "BOTH", 4.73, 62.751),
    orderAt(3, "HYPEUSDT", "SELL", "BOTH", 15.81, 61.919, -3.10327999),
    orderAt(4, "HYPEUSDT", "BUY", "BOTH", 8.44, 60.989)
  ];
  const { episodes, orphanExits } = Style.buildEpisodes(orders);
  assert.equal(orphanExits, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(episodes.map((e) => [e.direction, e.closed, e.entries.map((f) => f.qty), e.exits.map((f) => f.qty)]))), [
    ["LONG", true, [2.64, 4.73], [7.37]],
    ["SHORT", true, [8.44], [8.44]]
  ]);
  assert.equal(episodes[0].pnl, -3.10327999, "the realised pnl stays with the closing part");
  assert.equal(episodes[1].exits[0].pnl, 0);
});

test("a hedge-mode close larger than its book never flips", () => {
  const orders = [
    orderAt(1, "ETHUSDT", "BUY", "LONG", 1, 2000),
    orderAt(2, "ETHUSDT", "SELL", "LONG", 3, 2100, 100)
  ];
  const { episodes, orphanExits } = Style.buildEpisodes(orders);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].direction, "LONG");
  assert.equal(orphanExits, 1, "the excess is volume opened before the history we hold");
});

console.log(`${passed}/${passed} passed`);
