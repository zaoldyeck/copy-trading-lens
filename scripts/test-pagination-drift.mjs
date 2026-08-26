// Regression test for the offset-pagination drift that silently truncated live
// order history in src/providers.js.
//
// Binance paginates these histories by offset over a NEWEST-FIRST list, and a
// lead trader keeps filling orders while the extension is reading it. Every fill
// that lands mid-pagination pushes the list down one index, so the next fixed
// offset window re-serves rows already held. The old code appended them anyway;
// the duplicates inflated the row count, the `rows.length >= total` stop fired
// early, and the oldest rows were never fetched at all.
//
// Live evidence (2026-08-26, portfolio 5156305122364875520): 1796 rows fetched,
// 2 of them duplicates, and the open position rebuilt from those fills came out
// 40 units short of the size the exchange reported. This test reproduces the
// same shift with a mocked server and asserts every original row is fetched
// exactly once, in order.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const providersSrc = readFileSync(path.join(__dirname, "../src/providers.js"), "utf8");

const PAGE_SIZE = 100;
const ORIGINAL_ROWS = 550;
// One new fill lands after each of the first three pages is served — the shape
// of a moderately active trader during a ~10 s read.
const INSERT_AFTER_PAGES = [1, 2, 3];

// Newest first, like the endpoint. `seq` descends so index 0 is the newest row.
let list = Array.from({ length: ORIGINAL_ROWS }, (_, index) => ({
  seq: ORIGINAL_ROWS - index,
  symbol: "BTCUSDT",
  executedQty: 1
}));
const originalSeqs = list.map((row) => row.seq);
let inserted = 0;
let pagesServed = 0;

function makeResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

global.fetch = async (url, options) => {
  if (url.includes("/lead-portfolio/order-history")) {
    const { pageNumber, pageSize } = JSON.parse(options.body);
    const start = (pageNumber - 1) * pageSize;
    const page = list.slice(start, start + pageSize);
    const total = list.length;
    pagesServed += 1;
    if (INSERT_AFTER_PAGES.includes(pagesServed)) {
      inserted += 1;
      list = [{ seq: ORIGINAL_ROWS + inserted, symbol: "BTCUSDT", executedQty: 1 }, ...list];
    }
    return makeResponse({ code: "000000", data: { list: page, total } });
  }
  if (url.includes("/lead-portfolio/position-history") || url.includes("/lead-portfolio/transfer-history")) {
    return makeResponse({ code: "000000", data: { list: [], total: 0 } });
  }
  if (url.includes("/lead-portfolio/detail")) {
    return makeResponse({ code: "000000", data: { nickname: "drift", startTime: 0 } });
  }
  if (url.includes("/lead-data/positions")) return makeResponse({ code: "000000", data: [] });
  if (url.includes("/home-page/query-list")) return makeResponse({ code: "000000", data: { total: 0, list: [] } });
  throw new Error(`Unexpected URL in test stub: ${url}`);
};

global.document = { cookie: "", documentElement: { lang: "en" }, body: { innerText: "" }, title: "" };
global.location = { href: "https://www.binance.com/en/copy-trading/lead-details/000000000000000000" };
global.window = global;

// eslint-disable-next-line no-eval
eval(providersSrc);

const raw = await global.CopyTradingLensProviders.fetchLeadData({ platform: "Binance", id: "000000000000000000" });
const fetchedSeqs = raw.orderHistory.map((row) => row.seq);

const duplicates = fetchedSeqs.length - new Set(fetchedSeqs).size;
assert.equal(duplicates, 0, `fetched ${duplicates} duplicate rows — the overlap trim did not fire`);

const missing = originalSeqs.filter((seq) => !fetchedSeqs.includes(seq));
assert.deepEqual(missing, [], `lost ${missing.length} of the original rows to pagination drift: ${missing.slice(0, 10).join(", ")}`);

const descending = fetchedSeqs.every((seq, index) => index === 0 || fetchedSeqs[index - 1] > seq);
assert.ok(descending, "rows must stay in newest-first order after the overlap trim");

assert.ok(
  raw.historyStatus.orderHistory.duplicateRows >= INSERT_AFTER_PAGES.length,
  `the read raced ${INSERT_AFTER_PAGES.length} writes but reported duplicateRows=${raw.historyStatus.orderHistory.duplicateRows}`
);

console.log(`PASS: ${fetchedSeqs.length} rows, 0 duplicates, 0 lost, ${raw.historyStatus.orderHistory.duplicateRows} overlapping rows trimmed across ${INSERT_AFTER_PAGES.length} concurrent writes`);

// The rows that arrived mid-read are legitimately absent from this snapshot, so
// `fetched` lands below the (already grown) `total`. The two reconcile exactly
// through the trimmed overlap — if they ever stop reconciling, rows were lost.
assert.equal(
  raw.historyStatus.orderHistory.fetched + raw.historyStatus.orderHistory.duplicateRows,
  raw.historyStatus.orderHistory.total,
  "fetched + trimmed overlap must account for every row the endpoint reported"
);
assert.equal(raw.historyStatus.orderHistory.complete, true, "a snapshot that raced writes is still a complete read of what existed at T0");
