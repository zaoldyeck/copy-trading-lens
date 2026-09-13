// Regression test: the pagination-drift overlap trim must not eat genuine rows.
//
// The trim in src/providers.js drops the head of a page when it equals the tail
// of what is already held, on the theory that the list shifted. But a list only
// shifts when rows are prepended, and a scalper's split fills are routinely
// byte-identical (same second, same price, same size). When such a run of fills
// straddles a page boundary on an account that is NOT trading during the read,
// the old trim still matched and silently deleted real fills.
//
// Live evidence (2026-09-13, a 5,374-fill copy portfolio read through the same
// trim ported to Python): 5,374 fills reported, 5,369 kept,
// "5 duplicates" — yet the account's summary was identical before and after the
// read, and the kept fills reconciled 4.58 USDT short of the exchange's realized
// P&L. Bounding the trim by how much `total` grew restored all 5,374.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const providersSrc = readFileSync(path.join(__dirname, "../src/providers.js"), "utf8");

const PAGE_SIZE = 100;
const ROWS = 250;
// Rows 97..104 (0-based) are one burst of identical fills straddling the page-1/2
// boundary; rows 196..203 straddle page 2/3. Everything else is distinct.
const BURSTS = [[97, 104], [196, 203]];

const list = Array.from({ length: ROWS }, (_, index) => {
  const burst = BURSTS.findIndex(([lo, hi]) => index >= lo && index <= hi);
  return burst >= 0
    ? { symbol: "LSKUSDT", side: "BUY", executedQty: 100, avgPrice: 0.5, orderTime: 1_789_000_000_000 + burst }
    : { symbol: "LSKUSDT", side: "BUY", executedQty: 100, avgPrice: 0.5, orderTime: 1_788_000_000_000 - index };
});

function makeResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

global.fetch = async (url, options) => {
  if (url.includes("/lead-portfolio/order-history")) {
    const { pageNumber, pageSize } = JSON.parse(options.body);
    const start = (pageNumber - 1) * pageSize;
    // Idle account: the list never changes during the read.
    return makeResponse({ code: "000000", data: { list: list.slice(start, start + pageSize), total: list.length } });
  }
  if (url.includes("/lead-portfolio/position-history") || url.includes("/lead-portfolio/transfer-history")) {
    return makeResponse({ code: "000000", data: { list: [], total: 0 } });
  }
  if (url.includes("/lead-portfolio/detail")) {
    return makeResponse({ code: "000000", data: { nickname: "identical", startTime: 0 } });
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
const status = raw.historyStatus.orderHistory;

assert.equal(raw.orderHistory.length, ROWS, `kept ${raw.orderHistory.length} of ${ROWS} rows — identical fills at a page boundary were trimmed as drift on an idle list`);
assert.equal(status.duplicateRows, 0, `reported ${status.duplicateRows} duplicates although the list never shifted`);
assert.deepEqual(raw.orderHistory, list, "rows must come back exactly as served, in order");

console.log(`PASS: ${raw.orderHistory.length}/${ROWS} rows kept on an idle list with identical fills straddling page boundaries`);
