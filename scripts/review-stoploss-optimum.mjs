// Reproduce the production stop selector on canonical cached snapshots and an untouched chronological holdout.
// Usage: node scripts/review-stoploss-optimum.mjs [portfolioId ...] [--output reports/stoploss-optimum.json]
// This script reads local files only. Market-data download/refresh is a separate, explicitly observable operation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = path.join(ROOT, "tools");
const MINUTE = 60000;
const DOMAIN = [null, ...Array.from({ length: 95 }, (_, i) => i + 1)];
const DEFAULT_IDS = ["4908633203782592768", "5131925334830383361", "5075281354358777856"];
const sandbox = { console };
sandbox.window = sandbox;
// Compile trusted local production source in the host realm. Contextified VM globals add proxy
// callbacks to every Math/Map access in the hot DAG and do not model browser execution cost.
for (const file of ["positions", "equity", "stoploss"]) {
  vm.compileFunction(fs.readFileSync(path.join(ROOT, "src", `${file}.js`), "utf8"), ["window"])(sandbox);
}
const S = sandbox.CopyTradingLensStopLoss;
const P = sandbox.CopyTradingLensPositions;

function snapshotNowMs(raw, fillTimeOf) {
  if (raw.marketHistory?.nowMs > 0) return raw.marketHistory.nowMs;
  const chart = raw.performanceWindows?.["7D"]?.chartItems || [];
  return Math.max(0, ...(raw.orderHistory || []).map(fillTimeOf), ...chart.map((point) => Number(point.dateTime) || 0));
}

function marketHistoryFor(base, raw, nowMs) {
  const symbols = {};
  const names = new Set([...(raw.orderHistory || []).map((order) => order.symbol), ...(raw.positionHistory || []).filter((row) => !row.closed).map((row) => row.symbol)]);
  for (const name of names) {
    const file = path.join(base, "cache", "market", `${name}.json`);
    if (!fs.existsSync(file)) continue;
    const history = JSON.parse(fs.readFileSync(file, "utf8"));
    symbols[name] = {
      funding: (history.funding || []).filter(([time]) => time <= nowMs),
      marks: (history.marks || []).filter(([time]) => time <= nowMs)
    };
  }
  return { nowMs, symbols };
}
const args = process.argv.slice(2);
const ids = [];
let output = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--output") {
    assert.ok(args[i + 1] && !args[i + 1].startsWith("--"), "--output requires a file path");
    output = path.resolve(args[++i]);
  } else {
    assert.match(args[i], /^\d+$/, "only portfolio IDs and --output are accepted");
    ids.push(args[i]);
  }
}
if (!ids.length) ids.push(...DEFAULT_IDS);
assert.deepEqual(Array.from(S.STOP_CANDIDATES), DOMAIN.slice(1), "production must evaluate every integer stop from 1 through 95");

const total = (values) => values.reduce((sum, value) => sum + value, 0);
const extent = (values) => values.reduce((range, value) => [Math.min(range[0], value), Math.max(range[1], value)], [Infinity, -Infinity]);
const iso = (time) => Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
const near = (actual, expected, label) => {
  if (actual === expected) return;
  assert.ok(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)), `${label}: ${actual} != ${expected}`);
};
const clean = (value) => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "number" && !Number.isFinite(item) ? String(item) : item));
const receipt = (file) => {
  const bytes = fs.readFileSync(file);
  const stat = fs.statSync(file);
  return {
    path: path.relative(ROOT, file), bytes: bytes.length, mtime: stat.mtime.toISOString(),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex")
  };
};
const scoreTies = (curve) => {
  const best = Math.max(...curve.map((point) => point.score));
  return curve.filter((point) => point.score === best || (Number.isFinite(point.score) && Number.isFinite(best) && Math.abs(point.score - best) <= 1e-12)).map((point) => point.stop);
};
const serialSelection = (selection) => {
  if (!selection) return null;
  const visible = Object.fromEntries(Object.entries(selection).filter(([key]) => !key.startsWith("_")));
  return { ...visible, independentlyCalculatedScoreTies: scoreTies(selection.curve) };
};

function marksFromWindows(windows, cutoff) {
  const perSymbol = new Map();
  let sourceRows = 0;
  let duplicateRows = 0;
  let afterCutoffRows = 0;
  for (const [key, rows] of Object.entries(windows)) {
    const symbol = key.split("|")[0];
    assert.ok(symbol && Array.isArray(rows), `invalid mark window ${key}`);
    if (!perSymbol.has(symbol)) perSymbol.set(symbol, new Map());
    const candles = perSymbol.get(symbol);
    for (const row of rows) {
      sourceRows += 1;
      const [time, high, low] = [Number(row[0]), Number(row[2]), Number(row[3])];
      assert.ok(Number.isFinite(time) && time > 0 && Number.isFinite(high) && Number.isFinite(low) && high >= low && low > 0, `invalid real candle in ${key}`);
      if (time > cutoff) { afterCutoffRows += 1; continue; }
      const previous = candles.get(time);
      if (previous) {
        assert.ok(previous[1] === high && previous[2] === low, `conflicting canonical candle ${symbol} ${time}`);
        duplicateRows += 1;
      } else candles.set(time, [time, high, low]);
    }
  }
  const symbols = Object.fromEntries([...perSymbol].map(([symbol, candles]) => [symbol, { minutes: [...candles.values()].sort((a, b) => a[0] - b[0]), hours: [] }]));
  const unique = Object.values(symbols).flatMap((item) => item.minutes);
  const [firstTime, lastTime] = extent(unique.map((row) => row[0]));
  return {
    marks: { symbols, failed: [] },
    audit: {
      windows: Object.keys(windows).length, symbols: Object.keys(symbols).length, sourceRows, uniqueRows: unique.length,
      duplicateRows, afterCutoffRows, firstCandle: iso(firstTime), lastCandleOpen: iso(lastTime)
    }
  };
}

function accountOf(raw, nowMs) {
  const embedded = raw.marketHistory?.symbols ? raw.marketHistory : null;
  const market = embedded ? { ...embedded, nowMs } : marketHistoryFor(TOOLS, raw, nowMs);
  const flows = (raw.transferHistory || [])
    .filter((item) => String(item.coin || "USDT").toUpperCase() === "USDT")
    .map((item) => {
      const type = String(item.transType || "").toUpperCase();
      const deposit = (type.includes("DEPOSIT") || type.includes("INVEST")) && !type.includes("FEE");
      return { time: Number(item.time), amount: deposit ? Math.abs(Number(item.amount)) : type.includes("WITHDRAW") ? -Math.abs(Number(item.amount)) : 0 };
    }).filter((flow) => flow.time > 0 && flow.amount !== 0);
  const equity = sandbox.CopyTradingLensEquity.equityCountBack({
    orders: raw.orderHistory || [], positionHistory: raw.positionHistory || [], flows,
    marginBalance: Number(raw.detail?.marginBalance), market
  });
  return {
    equity,
    audit: {
      source: embedded ? "raw.marketHistory" : "canonical per-symbol market cache", nowMs, cutoff: iso(nowMs),
      marketSymbols: Object.keys(market.symbols || {}).length, marketFailed: market.failed || [],
      reconstructed: !!equity, unpriced: equity?.unpriced || [], feeRate: equity?.feeRate ?? null,
      feeCalibrationRows: equity?.feeRows ?? 0
    }
  };
}

function tradeoff(selection, stop) {
  if (!selection) return null;
  const index = selection._candidates.indexOf(stop);
  assert.ok(index >= 0, `fixed stop ${stop} missing from production selection`);
  const money = selection._pnl.map((scenario) => total(scenario[index]));
  const noStop = total(selection._pnl[0][0]);
  const worse = money.indexOf(Math.min(...money));
  const differences = selection._pnl[worse][index].map((pnl, i) => pnl - selection._pnl[worse][0][i]);
  return {
    stop, positions: selection._sims.length, objectiveScore: selection.curve[index].score,
    triggered: selection.curve[index].triggered, triggeredMin: selection.curve[index].triggeredMin,
    pnlNone: noStop, pnlStayOut: money[0], pnlFollow: money[1], scenarioPnls: money,
    worstReadingDelta: Math.min(...money) - noStop, bestReadingDelta: Math.max(...money) - noStop,
    helped: differences.filter((delta) => delta > 1e-9).length, hurt: differences.filter((delta) => delta < -1e-9).length,
    helpedUsdt: total(differences.filter((delta) => delta > 1e-9)), hurtUsdt: total(differences.filter((delta) => delta < -1e-9))
  };
}

function coverage(rows, selection, rawCount) {
  const eligible = new Set(selection?._sims || []);
  const reasons = {};
  const excluded = [];
  for (const row of rows) {
    if (eligible.has(row)) continue;
    const reported = row.exclusionReasons || row.simulationExclusionReasons || row.sim?.exclusionReasons || [];
    const why = Array.isArray(reported) && reported.length ? reported : [!row.sim ? "missing_or_unmatched_replay" : !row.marksUsed ? "missing_marks" : row.marksComplete === false ? "incomplete_mark_life_coverage" : "production_eligibility_check"];
    for (const reason of why) reasons[reason] = (reasons[reason] || 0) + 1;
    excluded.push({ symbol: row.symbol, opened: iso(row.opened), closed: iso(row.closed), reasons: why });
  }
  return {
    rawPositionRows: rawCount, closedValidRows: rows.length, rowsWithMarks: rows.filter((row) => row.marksUsed).length,
    rowsWithEntryReplay: rows.filter((row) => row.entryPathUsed).length, rowsWithContinuousMarks: rows.filter((row) => row.marksComplete).length,
    selectedSimulationRows: eligible.size,
    simulationCoverage: rows.length ? eligible.size / rows.length : 0, excludedReasonCounts: reasons,
    invalidOrOpenRows: rawCount - rows.length, excluded
  };
}

function fixedPriceEvaluation(rows, stops) {
  const candidates = [...new Set([null, ...stops])];
  const scenarios = [
    { follow: false, optimisticTiming: false }, { follow: true, optimisticTiming: false },
    { follow: false, optimisticTiming: true }, { follow: true, optimisticTiming: true }
  ];
  const outcomes = scenarios.map(({ follow, optimisticTiming }) => candidates.map((stop) => rows.map((row) => S.simulateCopier(row.sim, stop, follow, optimisticTiming))));
  const pnl = outcomes.map((byCandidate) => byCandidate.map((byPosition) => byPosition.map((result) => result.pnl)));
  return {
    _candidates: candidates, _sims: rows, _pnl: pnl, _outcomes: outcomes,
    curve: candidates.map((stop, c) => {
      const totals = pnl.map((byCandidate) => total(byCandidate[c]));
      const triggers = outcomes.map((byCandidate) => byCandidate[c].filter((result) => result.triggerPossible).length);
      return { stop, score: Math.min(...totals) / rows.length, pnlStayOut: totals[0], pnlFollow: totals[1], pnlMin: Math.min(...totals), pnlMax: Math.max(...totals), triggered: Math.max(...triggers), triggeredMin: Math.min(...outcomes.map((byCandidate) => byCandidate[c].filter((result) => result.triggerCertain).length)) };
    })
  };
}

function holdout(rows) {
  const full = S.selectStop(rows, null);
  const chronological = [...(full?._sims || [])].sort((a, b) => a.opened - b.opened || a.closed - b.closed || a.symbol.localeCompare(b.symbol));
  if (chronological.length < 6) return { insufficientData: true, eligibleRows: chronological.length };
  const cutoff = chronological[Math.floor(chronological.length / 2)].opened;
  const train = chronological.filter((row) => row.opened < cutoff && row.closed < cutoff);
  const test = chronological.filter((row) => row.opened >= cutoff);
  const straddling = chronological.filter((row) => row.opened < cutoff && row.closed >= cutoff);
  const trainSelection = S.selectStop(train, null);
  if (!trainSelection || !test.length) return {
    insufficientData: true, cutoff: iso(cutoff), trainingPositions: train.length, heldoutPositions: test.length,
    excludedStraddlingPositions: straddling.length
  };
  assert.ok(train.every((row) => row.opened < cutoff && row.closed < cutoff), "training outcomes must land before holdout begins");
  assert.ok(test.every((row) => row.opened >= cutoff), "heldout entries must start after training cutoff");
  const trainStop = trainSelection.optimal;
  // Evaluate only the choices frozen on training. The holdout never runs an optimizer or bootstrap search.
  const testEvaluation = fixedPriceEvaluation(test, [trainStop, trainSelection.insuranceStop]);
  return {
    insufficientData: false, objective: "pnl", cutoff: iso(cutoff), split: "first half of eligible entries; outcomes crossing cutoff excluded from train",
    trainingPositions: train.length, heldoutPositions: test.length, excludedStraddlingPositions: straddling.length,
    trainingEntryStart: iso(train[0]?.opened), trainingLastClose: iso(extent(train.map((row) => row.closed))[1]),
    heldoutEntryStart: iso(test[0]?.opened), heldoutLastClose: iso(extent(test.map((row) => row.closed))[1]),
    trainSelectedStop: trainStop, trainingScoreTies: scoreTies(trainSelection.curve),
    trainResult: tradeoff(trainSelection, trainStop), heldoutFixedTrainChoice: tradeoff(testEvaluation, trainStop),
    heldoutFixedTrainInsurance: tradeoff(testEvaluation, trainSelection.insuranceStop),
    usedHeldoutToChooseStop: false,
    sizingNote: "Price-PnL is used for the strict split. Full-snapshot equity reconstruction calibrates fees using later outcomes, so it is not reused for selecting a supposedly untouched training stop."
  };
}

// Independent oracle for single-entry positions. It uses the closed-form stop outcome rather than the replay loop.
function analyticalOracle(specs, equityValue) {
  return DOMAIN.map((stop) => {
    const outcomes = specs.map((spec) => stop !== null && spec.maeRoe >= stop
      ? -stop / 100 * spec.entry * spec.qty / spec.leverage
      : (spec.exit - spec.entry) * spec.direction * spec.qty);
    const terms = outcomes;
    return { stop, score: total(terms) / terms.length, pnl: total(outcomes), triggered: stop === null ? 0 : specs.filter((spec) => spec.maeRoe >= stop).length };
  });
}

function controlRows(specs) {
  const positions = [];
  const orders = [];
  const symbols = {};
  specs.forEach((spec, i) => {
    const symbol = `CONTROL${i}USDT`;
    const opened = Date.UTC(2026, 0, 1) + i * 5 * MINUTE;
    const closed = opened + 2 * MINUTE;
    const low = spec.direction > 0 ? spec.entry * (1 - spec.maeRoe / spec.leverage / 100) : Math.min(spec.entry, spec.exit);
    const high = spec.direction < 0 ? spec.entry * (1 + spec.maeRoe / spec.leverage / 100) : Math.max(spec.entry, spec.exit);
    positions.push({ symbol, side: spec.direction > 0 ? "LONG" : "SHORT", leverage: spec.leverage, avgCost: spec.entry, avgClosePrice: spec.exit, closingPnl: (spec.exit - spec.entry) * spec.direction * spec.qty, roi: (spec.exit - spec.entry) * spec.direction / spec.entry * spec.leverage, opened, closed, maxOpenInterest: spec.qty, closedVolume: spec.qty });
    const entrySide = spec.direction > 0 ? "BUY" : "SELL";
    orders.push({ symbol, positionSide: "BOTH", side: entrySide, executedQty: spec.qty, avgPrice: spec.entry, orderUpdateTime: opened });
    orders.push({ symbol, positionSide: "BOTH", side: entrySide === "BUY" ? "SELL" : "BUY", executedQty: spec.qty, avgPrice: spec.exit, orderUpdateTime: closed });
    symbols[symbol] = { minutes: [[opened, Math.max(spec.entry, spec.exit), Math.min(spec.entry, spec.exit)], [opened + MINUTE, high, low], [closed, spec.exit, spec.exit]], hours: [] };
  });
  return S.positionExcursions(positions, orders, { symbols, failed: [] });
}

function independentControls() {
  const spec = (maeRoe, exit, extra = {}) => ({ entry: 100, qty: 1, direction: 1, leverage: 10, maeRoe, exit, ...extra });
  const fixtures = [
    { name: "all_exact_ties", specs: Array.from({ length: 4 }, () => spec(0.25, 103)) },
    { name: "optimum_below_old_grid", specs: [...Array.from({ length: 8 }, () => spec(0.25, 103)), ...Array.from({ length: 3 }, () => spec(200, 85))], expect: 1 },
    { name: "optimum_between_old_grid_levels", specs: [...Array.from({ length: 40 }, () => spec(36.25, 103)), ...Array.from({ length: 3 }, () => spec(200, 85))], expect: 37 },
    { name: "upper_domain_boundary", specs: [...Array.from({ length: 40 }, () => spec(94.25, 103)), ...Array.from({ length: 3 }, () => spec(200, 85))], expect: 95 }
  ];
  let randomState = 0x5eeda11;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 4294967296; };
  for (let n = 0; n < 8; n += 1) {
    const specs = Array.from({ length: 12 + n }, () => {
      const direction = random() < 0.5 ? -1 : 1;
      const leverage = [3, 5, 10][Math.floor(random() * 3)];
      const qty = 0.2 + Math.floor(random() * 20) / 10;
      const move = -7 + Math.floor(random() * 16);
      const exit = 100 + direction * move;
      const adverseAtExit = Math.max(0, -move / 100 * 100 * leverage);
      const maeRoe = Math.max(adverseAtExit + 0.25, 0.25 + Math.floor(random() * 150));
      return spec(maeRoe, exit, { direction, leverage, qty });
    });
    fixtures.push({ name: `unlabelled_seeded_${n + 1}`, specs });
  }
  const checks = [];
  for (const fixture of fixtures) {
    const rows = controlRows(fixture.specs);
    assert.equal(rows.length, fixture.specs.length, fixture.name);
    for (const equityValue of [null, 1000]) {
      const selected = S.selectStop(rows, equityValue === null ? null : { equityAt: () => equityValue });
      assert.ok(selected, `${fixture.name}: selector returned no result`);
      const oracle = analyticalOracle(fixture.specs, equityValue);
      assert.deepEqual(Array.from(selected.curve, (point) => point.stop), DOMAIN, `${fixture.name}: complete domain`);
      selected.curve.forEach((point, i) => {
        near(point.score, oracle[i].score, `${fixture.name} ${point.stop} score`);
        near(point.pnlStayOut, oracle[i].pnl, `${fixture.name} ${point.stop} stay-out pnl`);
        near(point.pnlFollow, oracle[i].pnl, `${fixture.name} ${point.stop} follow pnl`);
        near(point.pnlMin, oracle[i].pnl, `${fixture.name} ${point.stop} pessimistic pnl`);
        near(point.pnlMax, oracle[i].pnl, `${fixture.name} ${point.stop} optimistic pnl`);
        assert.equal(point.triggered, oracle[i].triggered, `${fixture.name} ${point.stop} triggers`);
      });
      const ties = scoreTies(oracle);
      assert.equal(selected.optimal, ties[0], `${fixture.name}: deterministic optimum from independent oracle`);
      assert.deepEqual(Array.from(selected.optima), ties, `${fixture.name}: every exact optimum is retained`);
      if (equityValue === null && Object.hasOwn(fixture, "expect")) assert.equal(selected.optimal, fixture.expect, fixture.name);
      checks.push({ name: fixture.name, objective: selected.objective, positions: rows.length, candidates: selected.curve.length, optimal: selected.optimal, oracleTies: ties, everyScoreAndPnlMatched: true });
    }
  }
  return { seed: "0x05eeda11", fixtures: fixtures.length, evaluations: checks.length, complete: true, checks };
}

export function loadCachedTrader(id) {
  const rawFile = path.join(TOOLS, "cache", `raw_${id}.json`);
  const marksFile = path.join(TOOLS, "cache", "mark1m", `${id}.json`);
  const raw = JSON.parse(fs.readFileSync(rawFile, "utf8"));
  const windows = JSON.parse(fs.readFileSync(marksFile, "utf8"));
  const nowMs = snapshotNowMs(raw, P.fillTimeOf);
  assert.ok(nowMs > 0, `${id}: no auditable snapshot cutoff`);
  const { marks, audit } = marksFromWindows(windows, nowMs);
  const rows = S.positionExcursions(raw.positionHistory || [], raw.orderHistory || [], marks);
  return { id, name: raw.detail?.nickname || id, rows, raw, marks,
    snapshot: { cutoff: iso(nowMs), raw: receipt(rawFile), minuteMarks: receipt(marksFile) }, markAudit: audit };
}
export { S as StopLoss, coverage, receipt };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), stopDomain: DOMAIN,
  productionSource: receipt(path.join(ROOT, "src", "stoploss.js")),
  independentControls: independentControls(),
  caveats: [
    "A maximizer exists on this finite 96-choice domain; it can be no stop or several equally scoring stops. It is conditional on the specified objective and simulation.",
    "Closed-history optimality does not establish the future optimal threshold. Open positions and incomplete replay/candles can create selection bias.",
    "ROE drawdown is price risk; reported closingPnl includes funding and fees. Simulated price-PnL differences cannot be promoted to net executable profit.",
    "Both post-exit following interpretations are considered. Static initial/reentry trigger anchors follow the current FAQ; full-position MARK triggering and exact threshold fills are model assumptions. Branching gives conservative price-model bounds, not actual execution guarantees.",
    "Aggregate historical price PnL maximises price ROI only at a common fixed capital base. It is not Binance net ROI or exact portfolio CAGR."
  ],
  traders: []
};

for (const id of ids) {
  const rawFile = path.join(TOOLS, "cache", `raw_${id}.json`);
  const marksFile = path.join(TOOLS, "cache", "mark1m", `${id}.json`);
  const raw = JSON.parse(fs.readFileSync(rawFile, "utf8"));
  const windows = JSON.parse(fs.readFileSync(marksFile, "utf8"));
  const nowMs = snapshotNowMs(raw, P.fillTimeOf);
  assert.ok(nowMs > 0, `${id}: no auditable snapshot cutoff`);
  const { marks, audit: markAudit } = marksFromWindows(windows, nowMs);
  const rows = S.positionExcursions(raw.positionHistory || [], raw.orderHistory || [], marks);
  const { equity, audit: equityAudit } = accountOf(raw, nowMs);
  const selection = S.selectStop(rows, equity);
  const priceSelection = S.selectStop(rows, null);
  const radar = S.analyzeStopLossRadar(raw.positionHistory || [], raw.orderHistory || [], marks, equity);
  const eligible = priceSelection?._sims || [];
  const comparison = eligible.map((row, i) => ({ symbol: row.symbol, opened: iso(row.opened), reportedNetPnl: row.closingPnl, pricePnl: priceSelection._none[i].pnl, priceMaeRoe: row.maeRoe }));
  const signDisagreement = comparison.filter((item) => item.reportedNetPnl * item.pricePnl < 0);
  const review = {
    id, name: raw.detail?.nickname || id,
    snapshot: { cutoff: iso(nowMs), cutoffMs: nowMs, raw: receipt(rawFile), minuteMarks: receipt(marksFile), histories: raw.historyStatus || {}, orderRows: (raw.orderHistory || []).length },
    marks: markAudit, equity: equityAudit,
    coverage: coverage(rows, priceSelection, (raw.positionHistory || []).length),
    productionSelection: serialSelection(selection), pricePnlSelection: serialSelection(priceSelection),
    shownRecommendation: radar.insufficientData ? { insufficientData: true } : {
      recommendedRoe: radar.recommendedRoe, stopOptional: radar.stopOptional,
      winRetentionRate: radar.winRetentionRate, tradeoff: radar.tradeoff, maeStats: radar.allStats, mfeStats: radar.mfeStats,
      selectedOptimal: tradeoff(selection, selection.optimal), selectedInsurance: tradeoff(selection, selection.insuranceStop)
    },
    netActualPnlComparison: {
      positions: comparison.length, reportedNetTotal: total(comparison.map((item) => item.reportedNetPnl)), simulatedPriceTotal: total(comparison.map((item) => item.pricePnl)),
      residualNetMinusPrice: total(comparison.map((item) => item.reportedNetPnl - item.pricePnl)), signDisagreements: signDisagreement.length,
      signDisagreementRows: signDisagreement,
      interpretation: "Reported net outcomes and price-only outcomes are different quantities. Their residual includes funding, fees and any replay mismatch; this script does not invent a decomposition."
    },
    chronologicalHoldout: holdout(rows)
  };
  report.traders.push(review);
}

const printable = clean(report);
if (output) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(printable, null, 2)}\n`);
  fs.renameSync(temporary, output);
}
console.log(`Independent single-entry oracle: ${report.independentControls.evaluations} evaluations passed across all 96 choices.`);
for (const review of report.traders) {
  const selection = review.productionSelection;
  const heldout = review.chronologicalHoldout;
  console.log(`\n${review.name} (${review.id}), snapshot ${review.snapshot.cutoff}`);
  console.log(`Raw mtime ${review.snapshot.raw.mtime}; marks mtime ${review.snapshot.minuteMarks.mtime}`);
  console.log(`Eligible ${review.coverage.selectedSimulationRows}/${review.coverage.closedValidRows} closed rows; exclusions ${JSON.stringify(review.coverage.excludedReasonCounts)}`);
  if (!selection) { console.log("Insufficient replay/mark coverage for a stop selection."); continue; }
  console.log(`Objective ${selection.objective}; optimum ${selection.optimal ?? "none"}; exact score ties ${JSON.stringify(selection.independentlyCalculatedScoreTies)}; insurance ${selection.insuranceStop}%`);
  console.log("Stop\tObjective score\tStay-out price PnL\tFollow price PnL\tMinimum scenario PnL\tMaximum scenario PnL\tTriggered positions min/max");
  for (const point of selection.curve) console.log(`${point.stop ?? "none"}\t${point.score}\t${point.pnlStayOut.toFixed(6)}\t${point.pnlFollow.toFixed(6)}\t${point.pnlMin.toFixed(6)}\t${point.pnlMax.toFixed(6)}\t${point.triggeredMin}/${point.triggered}`);
  console.log(`Shown tradeoff ${JSON.stringify(clean(review.shownRecommendation))}`);
  console.log(`Net actual versus price PnL ${JSON.stringify(review.netActualPnlComparison)}`);
  console.log(`Chronological holdout ${JSON.stringify(clean(heldout))}`);
}
if (output) console.log(`\nReport published atomically: ${output}`);

}
