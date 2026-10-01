# Copy Trading Lens - Agent Guidelines & Architecture Invariants

## Architecture & Code Invariants

1. **Order History Clocks Single Source**:
   - Order history rows contain multiple clocks (`orderTime` for placement, `orderUpdateTime` for fill).
   - Order fill times MUST ONLY be read via `global.CopyTradingLensPositions.fillTimeOf(order)` in `src/positions.js`.
   - Never directly access `.orderTime` or `.orderUpdateTime` anywhere in `src/` outside `src/positions.js`. This invariant is guarded by `scripts/test-fill-clock-single-source.mjs`.

2. **Binance Copy-Trading Input Semantics**:
   - In Binance copy-trading configuration, **「倉位風險 - 止損 (0-95%)」** measures **Margin ROE %**, NOT underlying asset price move %.
   - Equivalent underlying price drop: $\Delta P\% = \frac{\text{ROE}\%}{\text{Leverage}}$.
   - If a copier sets 5% or 10% under 10x leverage, positions stop out on a 0.5%~1% price noise tick, killing 50%+ of winning trades prematurely (Type I error).

3. **Optimal Position Stop-Loss Radar (`src/analysis.js` & `src/content.js`)**:
   - Uses Maximum Adverse Excursion (MAE) to evaluate the floating drawdown distribution across winning vs losing positions.
   - Recommends mathematically optimal stop-loss thresholds $L^*$ (bounded in Binance's [30%, 85%] range) that preserve $\ge 90\% \sim 95\%$ of winning trades while cutting off tail catastrophic holding losses ($> 100\%$ ROE drawdowns).
   - Dynamically translates the ROE % into equivalent price move % given the lead trader's dominant leverage.

4. **Testing & Validation**:
   - Run `npm test` and `npm run validate` before any delivery. All 13 test suites must pass.
   - Commit locally; only execute `git push` once all tasks and tests are 100% complete and closed.

5. **Binance Copy Setting Page Support & Input Injection**:
   - URL routes `https://www.binance.com/*/copy-trading/copy-setting*` are matched in `manifest.json`.
   - In `mode=copy`, `portfolioId` query param directly carries the lead trader ID.
   - In `mode=edit`, `portfolioId` query param is the copier's copy portfolio ID; the true lead trader ID is resolved via network resource entries (`leadPortfolioId` or `lead-portfolio/detail?portfolioId=`) and React fiber props.
   - Form injection must use `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` to trigger React's synthetic input, change, and blur handlers.
