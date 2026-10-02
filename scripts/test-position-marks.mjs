// The stop-loss radar reads each position's deepest adverse move from MARK-price candles over the
// position's own life, for EVERY symbol. These tests fix the plan (which windows, at which
// resolution) and the fetch (all symbols, exactly the candles needed, anonymous, one symbol's
// failure does not take the rest down). Background, measured 2026-10-02 on 玄冥二老 / 星辰社区-海 /
// 熬鹰资本: median hold 1 / 1 / 552 minutes; the old 25-symbol hourly read showed a worst loss of
// 23% where all symbols said 428%.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(__dirname, "..", file), "utf8");

const requests = [];
let failSymbol = null;
global.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  requests.push({ url: String(url), init, params: Object.fromEntries(u.searchParams) });
  assert.ok(["/fapi/v1/markPriceKlines", "/fapi/v1/fundingRate"].includes(u.pathname), `only public market data is read, got ${u.pathname}`);
  if (u.pathname === "/fapi/v1/fundingRate") return { ok: true, status: 200, text: async () => "[]" };
  const symbol = u.searchParams.get("symbol");
  if (symbol === failSymbol) return { ok: false, status: 400, text: async () => JSON.stringify({ code: -1121, msg: "Invalid symbol." }) };
  const step = u.searchParams.get("interval") === "1m" ? 60000 : 3600000;
  const start = Number(u.searchParams.get("startTime")); const end = Number(u.searchParams.get("endTime")); const limit = Number(u.searchParams.get("limit"));
  const rows = [];
  for (let t = start, n = 0; t <= end && n < limit; t += step, n += 1) rows.push([t, 100, 100 + (t / step) % 7, 90 - (t / step) % 5, 95, 0, t + step - 1]);
  return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
};
global.document = { cookie: "csrftoken=x; logined=y", documentElement: { lang: "en" }, body: { innerText: "" }, title: "" };
global.location = { href: "https://www.binance.com/en/copy-trading/lead-details/1" };
global.window = global;
// eslint-disable-next-line no-eval
eval(read("src/providers.js"));
const { planMarkWindows, fetchBinancePositionMarks, fetchBinanceMarketHistory } = global.CopyTradingLensProviders;

const MIN = 60000; const HOUR = 3600000;
const T0 = Date.UTC(2026, 8, 1, 10, 0, 0); // 10:00:00 sharp
const row = (symbol, opened, closed) => ({ symbol, opened, closed });
const plan = (rows) => planMarkWindows(rows);

// 1. a scalp is read entirely in minutes, from the minute it opened to the minute it closed
{
  const p = plan([row("AAAUSDT", T0 + 30000, T0 + 70000)]);
  assert.deepEqual(p.get("AAAUSDT").minutes, [[T0, T0 + MIN]]);
  assert.deepEqual(p.get("AAAUSDT").hours, []);
}

// 2. a long hold: minutes for the partial first and last hours, hours for the whole ones between
{
  const opened = T0 + 20 * MIN + 5000; const closed = T0 + 30 * HOUR + 40 * MIN;
  const w = plan([row("BBBUSDT", opened, closed)]).get("BBBUSDT");
  assert.deepEqual(w.minutes, [[T0 + 20 * MIN, T0 + HOUR - MIN], [T0 + 30 * HOUR, T0 + 30 * HOUR + 40 * MIN]]);
  assert.deepEqual(w.hours, [[T0 + HOUR, T0 + 30 * HOUR - HOUR]]);
}

// 3. opening exactly on the hour has no partial first hour
{
  const w = plan([row("CCCUSDT", T0, T0 + 8 * HOUR + 30 * MIN)]).get("CCCUSDT");
  assert.deepEqual(w.minutes, [[T0 + 8 * HOUR, T0 + 8 * HOUR + 30 * MIN]]);
  assert.deepEqual(w.hours, [[T0, T0 + 7 * HOUR]]);
}

// 4. windows of one symbol within 5 minutes share a request; further apart they do not
{
  const near = plan([row("DDDUSDT", T0, T0 + MIN), row("DDDUSDT", T0 + 4 * MIN, T0 + 5 * MIN)]).get("DDDUSDT").minutes;
  assert.deepEqual(near, [[T0, T0 + 5 * MIN]]);
  const far = plan([row("DDDUSDT", T0, T0 + MIN), row("DDDUSDT", T0 + 20 * MIN, T0 + 21 * MIN)]).get("DDDUSDT").minutes;
  assert.equal(far.length, 2);
}

// 5. open rows (no close time) have no outcome to judge and are not planned; rows without a symbol or an open time are ignored
{
  const p = plan([{ symbol: "EEEUSDT", opened: T0 }, { opened: T0 }, { symbol: "FFFUSDT" }, row("GGGUSDT", T0, T0 + MIN)]);
  assert.deepEqual([...p.keys()], ["GGGUSDT"]);
}

// 6. fetch: all 30 symbols are read (no top-N cap), each page asks for exactly the candles it needs,
//    and everything is anonymous
{
  requests.length = 0;
  const rows = Array.from({ length: 30 }, (_, i) => row(`SYM${i}USDT`, T0 + i * 7 * MIN, T0 + i * 7 * MIN + 3 * MIN));
  const result = await fetchBinancePositionMarks(rows, {});
  assert.equal(Object.keys(result.symbols).length, 30, "every symbol the positions touched is read");
  assert.deepEqual(result.failed, []);
  assert.equal(new Set(requests.map((r) => r.params.symbol)).size, 30);
  for (const r of requests) {
    assert.equal(r.params.interval, "1m");
    assert.equal(Number(r.params.limit), 4, "a 3-minute hold spans 4 minute candles, so limit is 4");
    assert.equal(r.init.credentials, "omit", "market data is read anonymously");
  }
  const first = result.symbols.SYM0USDT.minutes;
  assert.deepEqual(first.map((c) => c[0]), [T0, T0 + MIN, T0 + 2 * MIN, T0 + 3 * MIN]);
  assert.ok(first.every(([, high, low]) => high > low), "rows are [openTime, high, low]");
}

// 7. a long hold reads its middle in hourly candles, paged at 1500
{
  requests.length = 0;
  const hold = 100 * 24 * HOUR; // 100 days: 2,400 whole hours
  const result = await fetchBinancePositionMarks([row("LONGUSDT", T0 + 10 * MIN, T0 + hold + 10 * MIN)], {});
  const hourly = requests.filter((r) => r.params.interval === "1h");
  assert.equal(hourly.length, 2, "2,400 hourly candles take two pages of at most 1,500");
  assert.ok(hourly.every((r) => Number(r.params.limit) <= 1500));
  assert.equal(result.symbols.LONGUSDT.hours.length, 2399 + 1 - 1 + 1 - 1 + 0 || result.symbols.LONGUSDT.hours.length);
  const times = result.symbols.LONGUSDT.hours.map((c) => c[0]);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "rows come back sorted");
  assert.equal(new Set(times).size, times.length, "no candle twice");
  assert.ok(requests.filter((r) => r.params.interval === "1m").length === 2, "one minute window each for the partial first and last hour");
}

// 8. one symbol the exchange refuses is reported and dropped; the others are unaffected
{
  failSymbol = "BADUSDT";
  const result = await fetchBinancePositionMarks([row("BADUSDT", T0, T0 + MIN), row("GOODUSDT", T0, T0 + MIN)], {});
  failSymbol = null;
  assert.deepEqual(result.failed.map((f) => f.symbol), ["BADUSDT"]);
  assert.deepEqual(Object.keys(result.symbols), ["GOODUSDT"]);
}

// 8b. progress: one report per finished window, ending at done == total, for the loading bar
{
  const reports = [];
  const rows = Array.from({ length: 12 }, (_, i) => row(`P${i}USDT`, T0 + i * 7 * MIN, T0 + i * 7 * MIN + MIN));
  await fetchBinancePositionMarks(rows, { onProgress: (event) => reports.push(event) });
  assert.equal(reports.length, 12, "one report per window");
  assert.deepEqual(reports.map((report) => report.done), reports.map((_, i) => i + 1), "done counts up one at a time");
  assert.ok(reports.every((report) => report.total === 12));
  // the market history reports per symbol, failed or not
  const market = [];
  await fetchBinanceMarketHistory(["AAAUSDT", "BBBUSDT", "CCCUSDT"], T0, T0 + 5 * HOUR, { onProgress: (event) => market.push(event) });
  assert.deepEqual(market.map((report) => [report.done, report.total]), [[1, 3], [2, 3], [3, 3]]);
}

// 9. no rows, no requests
{
  requests.length = 0;
  const result = await fetchBinancePositionMarks([], {});
  assert.deepEqual(result, { symbols: {}, failed: [] });
  assert.equal(requests.length, 0);
}

console.log("PASS: position-life mark windows cover every symbol at the resolution of each hold, anonymously");
