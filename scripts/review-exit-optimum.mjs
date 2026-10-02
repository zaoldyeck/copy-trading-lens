// Production joint selector, canonical dated snapshots, and train-only selection with frozen holdout.
// node scripts/review-exit-optimum.mjs [portfolioId ...] --output reports/exit-optimum.json.gz
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { loadCachedTrader, StopLoss as S, coverage, receipt } from './review-stoploss-optimum.mjs';
const args = process.argv.slice(2); const ids = []; let output;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output') output = path.resolve(args[++i]);
  else { assert.match(args[i], /^\d+$/); ids.push(args[i]); }
}
if (!ids.length) ids.push('4908633203782592768', '5131925334830383361', '5075281354358777856');
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), production: receipt(path.resolve('src/stoploss.js')),
  objective: 'conservative historical aggregate price PnL = price ROI at a common fixed capital base',
  supportedDomain: { SL: 'none or 1..95', TP: 'none or 1..2000', step: 1, choices: 192096 },
  assumptions: ['static first-copy/reentry anchor per current Binance FAQ', 'whole-position exact-threshold MARK exits are model assumptions: actual copy order size/trigger feed undocumented', 'both stay-out and later-add following; conservative OHLC first-hit relaxation', 'costs, funding, liquidation, capital failures and profit share not reconstructed; not net executable ROI'],
  traders: [] };
for (const id of ids) {
  const input = loadCachedTrader(id);
  const sl = S.selectStop(input.rows, null);
  const admitted = sl?._sims || [];
  console.log(`START ${input.name} ${input.snapshot.cutoff}: ${admitted.length}/${input.rows.length} admitted`);
  const started = Date.now();
  const full = S.selectExit(input.rows, null, { includeCurve: true });
  console.log(`FULL ${input.name}: ${JSON.stringify(full?.optimal)} delta ${full?.deltaMin}; certificate ${JSON.stringify(full?.search)} elapsed ${(Date.now()-started)/1000}s`);
  const holdout = S.chronologicalExitHoldout(input.rows);
  console.log(`HOLDOUT ${input.name}: ${JSON.stringify(holdout)}`);
  const legacyDynamic = full ? S.evaluateExit(admitted, full.optimal, 'dynamic') : null;
  const slVisible = sl ? Object.fromEntries(Object.entries(sl).filter(([k])=>!k.startsWith('_'))) : null;
  report.traders.push({ id, name: input.name, snapshot: input.snapshot, markAudit: input.markAudit,
    coverage: coverage(input.rows, sl, input.raw.positionHistory?.length || 0), slOnly: slVisible,
    joint: full, chronologicalHoldout: holdout, dynamicAverageSensitivityAtStaticOptimum: legacyDynamic });
}
if (output) {
  assert.ok(output.endsWith('.json.gz'), 'the single canonical full-grid artifact is compressed JSON');
  fs.mkdirSync(path.dirname(output), { recursive:true });
  const bytes = zlib.gzipSync(JSON.stringify(report), { level: 6 });
  const temp = `${output}.tmp-${process.pid}`; fs.writeFileSync(temp, bytes); fs.renameSync(temp, output);
  console.log(`PUBLISHED ${output} ${bytes.length} bytes`);
}
