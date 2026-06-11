## Context

The extension runs on Binance/OKX lead pages and can call same-origin APIs with the user's normal browser session. Binance exposes detailed `lead-portfolio/detail`, `position-history`, `order-history`, `transfer-history`, current positions, and a `home-page/query-list` endpoint for standard ROI/MDD windows. The existing implementation already uses historical orders/positions for behavior analysis, but the headline ROI/MDD can still fall back to 0 when the 30D list scan misses the trader.

## Goals / Non-Goals

**Goals:**
- Make Binance headline performance live, page-local, and independent from the user's currently selected page range.
- Prefer reconstructed all-period performance from historical position/transfer/current-capital data.
- Keep exchange-provided 7D/30D/90D/180D/365D ROI/MDD as live cross-checks.
- Make unknown or partial data explicit instead of displaying 0.

**Non-Goals:**
- Building a static trader database.
- Guaranteeing exact exchange-internal ROI when Binance does not expose every cash-flow or fee component.
- Adding remote services, analytics, or credential persistence.

## Decisions

1. **Use reconstructed all-period performance as Binance primary metric.**
   - Compute gross deposits, withdrawals, current equity, net profit, and simple ROI from `transfer-history` plus `detail.marginBalance`.
   - Use closed position history for realized PnL, win/loss behavior, expectancy, holding-time, adverse-add, and strategy inference.
   - Rationale: this aligns with the user's requirement to calculate from first trade to now and avoids current UI time-range dependence.

2. **Fetch Binance standard windows by nickname + portfolio id.**
   - Fetch detail first to obtain nickname.
   - Query `home-page/query-list` for each standard window using the nickname filter, then match `leadPortfolioId`.
   - Fall back to a bounded page scan only if nickname filtering misses.
   - Rationale: nickname filtering is live and avoids downloading the entire leaderboard on every page.

3. **Preserve data quality flags.**
   - Provider returns `historyStatus` with `total`, `fetched`, `complete`, and `pages`.
   - Analysis returns `meta.performanceSource`, `meta.performanceQuality`, and `meta.performanceWindows`.
   - Rationale: users need to know whether a number is reconstructed, exchange-provided, partial, or unavailable.

4. **Never coerce missing ROI/MDD to zero.**
   - Use `null` for missing performance fields.
   - UI formatters render `N/A`.
   - Rationale: 0 is a valid metric and must not mean "not fetched".

## Risks / Trade-offs

- Binance may not expose complete historical transfer or position pages for every trader. Mitigation: fetch until exchange-reported total or max safety page limit, then display completeness.
- Reconstructed ROI can differ from Binance's internal ROI because of fees, funding, unrealized PnL treatment, and cash-flow timing. Mitigation: label it as cash-flow reconstruction and show exchange windows beside it.
- Fetching many pages can be slower for high-frequency traders. Mitigation: page fetches are bounded and only happen for the current lead page.
