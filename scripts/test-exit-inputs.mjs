import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Only isolated-world-visible labels, ranges and section scopes are used. These DOM
// controls reproduce the official position-risk pair and competing portfolio stop.
const source = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
const begin = source.indexOf("  function exitInputRange(");
const end = source.indexOf("  // Which pieces of the read have landed", begin);
assert.ok(begin > 0 && end > begin);

class Element {
  constructor(text = "", children = [], className = "") {
    this.text = text;
    this.children = children;
    this.className = className;
    children.forEach((child) => { child.parentElement = this; });
  }
  get innerText() { return [this.text, ...this.children.map((child) => child.innerText || "")].join("\n"); }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  appendChild(child) { child.parentElement = this; this.children.push(child); }
  remove() { this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return selector === ".input" && this.className === "input" ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector === "input" && child instanceof Input || selector === ".ctl-inline-helper" && child.className === "ctl-inline-helper" ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }
}

class Input extends Element {
  constructor(placeholder, attributes = {}) {
    super();
    this.placeholder = placeholder;
    this.attributes = attributes;
    this.labels = [];
    this.events = [];
    this._value = "17";
    this.type = "text";
  }
  get value() { return this._value; }
  set value(value) {
    if (this.reject === value) throw new Error("controlled input rejected value");
    this._value = value;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  dispatchEvent(event) {
    if (this.rejectEvent === event.type) throw new Error("event dispatch failed");
    this.events.push(event.type);
  }
}

function load(sections, inputClass = Input) {
  const body = new Element("", sections);
  const context = vm.createContext({
    document: { body, querySelectorAll: (selector) => body.querySelectorAll(selector) },
    window: { HTMLInputElement: inputClass },
    t: (key) => key,
    applyLabel: () => "applyLabel",
    h: (_tag, props = {}, children = []) => {
      const node = new Element(props.text || "", children, props.class || "");
      node.onclick = props.onclick;
      node.classList = { toggle() {} };
      return node;
    },
    clearRoot() {}, renderLoading() {}, renderError() {}, renderLauncher() {}, renderAnalysis() {}, renderSettingAdvisor() {},
    Event: class { constructor(type, options) { this.type = type; this.bubbles = options.bubbles; } }
  });
  const paintBegin = source.indexOf("  function paint(");
  const paintEnd = source.indexOf("  function setCollapsed(", paintBegin);
  vm.runInContext(`let run = null, collapsed = false, settingModeView = "";\n${source.slice(begin, end)}\n${source.slice(paintBegin, paintEnd)}\nthis.inputs = {exitInputRange,positionExitInputs,fillExitInputs,applyStopLossToBinanceInputs,applyJointExitsToBinanceInputs,mountInlineSettingHelper,clearInlineSettingHelpers,paintRun(value) {run = value; paint();}};`, context);
  return context.inputs;
}

function positionSection({ scope = "Position Risk", stopLabel = "Stop Loss", takeProfitLabel = "Take Profit", stopRange = "0–95", takeProfitRange = "0–2,000" } = {}) {
  const stop = new Input(stopRange);
  const takeProfit = new Input(takeProfitRange);
  const section = new Element(scope, [new Element(takeProfitLabel, [takeProfit]), new Element(stopLabel, [stop])]);
  return { section, stop, takeProfit };
}

for (const labels of [
  {},
  { scope: "倉位風險", stopLabel: "止損", takeProfitLabel: "止盈" },
  { scope: "仓位风险", stopLabel: "止损", takeProfitLabel: "止盈" },
  { scope: "ポジションリスク", stopLabel: "損切り", takeProfitLabel: "利確" }
]) {
  const fixture = positionSection(labels);
  const portfolioStop = new Input("0-95");
  const helpers = load([new Element("Total Stop Loss", [portfolioStop]), fixture.section]);
  assert.equal(helpers.positionExitInputs().stop, fixture.stop);
  assert.equal(helpers.applyJointExitsToBinanceInputs({ optimal: { stop: 37, takeProfit: 125 } }), true);
  assert.equal(fixture.stop.value, "37");
  assert.equal(fixture.takeProfit.value, "125");
  assert.equal(portfolioStop.value, "17", "a portfolio-wide stop must never be changed");
  assert.deepEqual(fixture.stop.events, ["input", "change", "blur"]);
  assert.deepEqual(fixture.takeProfit.events, ["input", "change", "blur"]);
  assert.equal(helpers.applyJointExitsToBinanceInputs({ optimal: { stop: null, takeProfit: null } }), true);
  assert.equal(fixture.stop.value, "0", "a disabled optimum must not be replaced with an insurance stop");
  assert.equal(fixture.takeProfit.value, "0");
}

// Missing/ambiguous/mislabelled scopes and conflicting ranges fail before any write.
for (const setup of [
  () => [positionSection({ scope: "Portfolio Risk" })],
  () => [positionSection({ scope: "" })],
  () => [positionSection(), positionSection()],
  () => [positionSection({ takeProfitLabel: "Stop Loss" })],
  () => [positionSection({ stopRange: "0–100" })],
  () => [positionSection({ takeProfitRange: "0–500" })],
  () => { const fixture = positionSection(); fixture.stop.attributes = { min: "0", max: "94" }; return [fixture]; },
  () => { const fixture = positionSection(); fixture.takeProfit.disabled = true; return [fixture]; },
  () => { const fixture = positionSection(); fixture.stop.attributes["aria-label"] = "Take Profit"; return [fixture]; }
]) {
  const fixtures = setup();
  const helpers = load(fixtures.map((fixture) => fixture.section));
  assert.equal(helpers.positionExitInputs(), null);
  assert.equal(helpers.applyJointExitsToBinanceInputs({ optimal: { stop: 37, takeProfit: 125 } }), false);
  fixtures.forEach((fixture) => {
    assert.equal(fixture.stop.value, "17");
    assert.equal(fixture.takeProfit.value, "17");
  });
}

{
  const fixture = positionSection();
  const helpers = load([fixture.section]);
  assert.equal(helpers.applyJointExitsToBinanceInputs(null), false);
  for (const pair of [{ stop: 0.5, takeProfit: 5 }, { stop: 96, takeProfit: 5 }, { stop: -1, takeProfit: 5 }, { stop: 5, takeProfit: 2001 }, { stop: NaN, takeProfit: 5 }]) {
    assert.equal(helpers.applyJointExitsToBinanceInputs({ optimal: pair }), false);
    assert.equal(fixture.stop.value, "17");
    assert.equal(fixture.takeProfit.value, "17");
  }
  assert.equal(helpers.applyStopLossToBinanceInputs(95), true);
  assert.equal(fixture.takeProfit.value, "17", "the SL-only action must not alter TP");
  fixture.stop.parentElement.children.push(new Element("CopyLens Fill Stop Loss and Take Profit", [], "ctl-inline-helper"));
  assert.equal(helpers.positionExitInputs().stop, fixture.stop, "our own helper text is never classification evidence");
}

{
  const fixture = positionSection();
  fixture.takeProfit.reject = "125";
  const helpers = load([fixture.section]);
  assert.equal(helpers.applyJointExitsToBinanceInputs({ optimal: { stop: 37, takeProfit: 125 } }), false);
  assert.equal(fixture.stop.value, "17", "failure on TP must restore the already written SL");
  assert.equal(fixture.takeProfit.value, "17");
  delete fixture.takeProfit.reject;
  assert.equal(helpers.applyJointExitsToBinanceInputs({ optimal: { stop: 37, takeProfit: 125 } }), true, "the same controls recover without stale state");
}

{
  const fixture = positionSection();
  const helpers = load([fixture.section], class NoNativeSetter {});
  assert.equal(helpers.applyStopLossToBinanceInputs(37), false, "no direct .value fallback may bypass React's native setter");
  assert.equal(fixture.stop.value, "17");
}

{
  const fixture = positionSection();
  const helpers = load([fixture.section]);
  const radar = (stop, takeProfit) => ({ recommendedRoe: stop, exitSelection: { optimal: { stop, takeProfit } } });
  helpers.paintRun({ phase: "ready", analysis: { stopLossRadar: radar(37, 125) } });
  const first = fixture.section.querySelector(".ctl-inline-helper");
  assert.ok(first);
  helpers.paintRun({ phase: "loading", analysis: null });
  assert.equal(fixture.section.querySelector(".ctl-inline-helper"), null, "a refresh cannot leave the previous recommendation clickable");
  helpers.paintRun({ phase: "ready", analysis: { stopLossRadar: radar(85, 210) } });
  const next = fixture.section.querySelector(".ctl-inline-helper");
  assert.notEqual(next, first, "a reused SPA input must bind the current trader's values");
  next.onclick({ preventDefault() {} });
  assert.equal(fixture.stop.value, "85");
  assert.equal(fixture.takeProfit.value, "210");
  helpers.paintRun(null);
  assert.equal(fixture.section.querySelector(".ctl-inline-helper"), null, "leaving the recognized trader page clears the money-path helper");
  helpers.paintRun({ phase: "ready", analysis: { stopLossRadar: { insufficientData: true } } });
  assert.equal(fixture.section.querySelector(".ctl-inline-helper"), null);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Exercise the production final-read boundary: only this boundary launches the
// async joint search, which shares the same cancellation and pause controls.
function runPage() {
  const fetches = [];
  const searches = [];
  const draws = [];
  const mounts = [];
  const analyzeCalls = [];
  const sandbox = {
    location: { href: "https://www.binance.com/en/copy-trading/lead-details/123" },
    createFetchControl() {
      let paused = false;
      const waiters = [];
      return {
        pause() { paused = true; },
        resume() { paused = false; waiters.splice(0).forEach((resolve) => resolve()); },
        waitUntilResumed() { return paused ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(); }
      };
    },
    HISTORY_LABELS: new Set(), STAGE_ORDER: {},
    loadPercent: () => 0,
    CopyTradingLensProviders: {
      detectLeadPage: () => ({ platform: "Binance", id: "123" }),
      fetchLeadData(_context, options) { const call = deferred(); fetches.push({ ...call, options }); return call.promise; }
    },
    CopyTradingLensAnalysis: { analyzeBinance(raw) { analyzeCalls.push(raw); return { name: raw.name, selection: raw.exitSelection }; } },
    CopyTradingLensStopLoss: {
      positionExcursions: (positions, orders, marks) => ({ positions, orders, marks }),
      selectExitAsync(rows, equity, options) { const call = deferred(); searches.push({ ...call, rows, equity, options }); return call.promise; }
    },
    CopyTradingLensPositionsPanel: { beginLoading() {}, mount(_context, raw) { mounts.push(raw); }, fail() {}, unmount() {} }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const start = source.indexOf("  async function runAnalysis(");
  const finish = source.indexOf("  let lastKnownHref", start);
  vm.runInContext(`let run = null, runSeq = 0, collapsed = false, root = {}; function paint() { draws.push({phase:run?.phase,stage:run?.streamingStage,analysis:run?.analysis,exitProgress:run?.exitProgress}); }\n${source.slice(start, finish)}\nthis.task = runAnalysis();`, Object.assign(context, { draws }));
  return { context, fetches, searches, draws, mounts, analyzeCalls };
}

{
  const page = runPage();
  const raw = { name: "Current", positionHistory: ["position"], orderHistory: ["order"], positionMarks: { BTC: ["candle"] } };
  page.fetches[0].options.onProgressive({ stage: "orders", raw });
  assert.equal(page.searches.length, 0, "progressive data must never launch a second joint search");
  page.fetches[0].resolve(raw);
  await tick();
  assert.equal(page.searches.length, 1);
  assert.equal(page.searches[0].options.withHoldout, true, "the production entry point must request the chronological validation");
  assert.equal(page.draws.at(-1).phase, "loading");
  assert.equal(page.draws.at(-1).stage, "exits", "a complete cached payload still shows explicit joint optimization");
  assert.equal(page.draws.at(-1).analysis.selection, null, "pre-search analysis cannot leak an old joint recommendation");
  assert.equal(page.mounts.length, 0, "the completed panel publishes only after the joint search completes");
  page.searches[0].options.onProgress({ evaluations: 5, count: 100 });
  assert.equal(page.draws.at(-1).exitProgress.percent, 5);
  const drawsBefore = page.draws.length;
  page.searches[0].options.onProgress({ evaluations: 5, count: 100 });
  assert.equal(page.draws.length, drawsBefore, "unchanged percentages do not repeatedly rebuild the overlay");
  page.searches[0].options.onProgress({ evaluations: 5, count: 100, scope: "holdout" });
  assert.equal(page.draws.at(-1).exitProgress.scope, "holdout", "holdout progress is a separate stage even at the same percentage");
  assert.equal(page.draws.at(-1).phase, "loading");
  vm.runInContext("run.fetchControl.pause()", page.context);
  let resumed = false;
  const waiting = page.searches[0].options.waitUntilResumed().then(() => { resumed = true; });
  await tick();
  assert.equal(resumed, false, "joint search uses the current run's actual collapse pause control");
  vm.runInContext("run.fetchControl.resume()", page.context);
  await waiting;
  const selection = { optimal: { stop: 37, takeProfit: 125 } };
  page.searches[0].resolve(selection);
  await page.context.task;
  assert.equal(page.draws.at(-1).phase, "ready");
  assert.equal(page.draws.at(-1).analysis.selection, selection);
  assert.equal(page.mounts[0].exitSelection, selection);
}

{
  const page = runPage();
  page.fetches[0].resolve({ name: "Old" });
  await tick();
  vm.runInContext("this.newTask = runAnalysis(true)", page.context);
  assert.equal(page.searches[0].options.isCancelled(), true, "a newer route/refresh cancels the original selector");
  page.fetches[1].resolve({ name: "New" });
  await tick();
  page.searches[1].resolve({ optimal: { stop: 37, takeProfit: 125 } });
  await page.context.newTask;
  page.searches[0].resolve({ optimal: { stop: 1, takeProfit: 1 } });
  await page.context.task;
  assert.equal(page.draws.at(-1).analysis.name, "New", "an old optimization must never overwrite the new trader's result");
  assert.equal(page.mounts.length, 1);
  assert.equal(page.mounts[0].name, "New");
}

console.log("PASS: exit inputs map and restore safely; async final analysis preserves pause, cancellation, no partial defaults and latest-run publication");
