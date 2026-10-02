// Regression test for the order-history pagination hang fixed in src/providers.js.
//
// Binance's paged history endpoints report a `total` that can be far larger than
// what the endpoint will actually paginate to — observed live: page 62 onward
// returns an empty list forever while `total` still claims ~45000 rows. The old
// code treated any short page before `total` as a transient blip and retried the
// same page number forever, hanging indefinitely for any lead trader whose real
// order count exceeds that hidden depth limit. This test simulates exactly that
// server behavior with a mocked fetch and asserts the fetch terminates, keeps the
// rows it did collect, and reports the batch as incomplete instead of hanging or
// silently claiming completeness.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const providersSrc = readFileSync(path.join(__dirname, "../src/providers.js"), "utf8");

const DEPTH_LIMIT_PAGES = 61; // matches the live-observed order-history cutoff
const REPORTED_TOTAL = 45108; // matches the live-observed (misleading) total
const PAGE_SIZE = 100;

let orderHistoryCalls = 0;
const requestedDelays = [];

function makeResponse(body) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body)
  };
}

global.fetch = async (url, options) => {
  if (url.includes("/lead-portfolio/order-history")) {
    orderHistoryCalls += 1;
    const payload = JSON.parse(options.body);
    const pageNumber = payload.pageNumber;
    const list = pageNumber <= DEPTH_LIMIT_PAGES
      ? Array.from({ length: PAGE_SIZE }, (_, i) => ({ orderId: (pageNumber - 1) * PAGE_SIZE + i }))
      : [];
    return makeResponse({ code: "000000", data: { list, total: REPORTED_TOTAL } });
  }
  if (url.includes("/lead-portfolio/position-history") || url.includes("/lead-portfolio/transfer-history")) {
    return makeResponse({ code: "000000", data: { list: [], total: 0 } });
  }
  if (url.includes("/lead-portfolio/detail")) {
    return makeResponse({ code: "000000", data: { nickname: "test", startTime: 0 } });
  }
  if (url.includes("/lead-data/positions")) {
    return makeResponse({ code: "000000", data: [] });
  }
  if (url.includes("/home-page/query-list")) {
    return makeResponse({ code: "000000", data: { total: 0, list: [] } });
  }
  // Funding and mark-price reads for the fetched fills (src/providers.js fetchBinanceMarketHistory).
  if (url.includes("/fapi/v1/fundingRate") || url.includes("/fapi/v1/markPriceKlines")) return makeResponse([]);
  throw new Error(`Unexpected URL in test stub: ${url}`);
};

global.document = { cookie: "", documentElement: { lang: "en" }, body: { innerText: "" }, title: "" };
global.location = { href: "https://www.binance.com/en/copy-trading/lead-details/000000000000000000" };
global.window = global;

// Record the production schedule without spending wall time on page pacing and
// jittered retries. The independent watchdog below still uses real time, so an
// unbounded retry loop fails instead of passing on a slower host.
const deterministicMath = Object.create(Math);
deterministicMath.random = () => 0;
const harness = vm.createContext({
  window: {}, document: global.document, location: global.location, fetch: global.fetch,
  Math: deterministicMath,
  setTimeout(callback, ms) {
    requestedDelays.push(ms);
    return setImmediate(callback);
  }
});
vm.runInContext(providersSrc, harness);
vm.runInContext(readFileSync(path.join(__dirname, "../src/positions.js"), "utf8"), harness);

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not terminate within ${ms}ms — pagination hang regression`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const started = Date.now();
const raw = await withTimeout(
  harness.window.CopyTradingLensProviders.fetchLeadData({ platform: "Binance", id: "000000000000000000" }),
  15000
);
const elapsedMs = Date.now() - started;

assert.equal(raw.orderHistory.length, DEPTH_LIMIT_PAGES * PAGE_SIZE, "should keep every row fetched before the depth limit");
assert.equal(raw.historyStatus.orderHistory.complete, false, "must report incomplete instead of silently claiming completeness");
assert.ok(raw.historyStatus.orderHistory.lastRetryError.includes("depth limit"), "must explain why it stopped");
assert.ok(orderHistoryCalls < 200, `retry storm: made ${orderHistoryCalls} order-history calls, expected a small bounded number`);
assert.equal(orderHistoryCalls, DEPTH_LIMIT_PAGES + 4, "the empty depth-limit page gets exactly three bounded retries");
assert.deepEqual(requestedDelays.filter((ms) => ms !== 120), [500, 1000, 2000], "preserve production backoff instead of bypassing retries");
assert.ok(elapsedMs < 15000, "must terminate, not hang");

console.log(`PASS: terminated in ${elapsedMs}ms after ${orderHistoryCalls} order-history calls, fetched ${raw.orderHistory.length}/${REPORTED_TOTAL} rows, complete=${raw.historyStatus.orderHistory.complete}`);

// A short page can also recover before the retry bound. The deterministic clock
// must preserve that transition rather than shortcutting all short pages to EOF.
const repairedRows = Array.from({ length: 250 }, (_, orderId) => ({ orderId }));
let repairCalls = 0;
let secondPageCalls = 0;
harness.fetch = async (url, options) => {
  if (!url.includes("/lead-portfolio/order-history")) return global.fetch(url, options);
  repairCalls += 1;
  const { pageNumber, pageSize } = JSON.parse(options.body);
  const transient = pageNumber === 2 && ++secondPageCalls <= 2;
  return makeResponse({ code: "000000", data: {
    list: transient ? [] : repairedRows.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
    total: repairedRows.length
  } });
};
requestedDelays.length = 0;
const repaired = await withTimeout(
  harness.window.CopyTradingLensProviders.fetchLeadData({ platform: "Binance", id: "000000000000000000" }),
  15000
);
assert.equal(repairCalls, 5, "a transient short page retries the same offset and resumes subsequent pages");
assert.equal(repaired.historyStatus.orderHistory.complete, true, "a recovered read publishes complete history");
assert.deepEqual(Array.from(repaired.orderHistory, (row) => row.orderId), repairedRows.map((row) => row.orderId), "recovery preserves every row exactly once");
assert.deepEqual(requestedDelays.filter((ms) => ms !== 120), [500, 1000], "recovery uses the same bounded production backoff");
console.log("PASS: transient short-page recovery retains all 250 rows without duplicate or missing fills");
