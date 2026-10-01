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
   - URL routes `https://www.binance.com/*/copy-trading/*` and `https://www.binance.com/copy-trading/*` are matched in `manifest.json` to ensure content script injects on `copy-management` and initial SPA landing pages.
   - In `mode=copy`, `portfolioId` query param directly carries the lead trader ID.
   - In `mode=edit`, `portfolioId` query param is the copier's copy portfolio ID; the true lead trader ID MUST ALWAYS be resolved via **authoritative BAPI (`/copy-portfolio/active-detail`)** and strictly verified DOM React fiber props (`props.copyPortfolioId === paramId`). Never match unverified cross-route performance resource entries to prevent cross-trader contamination in SPAs.
   - Form injection must use `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` to trigger React's synthetic input, change, and blur handlers.

6. **Progressive Incremental Streaming Pipeline (`src/providers.js` & `src/content.js`)**:
   - Network reads must never force users to wait for the entire depth (65+ pages of order history) before rendering.
   - `fetchBinanceLead` emits staged events via `onProgressive`:
     - Stage 1 (~150ms): `detail` metadata & live exposure.
     - Stage 2 (~300-500ms): `positionHistory` returns AND concurrently triggers `fetchBinanceMarkCandles` across position symbols. This provides true empirical 1-hour K-line Maximum Adverse Excursion (MAE) in under 600ms without blocking on order history or using static 50% fallbacks.
     - Stage 3 (~1-10s): background `orderHistory`, `transferHistory`, and funding rates finish and seamlessly update strategy classification (Martingale/Grid), adverse add rate, and biggest bet without blocking the UI.

7. **Dedicated Copy Setting Advisor View (`src/content.js`)**:
   - On `copy-setting` pages (`context.pageType === "copy-setting"`), the overlay defaults to a compact, non-intrusive **Stop-Loss Advisor Card** (`ctl-setting-card`) instead of the full dashboard.
   - Provides instant decision value: Recommended ROE %, Equivalent underlying price drop %, Win retention %, Worst historical drawdown cut-off, and 1-Click React input injection.
   - Preserves an explicit toggle button `[🔍 查看帶單員完整分析報告 ▾]` so users can expand to the full report on demand, and return at will.

8. **Scale-in & Martingale Mechanics in Binance Copy Stop-Loss**:
   - Binance's position risk stop-loss is evaluated on **aggregate position margin ROE %**, NOT initial placement price.
   - When a trader scales in / averages down (e.g. DCA / Martingale like 玄冥二老), the position's break-even price moves closer to market price, which **dilutes and improves** current floating ROE % ($|\Delta P| / \text{Margin}$).
   - This mathematically **widens / pushes out** the stop-loss price threshold (allowing more room for mean reversion) rather than triggering early stop-outs.
   - Stop-Loss Radar calculates MAE across the entire position life cycle ($[t_{\text{opened}}, t_{\text{closed}}]$) over real mark candles to ensure $L^*$ accommodates historical scale-in excursions without premature liquidation.

9. **Binance Copy-Trading Stop-Loss Execution & UI Invariants**:
   - **Backend Daemon vs Exchange Book**: Setting 「倉位止損 (0-95%)」 (`stopLostRate`) is handled by Binance's copy-trade risk daemon, NOT by submitting a Stop-Market conditional order to the futures matching engine. Thus, `/order/open-orders` returns empty and the position table `止盈/止損` column displays `-- / --`.
   - **「平倉價格」UI Misleading Translation**: In Binance's Traditional Chinese UI, the column titled 「平倉價格」 maps directly to `liqPrice` (Liquidation Price), not stop-loss trigger price. On cross margin with large balances, this remains virtually static and far from spot price.
   - **Continuous ROE Evaluation**: The risk daemon continuously checks floating $\text{ROE} = \text{Unrealized PnL} / \text{Margin}$ against the dynamic weighted average entry price (`entryPrice`). As the lead trader scales in, `entryPrice` updates dynamically. No static dollar price is ever anchored or displayed on screen.

10. **Multi-Locale Detection & Synchronization Invariant (`src/i18n.js` & `scripts/sync-i18n-dictionary.mjs`)**:
   - Chrome's `chrome.i18n.getMessage` binds only to the browser OS locale, ignoring webpage language (e.g. `/zh-TC/`).
   - Dictionaries are embedded directly into `src/i18n.js` (synced via `scripts/sync-i18n-dictionary.mjs` from `_locales/`).
   - Language resolution strictly prioritizes:
     1. URL pathname (`/zh-TC/`, `/zh-CN/`, `/ja/`, `/en/`)
     2. `document.documentElement.lang`
     3. `document.cookie` `lang` parameter
     4. Browser OS language fallback (`navigator.language` / `chrome.i18n.getUILanguage()`)
   - Regex matches MUST accept both hyphen and underscore separators (`/^zh[-_](?:TW|HK|MO|Hant|TC)/i`).

11. **SPA Route Interception & Visual Spin Animation Invariants**:
   - Next.js client-side navigation (`history.pushState` and `history.replaceState`) is intercepted in `src/content.js` to dispatch `ctl:locationchange` and trigger `scheduleRouteCheck(50)`. A 250ms polling loop serves as a resilient safety net for any missed events.
   - All loading badges, streaming tags, and cards MUST display active rotation animations (`.ctl-spin-icon`, `.ctl-mini-spinner`, `@keyframes ctl-spin`) instead of static unicode icons to provide unmistakable visual feedback.
