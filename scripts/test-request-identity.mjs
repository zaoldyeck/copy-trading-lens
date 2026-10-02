// Account-safety invariant: the extension reads PUBLIC market and lead data, so
// none of its requests may carry the user's identity or touch an authenticated
// endpoint. A copy-trading user's Binance session guards real funds; an
// extension that sends the session cookie with a burst of automated requests
// (or calls /private/ endpoints without the page's own device headers) puts
// that session at the mercy of the exchange's risk engine.
//
// Every request src/providers.js makes must therefore:
//   1. use credentials: "omit" (no cookies, so the traffic is anonymous),
//   2. send no csrftoken header (it only has meaning together with a session),
//   3. never target a /private/ path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(__dirname, "..", file), "utf8");

const seen = [];
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
global.fetch = async (url, init = {}) => {
  seen.push({ url: String(url), init });
  if (url.includes("/lead-portfolio/detail")) return ok({ code: "000000", data: { nickname: "t", startTime: 0 } });
  if (url.includes("/home-page/query-list")) return ok({ code: "000000", data: { total: 1, list: [{ leadPortfolioId: "1" }] } });
  if (url.includes("/lead-data/positions")) return ok({ code: "000000", data: [] });
  if (/\/lead-portfolio\/(position|order|transfer)-history/.test(url)) return ok({ code: "000000", data: { total: 0, list: [] } });
  if (url.includes("/ecotrade/public/")) return ok({ code: "0", data: [] });
  throw new Error(`Unexpected URL in test stub: ${url}`);
};

// A live-looking session: if the provider reads cookies it will find these.
global.document = {
  cookie: "csrftoken=abc123; logined=y; p20t=session-secret",
  documentElement: { lang: "en" },
  body: { innerText: "" },
  title: ""
};
global.location = { href: "https://www.binance.com/en/copy-trading/lead-details/1" };
global.window = global;

// eslint-disable-next-line no-eval
eval(read("src/providers.js"));
// eslint-disable-next-line no-eval
eval(read("src/positions.js"));

const providers = global.CopyTradingLensProviders;
await providers.fetchLeadData({ platform: "Binance", id: "1", pageType: "lead-details" }, {});
// An edit-mode copy-setting read must not reach for the private copy-portfolio
// endpoints to learn the trader; it reads the public lead endpoints only.
await providers.fetchLeadData({ platform: "Binance", id: "1", pageType: "copy-setting", mode: "edit", copyPortfolioId: "9" }, {});
await providers.fetchLeadData({ platform: "OKX", id: "someTrader", pageType: "lead-details" }, {});
await providers.fetchBinanceListPage({ page: 1 }).catch(() => {});

assert.ok(seen.length >= 8, `expected a full read to issue requests, saw ${seen.length}`);
for (const { url, init } of seen) {
  assert.equal(init.credentials, "omit", `request must be anonymous (credentials: "omit"): ${url}`);
  const headerNames = Object.keys(init.headers || {}).map((name) => name.toLowerCase());
  assert.ok(!headerNames.includes("csrftoken"), `request must not carry a csrftoken header: ${url}`);
  assert.ok(!url.includes("/private/"), `request must not target an authenticated endpoint: ${url}`);
}
console.log(`PASS: all ${seen.length} requests were anonymous, token-free and public-endpoint only`);
