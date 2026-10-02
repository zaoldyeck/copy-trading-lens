// Copy-setting edit pages carry the COPY portfolio id in ?portfolioId=; the lead
// trader has to be recovered from what a content script can actually read.
// Chrome runs content scripts in an isolated world, so the page's React fibers
// are invisible to it (developer.chrome.com/docs/extensions/develop/concepts/
// content-scripts); only DOM, URLs and performance entries are real inputs.
// Measured 2026-10-02 on copy-management: its cards are <button>s, there are 0
// anchors to lead-details/copy-setting, and each card shows its trader's lead
// portfolio id as text ("投資組合 ID: N").
// A wrong trader here means a stop-loss recommendation for the wrong person on
// the user's own money, so every ambiguity must resolve to "unknown" (null).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(path.join(__dirname, "..", file), "utf8");

const HOST = "https://www.binance.com/zh-TC/copy-trading";
const editUrl = (copyId) => `${HOST}/copy-setting?mode=edit&portfolioId=${copyId}`;
const LEAD = { a: "1010101010101010101", b: "3030303030303030303" };

// A fake card: text node tree, smallest element first.
const card = (leadId, parent = null) => ({ innerText: `某帶單員\n投資組合 ID: ${leadId}\n調整餘額\n暫停\n設定`, parentElement: parent });
const button = (cardNode) => ({ innerText: "設定", parentElement: cardNode });
const emptyPage = () => ({ cookie: "", documentElement: { lang: "zh-TC" }, body: { innerText: "" }, title: "" });

const tabStorage = new Map(); // survives load() like a tab's sessionStorage survives a refresh

function load({ href, doc = emptyPage(), entries = [], now = 0 }) {
  delete global.CopyTradingLensProviders;
  global.location = { href, origin: "https://www.binance.com" };
  global.document = doc;
  global.window = global;
  global.sessionStorage = { getItem: (k) => tabStorage.get(k) ?? null, setItem: (k, v) => tabStorage.set(k, v) };
  global.performance = { now: () => now, getEntriesByType: () => entries };
  // eslint-disable-next-line no-eval
  eval(read("src/providers.js"));
  return global.CopyTradingLensProviders;
}

const limitInfo = (leadId, startTime) => ({
  name: `https://www.binance.com/bapi/futures/v1/private/future/copy-trade/copy-portfolio/get-limit-info?leadPortfolioId=${leadId}`,
  startTime
});

// 1. Copy mode: the URL id is the lead itself.
{
  const p = load({ href: `${HOST}/copy-setting?portfolioId=LEAD1` });
  assert.equal(p.detectLeadPage(`${HOST}/copy-setting?portfolioId=1111111111111111111`).id, "1111111111111111111");
}

// 2. Hard load of an edit page: every resource entry belongs to this document,
//    including ones fetched before the content script first looked.
{
  const p = load({ href: editUrl("2222222222222222222"), entries: [limitInfo("3333333333333333333", 120)], now: 9000 });
  assert.equal(p.detectLeadPage(editUrl("2222222222222222222")).id, "3333333333333333333", "hard load must accept entries from before first detection");
}

// 3. SPA navigation: entries from the previous route must not name this route's trader.
{
  const p = load({ href: `${HOST}/lead-details/4444444444444444444`, entries: [limitInfo("4444444444444444444", 100)], now: 5000 });
  assert.equal(p.detectLeadPage(editUrl("5555555555555555555")), null, "stale entries from the previous route must not be adopted");
}

// 4. Pressing a card's button then landing on an edit URL pairs that copy portfolio with that card's trader,
//    ahead of whatever stale entries the document holds.
{
  const p = load({ href: `${HOST}/copy-management`, entries: [limitInfo("4444444444444444444", 100)], now: 5000 });
  p.rememberPressedCard(button(card(LEAD.a)));
  assert.equal(p.detectLeadPage(editUrl("2020202020202020202")).id, LEAD.a, "the pressed card names the trader");
  // The press is consumed: a later edit URL with no press of its own is not guessed.
  assert.equal(p.detectLeadPage(editUrl("4040404040404040404")), null, "one press pairs one URL");
  // ...but the first pairing is remembered.
  assert.equal(p.detectLeadPage(editUrl("2020202020202020202")).id, LEAD.a);
}

// 5. The pairing survives a refresh of the tab (sessionStorage), without any press.
{
  const again = load({ href: editUrl("2020202020202020202") });
  assert.equal(again.detectLeadPage(editUrl("2020202020202020202")).id, LEAD.a, "a refreshed edit page keeps its trader");
}

// 6. Ambiguity resolves to unknown: a press on a wrapper of several cards, and a stale press.
{
  const wrapper = { innerText: `${card(LEAD.a).innerText}\n${card(LEAD.b).innerText}`, parentElement: null };
  const p = load({ href: `${HOST}/copy-management` });
  p.rememberPressedCard({ innerText: "設定", parentElement: wrapper });
  assert.equal(p.detectLeadPage(editUrl("5050505050505050505")), null, "a press landing on a wrapper names no single trader");

  p.rememberPressedCard(button(card(LEAD.b)), Date.now() - 6000);
  assert.equal(p.detectLeadPage(editUrl("6060606060606060606")), null, "a press older than the navigation window is not evidence");
}

// 6. Nothing in the extension may read React fibers: the isolated world cannot see them.
for (const file of ["src/providers.js", "src/content.js", "src/positions-panel.js"]) {
  assert.ok(!/__reactFiber|__reactProps|memoizedProps|memoizedState/.test(read(file)), `${file} must not read page React internals from an isolated content script`);
}

console.log("PASS: lead resolution uses only isolated-world-visible evidence and refuses ambiguity");
