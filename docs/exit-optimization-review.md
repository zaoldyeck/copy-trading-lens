# Joint take-profit / stop-loss review

## Tracked requirements

- [x] Answer ROI versus growth objectives and retain the distinction between price PnL and executable net ROI.
- [x] Confirm the earlier SL implementation was delivered; replace its automatic objective choice with an explicit fixed-capital price-PnL objective.
- [x] Verify current Binance position TP/SL semantics and supported ranges; reconcile the documented static-order rule with prior dynamic assumptions.
- [x] Implement joint optimisation including neither, either, or both exits at every supported integer percentage; certify the finite domain without arbitrary pruning.
- [x] Preserve chronological candle ordering, unknown intrabar ordering, adds, partial exits, reentry, missing-data rejection and conservative bounds.
- [x] Expose the tightest historically never-triggered insurance stop (if present within 1..95); otherwise distinguish the least-cost enabled stop and quantify its price. Do not guarantee future ROI or coverage of unmatched old trades.
- [x] Present the joint result, prices, tradeoffs, separate SL-only result and risk limits in all locales; safely fill only uniquely identified position inputs on a click.
- [x] Recalculate 玄冥二老, 星辰社区-海 and 熬鹰资本 with dated snapshots and frozen chronological holdout; retain negative results.
- [x] Verify with an independent oracle, representative controls, all npm suites, extension validation and package parity.
- [x] Update durable invariants, version, artifacts and source review.

Final commit/push delivery is tracked in the local `reports/exit-optimum-delivery.json` receipt. Its delivery status becomes complete only after the single final push exits successfully and local HEAD matches the remote branch. This review records completed research and verification, not an advance claim of a successful push.

## Objective

For a fixed initial capital C, identical historical entry sizes and a fixed period, maximising aggregate net ROI = net PnL / C is equivalent to maximising net PnL. Public data does not reconstruct all counterfactual costs, fills and capital failures, so this plugin optimises conservative historical aggregate **price PnL** and explicitly labels its equivalence to price ROI at fixed capital. It must not average per-position ROE, substitute per-position log utility for chronological portfolio growth, invent starting capital, or claim a future/live optimal net ROI.

MAE/MFE are descriptive maximum adverse/favourable excursions. They do not choose an objective. An investor wanting sustainable compound growth should specify a whole-account expected-log-growth objective with feasible execution and drawdown/ruin constraints; the current public data cannot establish that objective exactly.

## Execution evidence and limitations

[Binance's copy-trading guide](https://www.binance.com/en/support/faq/detail/0b3a91eea664402f812fe41358c8a206), updated 2026-09-23, states that position TP/SL orders are not automatically updated/canceled after adding or partially closing a position. This conflicts with the former continuously moving average-entry stop model. Its [official settings screenshot](https://public.bnbstatic.com/image/cms/content/body/202609/9c98fb9a73a62c920f3430629bc3b996.png) separates portfolio stop from Position Risk and shows position TP 0–2,000% and SL 0–95%. Zero disables an exit. The supported research domain is therefore (none or integer SL 1..95) × (none or integer TP 1..2000).


## Exact finite-domain objective

Let `Pi_s(L,T)` be the sum of admitted copier price PnL under the declared static-anchor model, reentry behaviour and conservative OHLC reading `s`. The criterion is:

`(L*,T*) ∈ argmax_(L,T) min_s Pi_s(L,T)`.

Dividing every candidate by the same verified fixed capital does not change this optimum. Disabled is compared explicitly. Each of the 192,096 supported choices is evaluated or expanded from a proved never-hit equivalence class. All ties are retained; disabled then smaller integer thresholds determine the displayed representative. A coarse pass precedes complete integer refinement. Independent full-grid single-entry oracles and unmerged multi-fill enumeration guard the certificate.

Static orders use `P_SL = P_anchor × (1 − direction × L/(100×leverage))` and `P_TP = P_anchor × (1 + direction × T/(100×leverage))`. Additions change the copier's quantity and average cost, so a trigger's price PnL is `direction × quantity × (P_trigger − current_average)`. A short TP with a nonpositive price is unreachable, not an invented fill. The initial/reentry anchor is distinct from the dynamically averaged entry used by descriptive MAE/MFE.

Precompiled holding paths and per-barrier first-hit records define an acyclic graph of possible copier restarts. Scoring this graph avoids replaying all fills for every pair. Prefix extrema preserve chronological possible-start / mandatory-end clocks; competing barriers in one bar retain both first-hit branches. The browser yields and pauses/cancels the same deterministic core. It does not publish a candidate while the search or holdout is unfinished.

Binance's [performance-indicator definition](https://www.binance.com/en/support/faq/detail/54aa6d3b43bc4f6eb4a3a6e3aea40acd) uses PnL divided by MaxBaseBalance. This plugin does not label the counterfactual price model as that net account metric.

## Three requested historical snapshots

| Trader | Snapshot UTC | Admitted / closed | Historical joint SL | Historical joint TP | Lower-model improvement vs both disabled (lead-account USDT) |
| --- | --- | ---: | --- | --- | ---: |
| 玄冥二老 | 2026-10-01 20:52:31 | 138 / 239 | Disabled | Disabled | 0 |
| 星辰社区-海 | 2026-10-01 20:51:52 | 75 / 133 | 92% | Disabled | +37.88 |
| 熬鹰资本 | 2026-08-23 22:00:00 | 56 / 110 | 31% | 30% | +331,803.03 |

These are source-hashed archived price-model results. The age of 熬鹰资本's snapshot is explicit; no current recommendation or future profitability is inferred. The priority artifacts are local under `reports/exit-priority-<id>.json`. The reproducible full report uses `node scripts/review-exit-optimum.mjs --output reports/exit-optimum-review-2026-10-02.json.gz`, reading the canonical raw/minute caches through the shared cached-input reader. The compressed JSON is the one canonical full-grid report; its source receipts, complete curves, coverage exclusions and frozen-choice holdout retain the evidence.

### Frozen chronological holdout

| Trader | Cutoff UTC | Train / test | Pair selected on train (SL / TP) | Test price-PnL difference versus both disabled (lead-account USDT) |
| --- | --- | ---: | --- | ---: |
| 玄冥二老 | 2026-09-04 10:18:35.313 | 69 / 69 | Disabled / disabled | 0 |
| 星辰社区-海 | 2026-08-31 08:40:08.443 | 37 / 38 | Disabled / disabled | 0 |
| 熬鹰资本 | 2026-07-22 05:48:08.285 | 28 / 28 | 16% / 31% | −131,239.18 to −127,944.26 |

No position straddled these three cutoffs. The train-only choice was frozen; the held-out rows were never used for its selection. The zero results for 玄冥二老 and 海 reflect selecting the disabled baseline, not evidence that 海's full-history 92% stop passed validation. 熬鹰资本's train-selected exits lost to the disabled baseline on the later sample. Its full-history 31%/30% winner therefore remains an in-sample model result and is not promoted. Neither the earlier training pair nor the full-history pair is presented as a validated future net-ROI recommendation.

### Execution-model sensitivity

Applying the same static-model optimum under the former moving-average-anchor model gives price-PnL differences of 0 for 玄冥二老, −95.35 to −88.92 USDT for 海, and −66,871.27 to −44,857.27 USDT for 熬鹰资本. Thus a trigger-rule change can reverse a claimed benefit. These are fixed-pair sensitivity checks, not another optimisation or proof that either model matches undocumented live order details. They are retained with the negative holdout evidence.

## Insurance requested by the user

For 玄冥二老, the largest adverse excursion against the **initial fixed trigger anchor** among 138 admitted positions is 263.4559768% ROE. The tightest integer level with no possible trigger in replay is 264%, verified against every admitted position. This is outside Binance's 95% input maximum and is display-only. The 428.4% descriptive MAE figure uses the dynamically held average entry and the broader closed-row population, so it is a different quantity.

Within 1..95, no enabled level is historically never-triggered. The best enabled SL-only insurance candidate is 90%, with 4 certain / 13 possible affected positions. Both-disabled price PnL is 2,323.6053 USDT; at 90% the price-model range is 652.3337–2,216.6042, costing 107.0011–1,671.2716 USDT. This trades historical profit for an exit rule; it does not preserve the maximum ROI. The 101 excluded positions and future prices are not covered by the no-trigger statement.

When a supported no-trigger candidate does exist, the UI states whether it also ties the historical optimum. Preserving the no-SL baseline need not preserve a superior positive-SL optimum. All locales distinguish free historical insurance, least-cost insurance, missing coverage and future uncertainty. The form filler refuses out-of-range diagnostics.

## External boundaries

Public docs do not identify actual copy-order quantity versus whole-position close mode or MARK versus CONTRACT trigger feed. Whole-position exact-threshold MARK exits are disclosed assumptions. Counterfactual costs/funding, daemon/order latency, tick rounding, available capital, liquidation, copier failures and profit-share changes are not reconstructed. Tight orders can fail creation. Anonymous setting-page access returned a WAF challenge, so actual logged-in DOM parity cannot be asserted; field mapping requires unique visible Position Risk/range/label evidence and fails closed otherwise. No credentials/private endpoints or setting submission are used.

Chronological diagnostics choose only on the preceding half, exclude positions spanning the cutoff, and freeze the pair on the subsequent half. Fee-calibrated full-snapshot equity is not used. An in-sample optimum or a positive price-only holdout is not a deployment promotion.

## Performance root-cause evidence

The initial fill-branching grid was replaced by precompiled static restart paths and first-hit records; the independent replay oracle remains the guard for this change. Sampling the long report found repeated contextified-VM global getter callbacks in its hot graph (physical footprint about 337 MB, not an unbounded-memory explanation). The cached-input/research loader now compiles the same trusted production source into an explicit window namespace in the host realm, avoiding that research-only proxy tax. Browser source and parameter semantics are unchanged. The completed full three-trader report matches the earlier VM priority settings and price-PnL results. Both superseded report jobs retain their interrupted receipts instead of being called successful.

Numerical ties use the selector's declared floating-point tolerance (1e-8 lead-account USDT for joint scores); the 1% parameter domain is exact, and disabled is valid. A computed tie set is not a confidence interval or a claim of future equality.

## Verified artifacts and gates

- Production selector SHA-256: `47788cb1c1c0f62b9c3f1260e81021c61a27d5eecb90f811414f0c2e046f7b66`.
- Canonical compressed full-grid report: `reports/exit-optimum-review-2026-10-02.json.gz`, 3,288,950 bytes, SHA-256 `4b53e33f2ced63982c7f6f78ea92a5e7aef84a422e8136004a7143088f2ef2de`.
- Extension package: `dist/copy-trading-lens-0.1.8.zip`, 198,454 bytes, SHA-256 `b820c02afc12a539020bf96d4603774dae3f5c913aa169cf694da5b96de78a08`. All 24 archived files match the canonical workspace files byte for byte (32 ZIP entries including directories).
- All 23 `npm test` suites and `npm run validate` passed: `/tmp/copylens-exit-final-gates.state.json`, actual exit code 0.
- Final locale sync, UI regression, validation and packaging passed: `/tmp/copylens-exit-final-text-package.state.json`, actual exit code 0.
- Full three-trader research and the latest never-triggered-insurance tie regression passed: `/tmp/copylens-joint-host-final-report.state.json`, actual exit code 0.
- Complete grid/tie-set validation, priority-result parity, source receipt, package byte parity and gate receipt verification passed: `/tmp/copylens-exit-artifact-verification.state.json`, actual exit code 0.
- Independent checks cover 1,280 joint replay cases, 640 OHLC timing comparisons, complete 192,096-cell analytical grids, representative seeded controls, capital-scale invariance, invalid-input failure/recovery, safe field rollback, pause/cancel and superseded publication.

Raw snapshot and minute-mark hashes, cutoffs, exclusion lists, all candidate scores, tied optima and frozen holdout results are retained in the full report. Local data and derived artifacts are intentionally ignored by Git; source, regression tests and this evidence review are versioned. No exchange orders or account settings were submitted.
