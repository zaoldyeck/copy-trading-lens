// Unit tests for the Optimal Position Stop-Loss Radar (src/analysis.js)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadScript(filePath, sandbox) {
  const code = fs.readFileSync(path.join(root, filePath), "utf8");
  vm.runInContext(code, sandbox);
}

const sandbox = {
  window: {},
  document: {
    createElement: () => ({ setAttribute: () => {}, appendChild: () => {} }),
    querySelectorAll: () => []
  },
  URL: globalThis.URL,
  console
};
sandbox.global = sandbox.window;
sandbox.window.CopyTradingLensI18n = {
  t: (k, s = []) => k + (s.length ? `[${s.join(",")}]` : "")
};
vm.createContext(sandbox);

loadScript("src/positions.js", sandbox);
loadScript("src/style.js", sandbox);
loadScript("src/equity.js", sandbox);
loadScript("src/stoploss.js", sandbox);
loadScript("src/analysis.js", sandbox);
loadScript("src/providers.js", sandbox);

const stoploss = sandbox.window.CopyTradingLensStopLoss;
const providers = sandbox.window.CopyTradingLensProviders;
assert.ok(typeof stoploss.analyzeStopLossRadar === "function", "analyzeStopLossRadar is exported");
assert.ok(typeof providers.detectLeadPage === "function", "detectLeadPage is exported");
assert.ok(typeof providers.fetchBinancePositionMarks === "function", "fetchBinancePositionMarks is exported");

console.log("=== RUNNING UNIT TESTS FOR STOP LOSS RADAR ===");

const MIN = 60000;
const HOUR = 3600000;
const T0 = Date.UTC(2026, 8, 1, 10, 0, 0);
// objects built inside the vm sandbox have another realm's prototypes; compare their JSON
const plain = (value) => JSON.parse(JSON.stringify(value));
const near = (actual, want, tolerance, message) => assert.ok(Math.abs(actual - want) <= tolerance, `${message}: got ${actual}, want ${want} +/- ${tolerance}`);
// a closed long on a 10x symbol: price excursion in %, realised ROI as a fraction of margin
const position = (extra) => ({ symbol: "XUSDT", side: "LONG", leverage: 10, avgCost: 100, avgClosePrice: 100, closingPnl: 1, roi: 0.01, opened: T0, closed: T0 + 10 * MIN, ...extra });

// 1. fewer than 3 closed positions: nothing to select from
{
  const result = stoploss.analyzeStopLossRadar([position()]);
  assert.equal(result.insufficientData, true, "fewer than 3 positions returns insufficientData");
  console.log("PASS: handles insufficient positions gracefully");
}

// 2. life candles: minutes that overlap, hours only when fully inside
{
  const marks = {
    minutes: [[T0 - 2 * MIN, 1, 1], [T0 - MIN, 2, 2], [T0, 3, 3], [T0 + 5 * MIN, 4, 4], [T0 + 10 * MIN, 5, 5], [T0 + 11 * MIN, 6, 6]],
    hours: [[T0 - HOUR, 7, 7], [T0, 8, 8], [T0 + HOUR, 9, 9]]
  };
  // life [T0 + 30 s, T0 + 10 min + 10 s]: the minute opening at T0 holds its first 30 s; the one opening at
  // T0 + 10 min holds its last 10 s; nothing opening before T0 or after T0 + 10 min counts; no hour is fully inside.
  const short = stoploss.lifeCandles(marks, T0 + 30000, T0 + 10 * MIN + 10000);
  assert.deepEqual(plain(short.map((c) => c.time)), [T0, T0 + 5 * MIN, T0 + 10 * MIN], "minute candles overlapping the life, none from outside");
  const ext = stoploss.lifeExtremes(marks, T0 + 30000, T0 + 10 * MIN + 10000);
  assert.deepEqual(plain(ext), { high: 5, low: 3 });
  // life T0 .. T0 + 3 h: the hour at T0 and at T0 + 1 h are fully inside, the one before is not
  const long = stoploss.lifeCandles({ minutes: [], hours: marks.hours }, T0, T0 + 3 * HOUR);
  assert.deepEqual(plain(long.map((c) => c.time)), [T0, T0 + HOUR]);
  assert.equal(stoploss.lifeExtremes({ minutes: [], hours: [] }, T0, T0 + HOUR), null, "no candles, no extremes");
  console.log("PASS: life candles clip minutes to the position's own life and admit only whole hours");
}

// 3. the entry as it was: a low reached BEFORE an add is judged against the entry then, not the final average
{
  const marks = { minutes: [[T0, 101, 99], [T0 + MIN, 100, 85], [T0 + 2 * MIN, 92, 90], [T0 + 3 * MIN, 96, 94]], hours: [] };
  const fills = [
    { symbol: "XUSDT", side: "BUY", executedQty: 1, avgPrice: 100, orderUpdateTime: T0 },
    { symbol: "XUSDT", side: "BUY", executedQty: 3, avgPrice: 90, orderUpdateTime: T0 + 2 * MIN },
    { symbol: "XUSDT", side: "SELL", executedQty: 4, avgPrice: 95, orderUpdateTime: T0 + 3 * MIN }
  ];
  const row = position({ avgCost: 92.5, avgClosePrice: 95, closingPnl: 10, roi: 0.27, closed: T0 + 3 * MIN });
  const [path] = stoploss.positionExcursions([row], fills, { symbols: { XUSDT: marks }, failed: [] });
  near(path.maeRoe, 150, 0.01, "low 85 against the entry of 100 (15% x 10x) before the add at 90");
  assert.equal(path.entryPathUsed, true);
  const [finalCost] = stoploss.positionExcursions([row], [], { symbols: { XUSDT: marks }, failed: [] });
  near(finalCost.maeRoe, (92.5 - 85) / 92.5 * 100 * 10, 0.01, "without fills the final average cost is all there is");
  assert.equal(finalCost.entryPathUsed, false);
  // history that begins mid-position (first fill is a reduction) cannot be replayed
  const [midway] = stoploss.positionExcursions([row], [fills[2]], { symbols: { XUSDT: marks }, failed: [] });
  assert.equal(midway.entryPathUsed, false);
  console.log("PASS: the entry that held at each moment decides the drawdown, the final average only when fills are missing");
}

// 4. roi is a FRACTION of initial margin at any magnitude ("1.2" = +120%): the outcome of a position
//    the stop never touches is its ROI in percent. Corpus check 2026-10-02: 184,135 cached positions,
//    97.7% satisfy roi == closingPnl / (peak qty x avgCost / leverage); 6,209 of the 6,463 with |roi| >= 1 are fractions.
{
  const rows = [
    position({ symbol: "AUSDT", avgClosePrice: 112, closingPnl: 12, roi: 1.2 }),
    position({ symbol: "BUSDT", avgClosePrice: 105, closingPnl: 5, roi: 0.5 }),
    position({ symbol: "CUSDT", avgClosePrice: 99, closingPnl: -1, roi: -0.1 })
  ];
  const { curve } = stoploss.selectStop(stoploss.positionExcursions(rows, [], null), null);
  const at90 = curve.find((c) => c.stop === 90);
  near(at90.meanRoe, (120 + 50 - 10) / 3, 0.01, "+120% is 120, not 1.2");
  console.log("PASS: roi >= 100% is read as a fraction of margin, not as a percent");
}

// 4b. prices give the drawdown, roi gives the outcome: closingPnl (and so roi) is trade pnl PLUS funding, less fees,
//     so a row whose roi has the opposite sign from its prices is a correct row. 玄冥二老's TAIKOUSDT short
//     (avgCost 0.290 -> avgClose 0.267, 5x) reports -52% / -91 USDT: +70 USDT on price, -169 USDT of funding over
//     nine hourly settlements at -0.4% to -2% (tools/cache/market funding history), and the price really did spike
//     to 0.538. Its drawdown is the squeeze, not an artefact.
{
  const spike = { symbols: { XUSDT: { minutes: [[T0, 101, 99], [T0 + MIN, 400, 99]], hours: [] } }, failed: [] };
  const fundingLoser = position({ side: "SHORT", avgCost: 100, avgClosePrice: 90, closingPnl: -52, roi: -0.52, closed: T0 + 2 * MIN });
  const [row] = stoploss.positionExcursions([fundingLoser], [], spike);
  near(row.maeRoe, 3000, 0.01, "the squeeze is the drawdown: (400 - 100) / 100 x 10x");
  near(row.roiPct, -52, 0.01, "the reported outcome is kept as it is");
  console.log("PASS: a position that lost to funding keeps its price drawdown and its reported outcome");
}

// 4c. fills become positions in src/positions.js: hedge books stay apart and a flipping fill is split
{
  const hedgeMarks = { symbols: { XUSDT: { minutes: [[T0, 101, 99], [T0 + MIN, 100, 98], [T0 + 2 * MIN, 99, 85], [T0 + 3 * MIN, 96, 94]], hours: [] } }, failed: [] };
  const hedgeFills = [
    { symbol: "XUSDT", side: "BUY", positionSide: "LONG", executedQty: 1, avgPrice: 100, orderUpdateTime: T0 },
    { symbol: "XUSDT", side: "SELL", positionSide: "SHORT", executedQty: 1, avgPrice: 100, orderUpdateTime: T0 + MIN },
    { symbol: "XUSDT", side: "SELL", positionSide: "LONG", executedQty: 1, avgPrice: 95, orderUpdateTime: T0 + 3 * MIN }
  ];
  const longRow = position({ avgCost: 100, avgClosePrice: 95, closingPnl: -5, roi: -0.5, closed: T0 + 3 * MIN });
  const [longPath] = stoploss.positionExcursions([longRow], hedgeFills, hedgeMarks);
  near(longPath.maeRoe, 150, 0.01, "the short book's SELL must not shut the long's path early: low 85 against 100 at 10x");
  assert.equal(longPath.entryPathUsed, true);

  // one-way: a SELL of 3 closes a long of 1 and opens a short of 2; the short's first entry weighs 2, not 3
  const flipMarks = { symbols: { XUSDT: { minutes: [[T0 + 2 * MIN, 101, 99], [T0 + 3 * MIN, 105, 99], [T0 + 4 * MIN, 130, 99], [T0 + 5 * MIN, 95, 90]], hours: [] } }, failed: [] };
  const flipFills = [
    { symbol: "XUSDT", side: "BUY", positionSide: "BOTH", executedQty: 1, avgPrice: 100, orderUpdateTime: T0 },
    { symbol: "XUSDT", side: "SELL", positionSide: "BOTH", executedQty: 3, avgPrice: 100, orderUpdateTime: T0 + 2 * MIN },
    { symbol: "XUSDT", side: "SELL", positionSide: "BOTH", executedQty: 2, avgPrice: 110, orderUpdateTime: T0 + 4 * MIN },
    { symbol: "XUSDT", side: "BUY", positionSide: "BOTH", executedQty: 4, avgPrice: 90, orderUpdateTime: T0 + 5 * MIN }
  ];
  const shortRow = position({ side: "SHORT", avgCost: 105, avgClosePrice: 90, closingPnl: 80, roi: 0.8, opened: T0 + 2 * MIN, closed: T0 + 5 * MIN });
  const [shortPath] = stoploss.positionExcursions([shortRow], flipFills, flipMarks);
  near(shortPath.maeRoe, (130 - 105) / 105 * 100 * 10, 0.5, "entry 105 = (2 x 100 + 2 x 110) / 4 once the flip is split (unsplit it would read 104 and 250); 130 is the worst print");
  assert.equal(shortPath.entryPathUsed, true);
  console.log("PASS: hedge books and flipping fills are replayed by positions.js, not guessed from BUY/SELL");
}

// 4d. a symbol the exchange refuses (a delisted one fails on every request) is a coverage gap, nothing more
{
  const rows = [position({ symbol: "AUSDT" }), position({ symbol: "BUSDT" }), position({ symbol: "DEADUSDT" })];
  const radar = stoploss.analyzeStopLossRadar(rows, [], { symbols: { AUSDT: { minutes: [[T0, 101, 99]], hours: [] } }, failed: [{ symbol: "DEADUSDT", error: "-1121" }] }, null);
  near(radar.marksCoverage, 1 / 3, 0.001, "one of three positions has candles");
  assert.ok(!("isPreciseMae" in radar), "there is no provisional state to report: the UI draws nothing until the whole read is done");
  // too little to select from: no number in it can pass for a result
  const empty = stoploss.analyzeStopLossRadar([position()], [], null, null);
  assert.equal(empty.insufficientData, true);
  for (const field of ["recommendedRoe", "recommendedPriceDrop", "winRetentionRate", "worstHistoricalRoeMae", "dominantLeverage"]) assert.equal(empty[field], null, `${field} must not default to a number`);
  console.log("PASS: refused symbols show as coverage; an insufficient radar carries no default numbers");
}

// 5. synthetic traders whose best stop is known by construction
{
  const excursion = (maeRoe, roiPct, equity = 1000) => ({ maeRoe, roiPct, closingPnl: roiPct, margin: 200, opened: T0, closed: T0 + MIN, entryPathUsed: false, marksUsed: true, leverage: 10 });
  const sizing = { equityAt: () => 1000 }; // margin 200 of 1000: f = 20%

  // 40 winners that dip at most 39% ROE and 3 disasters at 200%: the tightest stop that spares every winner
  const disasters = [...Array.from({ length: 40 }, (_, i) => excursion(i, 20)), ...Array.from({ length: 3 }, () => excursion(200, -150))];
  const a = stoploss.selectStop(disasters, sizing);
  assert.equal(a.objective, "growth");
  assert.equal(a.optimal, 40, "the smallest candidate above every winner's 39% dip");
  assert.equal(a.curve.find((c) => c.stop === 40).killedWins, 0);
  assert.equal(a.curve.find((c) => c.stop === 40).stoppedLosses, 3);

  // winners dip as deep as 117% and one loss is -150%: every stop kills more than it saves
  const tail = [...Array.from({ length: 40 }, (_, i) => excursion(i * 3, 30)), excursion(200, -150)];
  const b = stoploss.selectStop(tail, { equityAt: () => 10000 }); // f = 2%
  assert.equal(b.optimal, null, "no stop is the optimum when winners dip as deep as the disaster");
  assert.ok(b.bestStop >= 10 && b.costOfBestStop > 0, "the best stop that exists costs something");

  // without sizing the answer is the risk-neutral one and says so
  const c = stoploss.selectStop(disasters, null);
  assert.equal(c.objective, "meanRoe");
  assert.deepEqual(plain(c.sizing), { source: "none" });

  // same positions, same stability figure
  assert.equal(stoploss.selectStop(tail, sizing).bootstrapAgreement, stoploss.selectStop(tail, sizing).bootstrapAgreement);

  // growth punishes the tail that mean ROE forgives: -390% on 30% of equity wipes the account out
  const ruin = [...Array.from({ length: 40 }, (_, i) => excursion(i * 3, 30)), excursion(500, -390)];
  const fat = { equityAt: () => 666.67 }; // margin 200 of ~667: f = 30%
  assert.notEqual(stoploss.selectStop(ruin, fat).optimal, null, "a position that wipes out equity must be stopped");
  assert.equal(stoploss.selectStop(ruin, null).optimal, null, "mean ROE alone would keep the winners and ignore the wipe-out");
  console.log("PASS: stop selection finds the known optimum, defers to 'no stop' when winners dip as deep, and punishes ruin");
}

// 5b. the card explains its answer in the trader's own numbers: what the shown stop cuts, saves and averages
{
  const wins = Array.from({ length: 40 }, (_, i) => position({ symbol: `W${i}USDT`, avgClosePrice: 100 - i * 0.3, closingPnl: 60, roi: 0.3 }));
  const disaster = position({ symbol: "BRUSDT", avgClosePrice: 50, closingPnl: -780, roi: -3.9, leverage: 10 });
  const radar = stoploss.analyzeStopLossRadar([...wins, disaster], [], null, { equityAt: () => 666.67 });
  const t = radar.tradeoff;
  const stop = radar.recommendedRoe;
  assert.equal(t.stop, stop);
  assert.equal(t.positions, 41);
  assert.equal(t.wins, 40);
  assert.equal(t.losses, 1);
  // independent recount: winner i dips i x 3 ROE points (0.3% x 10x per step)
  assert.equal(t.killedWins, wins.filter((_, i) => i * 3 >= stop).length, "winners whose dip reached the stop");
  assert.equal(t.savedLosses, 1, "the -390% loser would have ended at -stop instead");
  near(t.savedLossesAvgRoi, -390, 0.001, "what that loser really ended at");
  near(t.killedWinsAvgRoi, t.killedWins ? 30 : 0, 0.001, "what the cut winners really ended at");
  assert.deepEqual(plain(t.worstLoss), { symbol: "BRUSDT", leverage: 10, roiPct: -390, maeRoe: 500 });
  const at = (level) => radar.stopSelection.curve.find((point) => point.stop === level).meanRoe;
  near(t.meanRoeNone, at(null), 1e-9, "no stop averages what the curve says");
  near(t.meanRoeStop, at(stop), 1e-9, "the shown stop averages what the curve says");
  console.log("PASS: the trade-off behind the shown stop is counted from the trader's own positions");
}

// 6. Real cached lead traders: the same numbers as tools/research/stoploss-three.mjs (V2 = entry path +
//    exact in-life minute marks). Skipped when the local research caches are absent.
const cacheDir = path.join(root, "tools", "cache");
const realTraders = [
  // 玄冥二老's 428.4% is the TAIKOUSDT short squeezed to 0.538 (funding then made it a -52% row): a real drawdown
  { id: "4908633203782592768", name: "玄冥二老", winnersP95: 91.4, worstLoss: 428.4 },
  { id: "5131925334830383361", name: "星辰社区-海", winnersP95: 84.8, worstLoss: 652.4 },
  { id: "5075281354358777856", name: "熬鹰资本", winnersP95: 30.0, worstLoss: 194.2 }
];
for (const trader of realTraders) {
  const rawFile = path.join(cacheDir, `raw_${trader.id}.json`);
  const marksFile = path.join(cacheDir, "mark1m", `${trader.id}.json`);
  if (!fs.existsSync(rawFile) || !fs.existsSync(marksFile)) continue;
  const raw = JSON.parse(fs.readFileSync(rawFile, "utf8"));
  const windows = JSON.parse(fs.readFileSync(marksFile, "utf8"));
  const symbols = {};
  for (const [key, rows] of Object.entries(windows)) {
    const symbol = key.split("|")[0];
    (symbols[symbol] ||= { minutes: [], hours: [] }).minutes.push(...rows.map((r) => [r[0], r[2], r[3]]));
  }
  for (const marks of Object.values(symbols)) {
    marks.minutes.sort((x, y) => x[0] - y[0]);
    marks.minutes = marks.minutes.filter((row, i, all) => i === 0 || row[0] !== all[i - 1][0]);
  }
  const radar = stoploss.analyzeStopLossRadar(raw.positionHistory, raw.orderHistory, { symbols, failed: [] }, null);
  near(radar.winStats.p95, trader.winnersP95, 0.5, `${trader.name} winners' MAE p95`);
  near(radar.lossStats.max, trader.worstLoss, 0.5, `${trader.name} worst loss MAE`);
  assert.equal(radar.stopSelection.objective, "meanRoe");
  assert.equal(radar.marksCoverage, 1, `${trader.name}: every position has candles`);
  assert.ok(radar.recommendedRoe >= 10 && radar.recommendedRoe <= 95);
  if (trader.name !== "熬鹰资本") assert.equal(radar.stopSelection.optimal, null, `${trader.name}: no stop beats every stop in-sample`);
  console.log(`PASS: ${trader.name} (winners p95 ${radar.winStats.p95}, worst loss ${radar.lossStats.max}, optimal ${radar.stopSelection.optimal ?? "none"}, best stop ${radar.stopSelection.bestStop}, entry path ${radar.entryPathPositions}/${radar.positionCount})`);
}

// 4. Binance copy-setting URL detection test
{
  // Test direct copy mode
  const directSetting = providers.detectLeadPage("https://www.binance.com/zh-TC/copy-trading/copy-setting?portfolioId=5131925334830383361");
  assert.equal(directSetting?.platform, "Binance");
  assert.equal(directSetting?.id, "5131925334830383361");
  assert.equal(directSetting?.pageType, "copy-setting");

  // Test edit mode with performance entry resource mock
  sandbox.performance = {
    getEntriesByType: (type) => type === "resource" ? [
      { name: "https://www.binance.com/bapi/futures/v1/private/future/copy-trade/copy-portfolio/get-limit-info?leadPortfolioId=4908633203782592768" }
    ] : []
  };
  // Edit mode: the card the user just pressed on copy-management takes precedence
  // over a stale performance entry (e.g. 熬鷹資本). More scenarios live in
  // scripts/test-lead-resolution.mjs.
  providers.rememberPressedCard({ innerText: "熬鷹資本\n投資組合 ID: 5075281354358777856\n設定", parentElement: null });
  const aoYingSetting = providers.detectLeadPage("https://www.binance.com/zh-TC/copy-trading/copy-setting?mode=edit&portfolioId=5115151497967086081");
  assert.equal(aoYingSetting?.platform, "Binance");
  assert.equal(aoYingSetting?.id, "5075281354358777856", "the pressed card must take precedence over stale performance resource entry 4908633203782592768");
  assert.equal(aoYingSetting?.pageType, "copy-setting");

  console.log("PASS: Binance copy-setting URL and lead portfolio detection verified for both direct and edit modes, including pressed-card precedence");
}

console.log("\nALL STOP LOSS RADAR UNIT TESTS PASSED SUCCESSFULLY!");
