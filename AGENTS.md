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

3. **Stop-Loss Radar (`src/stoploss.js`, shown by `src/content.js`)**:
   - Per closed position, the deepest adverse ROE (price move x leverage) it went through while open, from MARK-price candles over its own life: 1-minute candles, and hourly candles only for the whole hours inside a hold longer than 6 h (`fetchBinancePositionMarks` in `src/providers.js`, `lifeCandles` in `src/stoploss.js`). Every symbol the positions touched is read; there is no symbol cap, and an hourly candle only partly inside a position is never counted (it lends the position its whole hour; traders like 玄冥二老 hold a median 1 minute).
   - The drawdown is judged against the entry that held at each moment: fills are replayed (adds move the average, reductions do not). Binance keeps only ~2 months of order history, so older positions fall back to the final `avgCost`.
   - Prices give the drawdown, `roi` gives the outcome. Binance's `closingPnl` (and so `roi`) is trade pnl PLUS funding, less fees, while a stop acts on price-only ROE. A row whose `roi` has the opposite sign from its prices is a correct row, not an error: 玄冥二老's TAIKOUSDT short (avgCost 0.290, avgClose 0.267, reported -52% / -91 USDT) paid 169 USDT of funding (nine hourly settlements at -0.4% to -2%) on top of +70 USDT of price pnl. Its 428% drawdown, a squeeze to 0.538, is real.
   - The recommendation maximises expected log growth, `mean(log(1 + f x outcome))`, where a stop at L turns every position whose adverse ROE reached L into -L and leaves the rest at their `roi`, and f is the lead's own margin share of equity at entry (equity count-back; a fixed-ratio copier inherits it). Without the count-back the risk-neutral limit (mean outcome) is used and the result says so. Candidates: no stop, then 10..95 step 5 (Binance's 0-95% field). The result carries the optimum, the stable band (candidates that beat the optimum in at least 10% of 300 seeded bootstrap resamples), the agreement share and the cost of the best actual stop. `stopOptional` means the data cannot tell a stop from none; the card then says so and offers the cheapest stop.
   - Never reintroduce a percentile rule (it maximised nothing: on 玄冥二老, 星辰社区-海 and 熬鹰资本 the old rule's stop cost 6.1 / 3.1 / 2.3 ROE points per position against no stop). Guarded by `scripts/test-stop-loss-radar.mjs` (known-optimum cases, corpus-measured parity numbers) and `scripts/test-position-marks.mjs`.
   - Dynamically translates the ROE % into equivalent price move % given the lead trader's dominant leverage.

4. **Testing & Validation**:
   - Run `npm test` and `npm run validate` before any delivery. Every suite listed in the `test` script must pass.
   - Commit locally; only execute `git push` once all tasks and tests are 100% complete and closed.

5. **Binance Copy Setting Page Support & Input Injection**:
   - URL routes `https://www.binance.com/*/copy-trading/*` and `https://www.binance.com/copy-trading/*` are matched in `manifest.json` to ensure content script injects on `copy-management` and initial SPA landing pages.
   - In `mode=copy`, `portfolioId` query param directly carries the lead trader ID.
   - In `mode=edit`, `portfolioId` query param is the copier's copy portfolio ID, NOT the lead trader. The lead trader must be recovered from evidence a content script can really read: a single trader link on the page, a card pairing harvested on `copy-management` (only when the card names exactly one trader and one copy portfolio), or a resource entry fetched after the current SPA route began. Anything ambiguous resolves to `null` (no panel) — a wrong trader means a stop-loss recommendation for the wrong person. Guarded by `scripts/test-lead-resolution.mjs`.
   - Content scripts run in Chrome's isolated world: the page's React fibers/props are invisible to them (developer.chrome.com content-scripts, "isolated worlds"). Never read `__reactFiber*`/`memoizedProps` in `src/`.
   - **Account safety (money-path)**: every request this extension makes is anonymous (`credentials: "omit"`, no `csrftoken`) and public-endpoint only (`/friendly/`, `/fapi/`, OKX `/public/`). Never call a `/private/` BAPI endpoint and never send the user's session cookie: the exchange session guards real funds, and automated traffic carrying it risks the exchange's risk engine invalidating or flagging it. Guarded by `scripts/test-request-identity.mjs`.
   - Form injection must use `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` to trigger React's synthetic input, change, and blur handlers.

6. **Progressive Incremental Streaming Pipeline (`src/providers.js` & `src/content.js`)**:
   - Network reads must never force users to wait for the entire depth (65+ pages of order history) before rendering.
   - `fetchBinanceLead` keeps one accumulating `view` and emits a snapshot of it per stage via `onProgressive`, so a slow piece finishing late can never overwrite a faster one with older state:
     - `detail`: metadata (~150ms).
     - `positions`: live exposure and position history; the radar already has a first reading from fills and close prices.
     - `marks`: mark candles for every position's own life, all symbols, read while the long histories below are still paging; the radar becomes precise.
     - `orders`: `orderHistory`, `transferHistory`, performance windows (strategy classification, entry-path replay for the radar).
     - the final return adds funding and hourly marks for EVERY symbol (equity count-back, biggest bet, the radar's margin share), read a few symbols at a time. No symbol caps anywhere: a cap silently drops the long tail of symbols, which on 玄冥二老 (52 symbols) hid a position from the worst-drawdown figure.

7. **Dedicated Copy Setting Advisor View (`src/content.js`)**:
   - On `copy-setting` pages (`context.pageType === "copy-setting"`), the overlay defaults to a compact, non-intrusive **Stop-Loss Advisor Card** (`ctl-setting-card`) instead of the full dashboard.
   - Provides instant decision value: Recommended ROE %, Equivalent underlying price drop %, the stable band, Win retention %, Worst historical drawdown cut-off, a note when the data cannot show a stop beats none or when position rows contradict themselves, and 1-Click React input injection.
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
