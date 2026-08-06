# Research CLI

Command-line tooling for researching Binance copy-trade lead traders outside
the browser — fetch a trader's full history, run the same risk analysis the
Chrome extension shows, discover/rank candidates, and generate a markdown
due-diligence report over many traders at once.

**Design rule: this tool never re-implements fetching or scoring logic.** It
runs `src/i18n.js`, `src/providers.js`, and `src/analysis.js` — the exact
files the Chrome extension ships — inside a Node `vm` context (see
`lib/runtime.mjs`). The extension and this CLI can never silently disagree
about what a "loss-period deposit" or a "grid" strategy is, because there is
exactly one implementation of each. If you need new fetch/scoring behavior,
add it to `src/`, not here.

## Usage

```sh
# Fetch one trader's full history (paged position/order/transfer history +
# performance windows), cache it under tools/cache/.
node tools/cli.mjs fetch Binance <portfolioId>

# Analyze a trader (fetches + caches first if not already cached), prints
# the full analyzeBinance()/analyzeOkx() result as JSON.
node tools/cli.mjs analyze Binance <portfolioId> [--force] [--lang zh_TW]

# Page through Binance's ranking list (/home-page/query-list) and list every
# trader ranked above a given portfolioId — e.g. "everyone better-ranked than
# a trader I already follow, so I can vet the ones above them."
node tools/cli.mjs rank-above <targetPortfolioId> \
  [--timeRange 30D] [--minDays 30] [--pageSize 20]

# Fetch + analyze a whole list of candidates (bounded concurrency) and write
# a markdown report with a sortable table, plus the raw summaries as JSON.
# <ranking.json> is an array of {rank, portfolioId, nickname, roi}, e.g. the
# output of rank-above piped to a file.
node tools/cli.mjs report <ranking.json> \
  [--out reports/name.md] [--concurrency 5] [--lang zh_TW]
```

Typical end-to-end flow — "who's better-ranked than a trader I follow, and
are any of them worth following instead":

```sh
node tools/cli.mjs rank-above <followedPortfolioId> --minDays 30 > /tmp/candidates.json
node tools/cli.mjs report /tmp/candidates.json --out reports/ranking-2026-08.md
```

## Modules (`lib/`)

- `runtime.mjs` — loads the extension's browser scripts into a Node `vm`
  context backed by native `fetch`. Also stubs `chrome.i18n.getMessage`
  against `_locales/<lang>/messages.json`, so output text (verdict titles,
  cautions, strategy family) is the same human-readable string the extension
  renders, not a raw i18n key and not a second translation table.
- `cache.mjs` — disk cache for fetched raw payloads, keyed by portfolioId.
  Gitignored (`tools/cache/`): a trader's state at fetch time, not a source
  artifact.
- `fetch-trader.mjs` — `fetchTrader()` / `fetchAndAnalyze()`, the call sites
  everything else builds on.
- `ranking.mjs` — iterates Binance's ranking list; `rankedAbove()` collects
  every entry ranked better than a target portfolioId.
- `batch.mjs` — bounded-concurrency batch runner (default 5 — Binance's
  history endpoints show real rate-limit pressure well before that).
- `report.mjs` — flattens an `analyzeBinance()` result into one summary row
  and renders a set of rows as a markdown table.

## Notes

- All endpoints used here are Binance's public "friendly" copy-trade APIs —
  no login/cookies required, same as the extension's own read path.
- `analyzeBinance()`'s order-history call can legitimately take a while for
  high-frequency traders (thousands of orders); `report`'s concurrency cap
  keeps a slow trader from blocking the whole batch.
- Reports are meant to be committed (`reports/*.md`) when they represent
  actual due-diligence work worth keeping — see CLAUDE.md §2.4. The cache
  backing them is not; re-run `fetch`/`report` to refresh.
