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
   - The backtest simulates the COPIER using the shared fill replay in `positions.js`. Admit only complete flat-to-flat fills reconciled to the position row’s open/close clocks and any available peak/closed-volume quantities, with continuous MARK coverage. Partial/missing histories feed descriptive excursion statistics only. Public MARK fetches must reject truncated, empty, duplicate or gapped requested pages instead of publishing partial success.
   - Copier closes mirror the lead’s fraction reduced, including after a copier-only stop and reentry. Stops are triggered from MARK candles, never from execution-price MAE; actual trigger witnesses and possible/certain trigger reachability must be retained independently of PnL ties.
   - OHLC does not locate extrema relative to intrabar fills. Branch possible stop/no-stop transitions for crossing candles, force stops on fully contained crossing candles, and merge only states with identical future holding/restart status. Keep conservative lower/upper price-model results and trigger reachability for both post-stop behaviours (stay out / follow later adds). These are bounds of a relaxed price-only model, not actual execution guarantees. Funding, fees, slippage and exact-threshold fill assumptions must be disclosed.
   - Compare no stop with EVERY integer ROE from 1 through 95, preserving the complete curve and all tied optima. Maximise the worse behaviour’s historical mean `log(1 + pricePnl / estimated equity at entry)` when every entry equity is finite and positive and its market data is priced; otherwise use total price PnL and disclose the fallback. Never inflate equity to future peak margin or clip ruin to a finite utility: capital wipeout has negative-infinite log utility. This per-position score is not chronological portfolio CAGR.
   - No stop may be a historical optimum. An enabled insurance value is the best enabled candidate, with deterministic ties to the tighter stop; the UI must distinguish it from the overall optimum. Bootstrap alternatives are sensitivity diagnostics, include exact ties, preserve disjoint sets, and are not a confidence interval. Only an actual no-stop optimum may be labelled optional; bootstrap uncertainty must not erase a positive sample optimum.
   - The card must state the objective, admitted/closed sample counts, gains and sacrifices in USDT, actual trigger counts, all integer outcomes and execution limitations. Never imply that log utility maximises total money, that any number between disjoint alternatives is equivalent, or that a stop guarantees maximum realised loss. Historical optimality must not be described as proven future optimality. MAE/MFE statistics describe maximum adverse/favourable ROE relative to the entry then held; neither is itself an optimisation objective.
   - Guard these rules with `scripts/test-stop-loss-radar.mjs`, `scripts/test-stop-loss-optimum.mjs`, `scripts/test-stop-loss-ui.mjs` and `scripts/test-position-marks.mjs`. `scripts/review-stoploss-optimum.mjs` shares the production selector and supports cached corpus parity, independent analytical controls and fixed-choice chronological holdout. Do not reintroduce a percentile recommendation.
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

6. **Progressive, Per-Piece Rendering (`src/providers.js` & `src/content.js`)**:
   - The card fills in as the read lands, and a value is drawn only when the pieces it is computed from have landed; until then its own place spins. Never a default or half-computed number: a stop level of 10% was once visible while the candles were still loading, and the inline "recommended" chip could show 50% for a trader with too little history. An insufficient radar carries `null`s, the chip is not mounted for it, and the radar itself is `null` until positions, marks, orders and market history have all landed.
   - `fetchBinanceLead` keeps one accumulating `view` with a `loaded` map (`detail`, `positions`, `marks`, `orders`, `market`) set by the fetch that lands each piece, and emits a snapshot per stage through `onProgressive`, so a slow piece finishing late can never overwrite a faster one with older state. The overlay draws from `raw.loaded` (`landed()` in `content.js`): detail-only fields first, win rate / payoff / loss hold once positions land, ROI / MDD / PnL / adverse adds / transfers once orders and performance land, biggest bet once market history lands, and the rating, risk lists and radar (everything) only when the read is complete. A snapshot without `loaded` (a cached read) counts as complete.
   - Marks can land after orders; the stage line keeps the furthest stage reached. The positions panel keeps its own page-by-page progress.
   - The final return adds funding and hourly marks for EVERY symbol (equity count-back, biggest bet, the radar's margin share), read a few symbols at a time. No symbol caps anywhere: a cap silently drops the long tail of symbols, which on 玄冥二老 (52 symbols) hid a position from the worst-drawdown figure.

7. **Dedicated Copy Setting Advisor View (`src/content.js`)**:
   - On `copy-setting` pages (`context.pageType === "copy-setting"`), the overlay defaults to a compact, non-intrusive **Stop-Loss Advisor Card** (`ctl-setting-card`) instead of the full dashboard.
   - Provides instant decision value: Recommended ROE %, Equivalent underlying price drop %, the stable band, Win retention %, Worst historical drawdown cut-off, the answer in words ("set N%" or "a stop is optional") with the why in the trader's own numbers (winners it would cut, losers it really saves, what each choice averages per position, the worst position as the insurance case), and 1-Click React input injection.
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
   - The loading view MUST display an active rotation animation (`.ctl-spinner`, `.ctl-mini-spinner`, `@keyframes ctl-spin`) instead of a static unicode icon to provide unmistakable visual feedback.
