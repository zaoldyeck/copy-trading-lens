import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
let ticks = 0;
const context = vm.createContext({ window: {}, setTimeout, Date: class extends Date { static now() { return ++ticks * 9; } } });
for (const file of ['positions', 'stoploss']) vm.runInContext(fs.readFileSync(new URL(`../src/${file}.js`, import.meta.url), 'utf8'), context);
const S = context.window.CopyTradingLensStopLoss;
const T = 1000000; const M = 60000;
const rows = Array.from({ length: 3 }, (_, i) => ({ opened: T, symbol: String(i), marksUsed: true, marksComplete: true,
  sim: { direction: 1, leverage: 10,
    fills: [{ time: T, entry: true, price: 100, qty: 1 }, { time: T + M, entry: false, price: 101, qty: 1 }],
    candles: [{ time: T, step: M, high: 101, low: 99 }] } }));
const options = { stopMax: 2, takeProfitMax: 2 };
const sync = S.selectExit(rows, null, options);
let resume; let progress = 0;
const gate = new Promise((resolve) => { resume = resolve; });
const pending = S.selectExitAsync(rows, null, { ...options, waitUntilResumed: () => gate, onProgress: () => { progress++; } });
await Promise.resolve(); assert.equal(progress, 0, 'a paused search starts no work');
resume();
const asyncResult = await pending;
assert.ok(progress > 0, 'browser core yields and reports progress');
assert.deepEqual(JSON.parse(JSON.stringify(asyncResult)), JSON.parse(JSON.stringify(sync)), 'same deterministic core');
let cancel = false;
await assert.rejects(S.selectExitAsync(rows, null, { ...options, isCancelled: () => cancel, onProgress: () => { cancel = true; } }), /superseded/);
await assert.rejects(S.selectExitAsync(rows, null, { ...options, isCancelled: () => true }), /superseded/);
// A training winner can lose on untouched later trades; never use the heldout optimum to pick it.
const dated = Array.from({ length: 6 }, (_, i) => {
  const opened = T + i * 3 * M; const closed = opened + M;
  return { opened, closed, symbol: String(i), marksUsed: true, marksComplete: true,
    sim: { direction: 1, leverage: 10,
      fills: [{ time: opened, entry: true, price: 100, qty: 1 }, { time: closed, entry: false, price: i < 3 ? 101 : 105, qty: 1 }],
      candles: [{ time: opened, step: M, high: i < 3 ? 102 : 106, low: 100 }] } };
});
const checked = await S.selectExitAsync(dated, null, { stopMax: 2, takeProfitMax: 60, withHoldout: true });
assert.equal(checked.optimal.takeProfit, 60, 'full-sample policy has seen later outcomes');
assert.equal(checked.holdout.trainOptimal.takeProfit, 20, 'training choice knows only preceding trades');
assert.ok(Math.abs(checked.holdout.fixed.deltaMin + 9) < 1e-8, 'the frozen training policy fails in untouched later history');
assert.equal(checked.holdout.heldoutUsedForSelection, false);
assert.equal(checked.holdout.trainPositions, 3); assert.equal(checked.holdout.testPositions, 3);
const split = S.chronologicalExitHoldout(dated, { stopMax: 2, takeProfitMax: 60 });
assert.deepEqual(JSON.parse(JSON.stringify(split)), JSON.parse(JSON.stringify(checked.holdout)));
assert.equal(S.chronologicalExitHoldout(rows).insufficientData, true);
const rawContent = fs.readFileSync(new URL('../src/content.js', import.meta.url), 'utf8');
const progressiveStart = rawContent.indexOf('onProgressive: (event)');
const progressive = rawContent.slice(progressiveStart, rawContent.indexOf('      if (superseded()) return;\n      const exitEngine', progressiveStart));
assert.ok(!progressive.includes('selectExitAsync'), 'progressive stages do not duplicate the grid');
assert.ok(rawContent.includes('isCancelled: superseded'));
assert.ok(rawContent.includes('waitUntilResumed: () => current.fetchControl.waitUntilResumed()'));
assert.ok(fs.readFileSync(new URL('../src/analysis.js', import.meta.url), 'utf8').includes('raw.exitSelection || null'));
console.log('PASS: shared async/sync exit core, pause before start, cooperative yielding, superseded cancellation and final-data wiring');
