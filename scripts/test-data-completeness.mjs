// Regression test: a temporary refusal must never end a read, and an incomplete read must
// never produce a recommendation.
//
// Live incident (2026-09-13): Binance answered order-history with code 90801003
// (請求次數過多, too many requests) for two lead traders. The fetcher did not treat that code
// as retriable, gave up, and the analysis read the empty order history as "no martingale, no
// grid" — then titled both traders 可小額測試候選 (worth a small test copy).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(__dirname, "..", file), "utf8");
const zhTwMessages = JSON.parse(read("_locales/zh_TW/messages.json"));

global.window = global;
global.chrome = {
  i18n: {
    // Like Chrome, return the raw message; src/i18n.js does the {n} interpolation itself.
    getMessage: (key) => zhTwMessages[key]?.message || "",
    getUILanguage: () => "zh_TW"
  }
};
global.document = { cookie: "", documentElement: { lang: "zh-TC" }, body: { innerText: "" }, title: "" };
global.location = { href: "https://www.binance.com/zh-TC/copy-trading/lead-details/000000000000000000" };

const ROWS = 150;
const orders = Array.from({ length: ROWS }, (_, index) => ({ symbol: "LSKUSDT", side: "SELL", executedQty: 1 + index, orderTime: 1_789_000_000_000 - index }));
const refusals = { orderHistory: 2, detail: 1, livePositions: 1 };
const calls = { orderHistory: 0, detail: 0 };

function respond(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}
const tooManyRequests = { code: "90801003", message: "請求次數過多", data: null, success: false };

global.fetch = async (url, options) => {
  if (url.includes("/lead-portfolio/order-history")) {
    calls.orderHistory += 1;
    if (refusals.orderHistory-- > 0) return respond(tooManyRequests);
    const { pageNumber, pageSize } = JSON.parse(options.body);
    const start = (pageNumber - 1) * pageSize;
    return respond({ code: "000000", data: { list: orders.slice(start, start + pageSize), total: ROWS } });
  }
  if (url.includes("/lead-portfolio/detail")) {
    calls.detail += 1;
    if (refusals.detail-- > 0) return respond(tooManyRequests, 429);
    return respond({ code: "000000", data: { nickname: "incident", startTime: 0, marginBalance: "5000" } });
  }
  if (url.includes("/lead-data/positions")) {
    if (refusals.livePositions-- > 0) throw new TypeError("Failed to fetch");
    return respond({ code: "000000", data: [] });
  }
  if (url.includes("/lead-portfolio/position-history") || url.includes("/lead-portfolio/transfer-history")) {
    return respond({ code: "000000", data: { list: [], total: 0 } });
  }
  if (url.includes("/home-page/query-list")) return respond({ code: "000000", data: { total: 0, list: [] } });
  throw new Error(`Unexpected URL in test stub: ${url}`);
};

// Same scripts, same order, as manifest.json: analysis.js reads styles decided
// by style.js, which rebuilds positions through positions.js.
for (const file of ["src/i18n.js", "src/providers.js", "src/positions.js", "src/style.js", "src/analysis.js"]) {
  // eslint-disable-next-line no-eval
  eval(read(file));
}

// 1. Refusals are retried until answered — on paged history, the detail call and the live call.
const raw = await global.CopyTradingLensProviders.fetchLeadData({ platform: "Binance", id: "000000000000000000" });
assert.equal(raw.historyStatus.orderHistory.error, undefined, `order history gave up: ${raw.historyStatus.orderHistory.error}`);
assert.equal(raw.orderHistory.length, ROWS, `kept ${raw.orderHistory.length} of ${ROWS} orders after two 90801003 refusals`);
assert.equal(raw.historyStatus.orderHistory.complete, true);
assert.ok(raw.endpointResults.detail.ok, `detail gave up after an HTTP 429: ${raw.endpointResults.detail.error}`);
assert.ok(raw.endpointResults.livePositions.ok, `live positions gave up after a network failure: ${raw.endpointResults.livePositions.error}`);
assert.ok(calls.orderHistory >= 4 && calls.detail >= 2, `expected retries, saw ${JSON.stringify(calls)}`);
console.log(`PASS: 90801003 ×2, HTTP 429 and a network failure were all retried until answered (${ROWS}/${ROWS} orders)`);

// 2. The incident's shape: an order history that did not arrive must not yield a recommendation.
const analysis = global.CopyTradingLensAnalysis;
const failed = {
  ...raw,
  orderHistory: [],
  historyStatus: { ...raw.historyStatus, orderHistory: { total: 0, fetched: 0, pages: 0, complete: false, error: "Binance order-history returned code 90801003: 請求次數過多" } }
};
const failedResult = analysis.analyzeBinance(failed);
assert.equal(failedResult.verdict.level, "incomplete", `a failed order history still produced verdict "${failedResult.verdict.level}"`);
assert.deepEqual(failedResult.verdict.positives, [], "an incomplete read must not list positives");
assert.deepEqual(failedResult.strategy.labels, [], "an incomplete read must not label a strategy");
assert.ok(failedResult.verdict.cautions.some((line) => line.includes(zhTwMessages.histOrder.message)), `the gap must name the missing history: ${JSON.stringify(failedResult.verdict)}`);

// 3. The exchange's depth cap: the read ended below the reported total, so it is also incomplete.
const capped = { ...raw, historyStatus: { ...raw.historyStatus, orderHistory: { ...raw.historyStatus.orderHistory, complete: false } } };
assert.equal(analysis.analyzeBinance(capped).verdict.level, "incomplete", "a depth-capped history must not be evaluated as complete");

// 4. Control: the complete read is evaluated normally.
assert.notEqual(analysis.analyzeBinance(raw).verdict.level, "incomplete", "a complete read must be evaluated");
console.log("PASS: failed or depth-capped histories yield 資料不完整，暫不評估 with no positives and no strategy labels; a complete read is evaluated");

// 5. OKX: its rate-limit refusal (50011) is retried; any other non-zero code is a failure the
// completeness gate must see, not an empty history.
{
  let okxRefusals = 1;
  global.fetch = async (url) => {
    if (url.includes("/follow-rank")) return respond({ code: "0", data: [{ ranks: [] }] });
    if (url.includes("/position-history")) {
      if (okxRefusals-- > 0) return respond({ code: "50011", msg: "Rate limit reached" }, 429);
      return respond({ code: "0", data: [] });
    }
    if (url.includes("/position-detail")) return respond({ code: "51000", msg: "Parameter error" });
    throw new Error(`Unexpected URL in OKX stub: ${url}`);
  };
  const okxRaw = await global.CopyTradingLensProviders.fetchLeadData({ platform: "OKX", id: "incident" });
  assert.ok(okxRaw.endpointResults.positionHistory.ok, `OKX 50011 was not retried: ${okxRaw.endpointResults.positionHistory.error}`);
  assert.equal(okxRaw.endpointResults.livePositions.ok, false, "an OKX non-zero code must surface as a failed endpoint");
  const okxResult = global.CopyTradingLensAnalysis.analyzeOkx(okxRaw);
  assert.equal(okxResult.verdict.level, "incomplete", `OKX with a failed endpoint produced verdict "${okxResult.verdict.level}"`);
  console.log("PASS: OKX 50011 retried until answered; a non-zero OKX code surfaces as a gap and blocks the verdict");
}
