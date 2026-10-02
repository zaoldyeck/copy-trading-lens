# Stop-loss optimiser review — archived 0.1.7

This records the delivered 0.1.7 model and its dated results. The objective and execution model are superseded by [the joint exit review](exit-optimization-review.md); these numbers must not be read as current recommendations. Re-running the script now uses the current static-anchor price-PnL selector.

## Tracked requirements

- [x] Explain MAE/MFE, the objective, and why a historical optimum can be none or tied.
- [x] Calculate the three user-named traders (玄冥二老, 海, 熬鹰资本) and fixed-choice chronological holdout; disclose each data cutoff.
- [x] Compare no stop and every integer ROE from 1% through 95%; retain the complete curve.
- [x] Verify fill replay, partial exits/reentry, incomplete histories, candle timing and sizing/ruin boundaries.
- [x] Correct uncertainty/insurance labels and disclose price-only execution assumptions in all locales.
- [x] Add regression evidence, real cached cases and independent controls; all 20 npm test suites and extension validation passed (exit 0).
- [x] Update durable project invariants and review the final source diff.
- Final Git delivery: local commit and one push after all gates; completion is recorded in `reports/stoploss-optimum-delivery.json`.

## Review scope

The existing optimiser compares no stop with 10..95 in steps of five, using the worse of two post-stop behaviours. It optimises a per-position historical log utility when reconstructed entry equity is usable, otherwise total price PnL. This is an empirical policy score, not an exact executable portfolio compound return or a guarantee of future optimality.

The task adds the user's explicit 1% granularity. No account settings or orders are changed.

## Mathematical definition

For a fixed-entry long, margin ROE is `r(t) = leverage * (mark(t) / entry - 1) * 100`; reverse its sign for a short. `MAE = max(0, -min r(t))`, `MFE = max(0, max r(t))`. Entries move with adds and remain unchanged by reductions, so the implementation replays the entry that existed at each instant. OHLC excursions are observational estimates, not tick-exact measurements. MFE is descriptive here: optimising a stop does not require adding a take-profit policy.

The chosen objective is `U(L) = min_behaviour mean_i log(1 + pricePnl_i_lower(L) / equity_i_at_entry)` where entry equity is usable. A nonpositive wealth factor has utility negative infinity. Otherwise the objective is total lower-model price PnL. The lower PnL is computed by branching over unknown OHLC order, while retaining both stay-out and later-add-following behaviours. These are conservative bounds of a relaxed model, not guaranteed actual fills. The complete finite domain is `none, 1, 2, ..., 95`. A maximiser exists for finite valid scores, may be none, and may be tied. Ties prefer none, then the tighter enabled stop; every tied optimum remains in the result. This is a historical policy score, not a claim about chronological portfolio CAGR or future optimum.

The original percentile rule and a 5% grid cannot establish this 1% optimum. The former has no explicit objective; the latter can miss e.g. a 37% optimum between 35% and 40%.

## Root causes corrected

- Incomplete fill paths could enter as zero-price-PnL closed positions. Admission now requires a complete flat-to-flat replay and row-clock/quantity reconciliation.
- Execution-price MAE could be counted as a MARK stop trigger. Counts now derive from actual simulation witnesses and separate possible/certain reachability.
- A stopped copier following a later add closed the lead's absolute units. It now closes the same fraction of the lead's then-current quantity.
- Fixed all-overlap and contained-only candle readings could understate scale-in loss. Dynamic branching with dominance merging preserves a conservative lower/upper model envelope. An independent reproduced example changes the lower result from -5 to -48.2 USDT after a nine-unit add.
- Missing market pages could be treated as complete. Provider pages now require the exact requested contiguous semantic timestamps; gaps fail closed and can recover on repair.
- The growth score inflated equity from future peak margin and clipped bankruptcy to a finite loss. Invalid/unpriced estimates now fall back explicitly; genuine log ruin has negative-infinite utility.
- Exact ties disappeared from the bootstrap alternatives, disjoint sets were displayed as continuous, and uncertainty could erase a positive historical optimum. These presentation/selection boundaries are corrected.
- UI money/utility, stop guarantees and default 5%-10% claims were misleading. All four locales disclose the objective, admission coverage, full 1% curve, costs and execution limits; MAE/MFE are shown as statistics.
- Positive price equivalents are preserved at small 1% ROE thresholds (1% at 50x is 0.02%); a zero-duration fill interval and a candle beginning at the exact close do not borrow future exposure.

## External evidence and limits

- [NinjaTrader statistics definitions](https://ninjatrader.com/support/helpguides/nt8/statistics_definitions.htm) defines MAE/MFE as maximum adverse/favourable price excursions; backtests use bar highs/lows.
- [Binance copy-trading rules](https://www.binance.com/en-NG/support/faq/detail/30f1e3a2835345e0b8ffc87f261a8256) specifies proportional partial closes, copier-specific fees, slippage and available-balance constraints.
- Public OHLC has no tick order around fills. Public histories can omit fills; excluding them can bias the sample. The UI and report disclose coverage, and no synthetic fill fills the gap.
- Counterfactual fees, funding, daemon latency, slippage, copier-specific capital limits and liquidation/margin changes are not reconstructed. The optimised quantity is price PnL/utility, not net executable profit. Existing lead net PnL is separately compared in the report.
- The strict chronological check uses price PnL because full-snapshot equity calibration includes later fee observations. It selects on the first half only, excludes positions spanning the cutoff and freezes the chosen value for the second half. It is diagnostic and does not promote a threshold.

## Three requested traders

All percentages below are margin ROE. Only complete matched closed trades are scored. The archived snapshots are read locally; these are explicitly historical results. Source hashes and all 96 scores are in `reports/stoploss-optimum-review-2026-10-02.json`, reproducible with `node scripts/review-stoploss-optimum.mjs --output reports/stoploss-optimum-review-2026-10-02.json` when the canonical local caches are present.

| Trader | Snapshot cutoff (UTC) | Scored / closed | Full-sample historical optimum | Best enabled insurance candidate |
| --- | --- | ---: | --- | ---: |
| 玄冥二老 | 2026-10-01 20:52:31 | 138 / 239 | No stop | 94% |
| 星辰社区-海 | 2026-10-01 20:51:52 | 75 / 133 | No stop | 85% |
| 熬鹰资本 | 2026-08-23 22:00:00 | 56 / 110 | 30% | 30% |

Both equity-normalised historical utility and price-PnL give the same overall optimum for these three snapshots. An insurance value is conditional on insisting on an enabled stop; it is not the overall optimum when none wins. The age of 熬鹰资本’s snapshot prevents describing its 30% as a current setting recommendation.

At 30%, 熬鹰资本’s full-sample lower-model price PnL increases by about 24,197 USDT: one trade improves by about 32,481 and one worsens by about 8,284. This is the requested benefit-versus-sacrifice calculation, with lead-account price PnL units, before funding, fees and slippage.

The strict chronological price-PnL check picks no stop in the first half for 玄冥二老 and 海. 熬鹰资本’s first half picks 17%, then its fixed 17% loses about 84,010 USDT relative to no stop in the heldout half. That rejection is retained; neither its all-history 30% nor the failed 17% is proven to be optimal in future/live execution.

## Verification record

The independent analytical oracle compares every one of the 96 candidate scores/PnLs over 12 fixtures and two objectives (24 evaluations), including unlabelled deterministic long/short controls. A separate exhaustive no-merge reference verifies 640 add/reduce/timing cases against dominance merging and trigger reachability. The real-case report matches production source SHA256 `31f8d655e216d362663580a7c5a759baa7b89d23072266b3f4237a89f3af2af5`.

Regression coverage includes an optimum at 37% missed by the prior 5% grid, no-stop and full tie sets, true bankruptcy utility, missing/invalid equity, MARK-versus-fill trigger identity, reentry reduction fractions, uncertain add/partial-close ordering, equal-PnL trigger reachability, missing/gapped data and repair, zero-duration fills, exact-close candle boundaries, 1% price-equivalent precision, disjoint bootstrap alternatives, truthful utility/insurance rendering and all 95 enabled outcomes. The cached corpus loses one 海 row and three 熬鹰资本 rows from selection because their fills fail the new complete-replay admission; they remain in descriptive history rather than being assigned invented outcomes.

Final package: `dist/copy-trading-lens-0.1.7.zip`. Its manifest and changed runtime scripts were independently matched byte-for-byte to the validated source. All work processes have completed; retained check and review receipts record exit 0.
