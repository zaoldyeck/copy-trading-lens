// Regression test for the loading pause requested by the overlay's "−" button.
// The provider must stop at the next request boundary and continue the same
// read after the caller releases the pause gate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(__dirname, "..", file), "utf8");

function response(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

let paused = false;
const waiters = [];
const waitUntilResumed = () => paused
  ? new Promise((resolve) => waiters.push(resolve))
  : Promise.resolve();
const resume = () => {
  paused = false;
  waiters.splice(0).forEach((resolve) => resolve());
};

const calls = [];
global.fetch = async (url) => {
  calls.push(url);
  // Pause immediately after the first request has answered. The performance
  // window fan-out must then wait instead of issuing five more requests.
  if (url.includes("/lead-portfolio/detail")) paused = true;
  if (url.includes("/lead-portfolio/detail")) return response({ code: "000000", data: { nickname: "paused", startTime: 0 } });
  if (url.includes("/home-page/query-list")) return response({
    code: "000000",
    data: { total: 1, list: [{ leadPortfolioId: "pause" }] }
  });
  if (url.includes("/lead-data/positions")) return response({ code: "000000", data: [] });
  if (url.includes("/lead-portfolio/position-history") || url.includes("/lead-portfolio/order-history") || url.includes("/lead-portfolio/transfer-history")) {
    return response({ code: "000000", data: { total: 0, list: [] } });
  }
  throw new Error(`Unexpected URL in test stub: ${url}`);
};

global.document = { cookie: "", documentElement: { lang: "en" }, body: { innerText: "" }, title: "" };
global.location = { href: "https://www.binance.com/en/copy-trading/lead-details/pause" };
global.window = global;

// eslint-disable-next-line no-eval
eval(read("src/providers.js"));
// eslint-disable-next-line no-eval
eval(read("src/positions.js"));

const reading = global.CopyTradingLensProviders.fetchLeadData(
  { platform: "Binance", id: "pause" },
  { waitUntilResumed }
);

await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls.length, 1, "the paused read must not start the next API batch");

await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(calls.length, 1, "the pause must remain effective while the overlay is closed");

resume();
await reading;
assert.equal(calls.length, 10, "reopening must continue the same read through the remaining endpoints");
console.log("PASS: provider pause gate stopped the next API batch and resumed the existing read");
