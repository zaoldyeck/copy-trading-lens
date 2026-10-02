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
loadScript("src/analysis.js", sandbox);
loadScript("src/providers.js", sandbox);

const analysis = sandbox.window.CopyTradingLensAnalysis;
const providers = sandbox.window.CopyTradingLensProviders;
assert.ok(typeof analysis.analyzeStopLossRadar === "function", "analyzeStopLossRadar is exported");
assert.ok(typeof providers.detectLeadPage === "function", "detectLeadPage is exported");
assert.ok(typeof providers.fetchBinanceMarkCandles === "function", "fetchBinanceMarkCandles is exported");

console.log("=== RUNNING UNIT TESTS FOR STOP LOSS RADAR ===");

// 1. Edge Case: Insufficient data (< 3 positions)
{
  const result = analysis.analyzeStopLossRadar([{ avgCost: 100, avgClosePrice: 105, closingPnl: 5, leverage: 5 }]);
  assert.equal(result.insufficientData, true, "fewer than 3 positions returns insufficientData");
  console.log("PASS: handles insufficient positions gracefully");
}

// 2. Synthetic controlled positions test
{
  const positions = [
    // 4 wins: slight floating dip then win
    { symbol: "BTCUSDT", avgCost: 100, avgClosePrice: 110, closingPnl: 10, leverage: 10, side: "LONG", roi: 1.0 },
    { symbol: "ETHUSDT", avgCost: 200, avgClosePrice: 210, closingPnl: 10, leverage: 10, side: "LONG", roi: 0.5 },
    { symbol: "SOLUSDT", avgCost: 50, avgClosePrice: 52, closingPnl: 4, leverage: 10, side: "LONG", roi: 0.4 },
    { symbol: "DOGEUSDT", avgCost: 10, avgClosePrice: 11, closingPnl: 1, leverage: 10, side: "LONG", roi: 1.0 },
    // 1 severe loss: dipped to 50 on avgCost 100 (50% price drop = 500% ROE loss)
    { symbol: "XRPUSDT", avgCost: 100, avgClosePrice: 50, closingPnl: -50, leverage: 10, side: "LONG", roi: -5.0 }
  ];

  const radar = analysis.analyzeStopLossRadar(positions, [], {}, null);
  assert.equal(radar.insufficientData, false);
  assert.equal(radar.dominantLeverage, 10);
  assert.equal(radar.hasSevereBagHolding, true, "flags XRPUSDT as severe bag holding (-500% ROE)");
  assert.equal(radar.worstHistoricalRoeMae, 500);
  assert.ok(radar.recommendedRoe >= 30 && radar.recommendedRoe <= 85, "recommendedRoe is bounded between 30 and 85");
  assert.equal(radar.recommendedPriceDrop, Number((radar.recommendedRoe / 10).toFixed(1)));
  assert.ok(radar.winRetentionRate >= 90, "preserves at least 90% of winning trades");
  assert.equal(radar.lossStats.median, 500, "lossStats has median property");
  assert.equal(radar.lossStats.p50, 500, "lossStats has p50 property matching median");
  assert.equal(radar.isPreciseMae, false, "without market candles isPreciseMae is false");
  assert.equal(radar.pendingKlines, true, "without market candles pendingKlines is true");
  assert.ok(radar.allStats !== undefined, "allStats is defined");
  console.log("PASS: synthetic controlled positions verify MAE and bag holding detection");
}

// 2b. Binance's position-history `roi` is a FRACTION of initial margin ("1.2" = +120%), at any
//     magnitude. Checked 2026-10-02 on 184,135 cached positions: 97.7% satisfy
//     roi == closingPnl / (peak qty x avgCost / leverage), 15 satisfy it in percent units; 6,209 of the
//     6,463 positions with |roi| >= 1 are fractions. A magnitude-based unit guess reads +120% as +1.2%.
{
  const positions = [
    { symbol: "AUSDT", avgCost: 100, avgClosePrice: 112, closingPnl: 12, leverage: 10, side: "LONG", roi: 1.2 },
    { symbol: "BUSDT", avgCost: 100, avgClosePrice: 105, closingPnl: 5, leverage: 10, side: "LONG", roi: 0.5 },
    { symbol: "CUSDT", avgCost: 100, avgClosePrice: 99, closingPnl: -1, leverage: 10, side: "LONG", roi: -0.1 }
  ];
  const radar = analysis.analyzeStopLossRadar(positions, [], {}, null);
  const atLoose = radar.simResults.find((row) => row.threshold === 90);
  // nobody reaches a 90% ROE adverse move: gross win 120 + 50, gross loss 10
  assert.ok(Math.abs(atLoose.simulatedProfitFactor - 17) < 0.01, `profit factor must read +120% as 120, got ${atLoose.simulatedProfitFactor}`);
  console.log("PASS: roi >= 100% is read as a fraction of margin, not as a percent");
}

// 3. Real Cached Lead Traders Parity
const cacheDir = path.join(root, "tools", "cache");
if (fs.existsSync(path.join(cacheDir, "raw_4908633203782592768.json"))) {
  const rawXuanMing = JSON.parse(fs.readFileSync(path.join(cacheDir, "raw_4908633203782592768.json"), "utf8"));
  const radarXM = analysis.analyzeStopLossRadar(rawXuanMing.positionHistory, rawXuanMing.orderHistory, rawXuanMing.meta, rawXuanMing.marketHistory);

  assert.equal(radarXM.dominantLeverage, 5, "玄冥二老 dominant leverage is 5x");
  assert.ok(radarXM.recommendedRoe >= 45 && radarXM.recommendedRoe <= 85, "玄冥二老 recommended stop-loss is bounded in range");
  assert.ok(radarXM.winRetentionRate >= 94, "玄冥二老 win retention rate is >= 94%");
  assert.equal(radarXM.isPreciseMae, true, "玄冥二老 with marketHistory is precise");
  console.log(`PASS: 玄冥二老 verified (Lev: ${radarXM.dominantLeverage}x, Rec: ${radarXM.recommendedRoe}%, PriceDrop: ${radarXM.recommendedPriceDrop}%, WinRet: ${radarXM.winRetentionRate}%)`);
}

if (fs.existsSync(path.join(cacheDir, "raw_5075281354358777856.json"))) {
  const rawAoYing = JSON.parse(fs.readFileSync(path.join(cacheDir, "raw_5075281354358777856.json"), "utf8"));
  const radarAY = analysis.analyzeStopLossRadar(rawAoYing.positionHistory, rawAoYing.orderHistory, rawAoYing.meta, null);

  assert.equal(radarAY.dominantLeverage, 10, "熬鹰资本 dominant leverage is 10x");
  assert.equal(radarAY.hasSevereBagHolding, true, "熬鹰资本 flags severe bag holding");
  assert.equal(radarAY.worstHistoricalRoeMae, 156.7, "熬鹰资本 worst historical drawdown is -156.7% ROE");
  assert.ok(radarAY.lossStats.p90 > 30, "熬鹰资本 loss P90 reflects deep holding");
  console.log(`PASS: 熬鹰资本 verified (Lev: ${radarAY.dominantLeverage}x, Rec: ${radarAY.recommendedRoe}%, BagAlert: ${radarAY.hasSevereBagHolding}, WorstDD: -${radarAY.worstHistoricalRoeMae}%)`);
}

if (fs.existsSync(path.join(cacheDir, "raw_5131925334830383361.json"))) {
  const rawHai = JSON.parse(fs.readFileSync(path.join(cacheDir, "raw_5131925334830383361.json"), "utf8"));
  const radarHai = analysis.analyzeStopLossRadar(rawHai.positionHistory, rawHai.orderHistory, rawHai.meta, rawHai.marketHistory);

  assert.equal(radarHai.dominantLeverage, 10, "星辰社区-海 dominant leverage is 10x");
  assert.equal(radarHai.hasSevereBagHolding, true, "星辰社区-海 flags severe bag holding");
  assert.ok(radarHai.worstHistoricalRoeMae > 600, "星辰社区-海 worst historical drawdown > 600% ROE");
  assert.ok(radarHai.recommendedRoe >= 50 && radarHai.recommendedRoe <= 75, "星辰社区-海 recommended stop loss is ~55-75% ROE");
  assert.ok(radarHai.winRetentionRate >= 93, "星辰社区-海 win retention rate >= 93%");
  console.log(`PASS: 星辰社区-海 verified (Lev: ${radarHai.dominantLeverage}x, Rec: ${radarHai.recommendedRoe}%, BagAlert: ${radarHai.hasSevereBagHolding}, WorstDD: -${radarHai.worstHistoricalRoeMae}%)`);
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
