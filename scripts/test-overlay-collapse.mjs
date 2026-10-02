// Guard for the overlay's collapse button in src/content.js.
//
// "−" hides the overlay. A loading run is paused at its next provider request
// boundary and resumes when the launcher is opened again; a finished run stays
// cached and is never read again. Before this guard the launcher re-ran the
// whole analysis on every reopen, and a run that finished while collapsed threw
// its result away.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");

function fakeElement(tag) {
  const el = {
    tag,
    className: "",
    textContent: "",
    attributes: {},
    listeners: {},
    children: [],
    parent: null,
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    appendChild(child) {
      if (typeof child === "object") child.parent = this;
      this.children.push(child);
      return child;
    },
    replaceChildren(...next) {
      this.children = [];
      next.forEach((child) => this.appendChild(child));
    },
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
  };
  return el;
}

function walk(el, visit) {
  if (!el || typeof el !== "object") return;
  visit(el);
  el.children.forEach((child) => walk(child, visit));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function analysisFor(name) {
  return {
    meta: { id: "p1", name, performanceWindows: {} },
    summary: { payoffRatio: null, closedTrades: 0, winRate: 0 },
    orders: { adverseAddRate: 0 },
    live: { openUnrealizedLoss: 0, openUnrealizedLossToMargin: 0 },
    verdict: { level: "watch", title: "verdict", alerts: [], cautions: [], positives: [] },
    strategy: { family: "family", labels: [] },
    transfers: { lossPeriodDepositCount: 0 },
    rawCounts: {}
  };
}

// Loads content.js into a fresh page. Every fetchLeadData call is recorded
// with a deferred the test settles by hand.
function loadPage(pathname = "/en/copy-trading/lead-details/p1") {
  const documentElement = fakeElement("html");
  const pressed = [];
  const documentListeners = {};
  const fetches = [];
  const fetchOptions = [];
  const panel = { mounts: [], fails: [], retry: null };
  const sandbox = {
    console,
    location: { href: `https://www.binance.com${pathname}`, pathname },
    document: {
      documentElement,
      addEventListener(type, fn, capture) { (documentListeners[type] ||= []).push({ fn, capture }); },
      createElement: fakeElement,
      createTextNode: (text) => text,
      getElementById(id) {
        let found = null;
        walk(documentElement, (el) => { if (!found && el.attributes.id === id) found = el; });
        return found;
      }
    },
    addEventListener() {},
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout() {},
    CopyTradingLensI18n: { t: (key) => key },
    CopyTradingLensProviders: {
      detectLeadPage: () => ({ platform: "Binance", id: "p1" }),
      rememberPressedCard: (target) => pressed.push(target),
      fetchLeadData(_context, options) {
        const call = deferred();
        fetches.push(call);
        fetchOptions.push(options || {});
        return call.promise;
      }
    },
    CopyTradingLensAnalysis: {
      analyzeBinance: (raw) => analysisFor(raw.name),
      formatPct: String,
      formatMoney: String,
      formatHours: String,
      formatDateTime: String
    },
    CopyTradingLensPositionsPanel: {
      beginLoading(_context, onRetry) { panel.retry = onRetry; },
      setProgress() {},
      mount(_context, raw) { panel.mounts.push(raw.name); },
      fail(error) { panel.fails.push(error.message); },
      unmount() {}
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "content.js" });

  const find = (className) => {
    let found = null;
    walk(documentElement, (el) => {
      if (!found && el.className.split(" ").includes(className)) found = el;
    });
    return found;
  };
  const click = (el) => {
    assert.ok(el, "element to click is on the page");
    el.listeners.click.forEach((fn) => fn());
  };
  const collapseButton = () => {
    let found = null;
    walk(documentElement, (el) => {
      if (!found && el.attributes.title === "collapseTitle") found = el;
    });
    return found;
  };
  const shownName = () => {
    let found = null;
    walk(documentElement, (el) => { if (found === null && el.tag === "h2") found = el.textContent; });
    return found;
  };
  return { fetches, fetchOptions, panel, find, click, collapseButton, shownName, pressed, documentListeners };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("collapsing mid-run pauses the read until reopening, then shows its result", async () => {
  const page = loadPage();
  assert.equal(page.fetches.length, 1);
  assert.ok(page.find("ctl-loading"), "the overlay opens on the loading view");

  page.click(page.collapseButton());
  assert.ok(page.find("ctl-launcher"));
  let resumed = false;
  const waitingForResume = page.fetchOptions[0].waitUntilResumed().then(() => { resumed = true; });
  await tick();
  assert.equal(resumed, false, "the provider must remain paused while the overlay is closed");

  page.click(page.find("ctl-launcher"));
  await waitingForResume;
  assert.equal(resumed, true, "reopening must resume the existing provider read");
  assert.ok(page.find("ctl-loading"), "reopening shows the resumed loading view");
  page.fetches[0].resolve({ name: "Trader" });
  await tick();
  assert.deepEqual(page.panel.mounts, ["Trader"], "the positions panel still gets the result");

  assert.equal(page.fetches.length, 1, "reopening does not read the trader again");
  assert.ok(page.find("ctl-verdict"), "reopening shows the finished analysis");
});

test("reopening a finished analysis does not read the trader again", async () => {
  const page = loadPage();
  page.fetches[0].resolve({ name: "Trader" });
  await tick();
  page.click(page.collapseButton());
  page.click(page.find("ctl-launcher"));
  assert.equal(page.fetches.length, 1);
  assert.ok(page.find("ctl-verdict"));
});

test("a run that finishes while collapsed stays cached", async () => {
  const page = loadPage();
  page.click(page.collapseButton());
  page.fetches[0].resolve({ name: "Trader" });
  await tick();
  assert.ok(page.find("ctl-launcher"), "a completed hidden run must stay hidden");

  page.click(page.find("ctl-launcher"));
  assert.equal(page.fetches.length, 1, "reopening a completed hidden run must not re-read");
  assert.ok(page.find("ctl-verdict"));
});

test("reopening while the run is still going shows it still loading", async () => {
  const page = loadPage();
  page.click(page.collapseButton());
  page.click(page.find("ctl-launcher"));
  assert.equal(page.fetches.length, 1, "no second read while the first is in flight");
  assert.ok(page.find("ctl-loading"));

  page.fetches[0].resolve({ name: "Trader" });
  await tick();
  assert.ok(page.find("ctl-verdict"), "the open overlay shows the result when the run ends");
});

test("a failure while collapsed is shown on reopen without retrying", async () => {
  const page = loadPage();
  page.click(page.collapseButton());
  page.fetches[0].reject(new Error("rate limited"));
  await tick();
  page.click(page.find("ctl-launcher"));
  assert.equal(page.fetches.length, 1);
  assert.ok(page.find("ctl-error"));
  assert.deepEqual(page.panel.fails, ["rate limited"]);
});

test("refresh is still an explicit re-read", async () => {
  const page = loadPage();
  page.fetches[0].resolve({ name: "Old" });
  await tick();
  page.click(page.find("ctl-actions").children[0]);
  assert.equal(page.fetches.length, 2);
  assert.ok(page.find("ctl-loading"));
  page.fetches[1].resolve({ name: "New" });
  await tick();
  assert.equal(page.shownName(), "New (badgePublic)");
});

test("a run superseded mid-flight never replaces the newer result", async () => {
  // Now that a finished run is kept, an older run answering last would keep
  // the wrong trader's payload for good instead of flickering.
  const page = loadPage();
  page.panel.retry();
  assert.equal(page.fetches.length, 2);
  page.fetches[1].resolve({ name: "New" });
  await tick();
  page.fetches[0].resolve({ name: "Old" });
  await tick();
  assert.equal(page.shownName(), "New (badgePublic)");
  assert.deepEqual(page.panel.mounts, ["New"], "the positions panel ignores the superseded run too");

  const failing = loadPage();
  failing.panel.retry();
  failing.fetches[1].resolve({ name: "New" });
  await tick();
  failing.fetches[0].reject(new Error("stale failure"));
  await tick();
  assert.equal(failing.shownName(), "New (badgePublic)");
  assert.deepEqual(failing.panel.fails, []);
});

// A press on a copy-management card is how a later copy-setting URL learns its
// trader (see providers.js rememberPressedCard); it has to be heard before the
// page's own handler navigates away, and nowhere else.
test("card presses are remembered on copy-management only, in the capture phase", async () => {
  const management = loadPage("/zh-TC/copy-trading/copy-management");
  const [listener] = management.documentListeners.click;
  assert.equal(listener.capture, true, "the press must be read before the page's own handler runs");
  const target = { innerText: "設定" };
  listener.fn({ target });
  assert.deepEqual(management.pressed, [target]);

  const lead = loadPage("/zh-TC/copy-trading/lead-details/p1");
  lead.documentListeners.click[0].fn({ target });
  assert.deepEqual(lead.pressed, [], "clicks elsewhere are never inspected");
});

// providers.js reads marks while the order histories are still paging, so the "marks" event can land after "orders":
// the banner shows the furthest stage reached, never goes back.
test("a late marks event does not move the streaming banner back", async () => {
  const page = loadPage();
  page.fetchOptions[0].onProgressive({ stage: "orders", raw: { name: "Trader" } });
  page.fetchOptions[0].onProgressive({ stage: "marks", raw: { name: "Trader" } });
  const banner = page.find("ctl-streaming-banner");
  assert.ok(banner, "the streaming banner is shown while the read is not finished");
  const text = banner.children.map((child) => (typeof child === "string" ? child : child.textContent)).join("");
  assert.ok(text.includes("stageLoadedOrders"), `banner after orders then marks: ${text}`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL: ${name}\n  ${error.message}`);
  }
}
if (failed) {
  console.log(`\n${failed} overlay collapse test(s) failed`);
  process.exit(1);
}
console.log("\nALL OVERLAY COLLAPSE TESTS PASSED");
