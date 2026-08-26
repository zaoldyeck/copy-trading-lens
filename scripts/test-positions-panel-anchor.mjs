// Guard for the takeover anchor in src/positions-panel.js.
//
// The panel replaces Binance's "positions are private" notice by hiding the
// block that holds it. Picking that block wrongly is not a cosmetic error: on
// 2026-08-26 it resolved to the container of every tab pane — the inactive panes
// render empty, so they add no text and the "climb while the parent adds no
// text" rule walked straight past them — and hiding it blanked the Positions,
// Position History, Latest Records, Transfers and Copiers tabs at once.
//
// isSafeToHide is the mechanism that makes that unrepeatable, so it is tested
// against element stubs rather than left to a comment.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stubElement({ matches = {}, all = {} } = {}) {
  return {
    querySelector: (selector) => (matches[selector] ? {} : null),
    querySelectorAll: (selector) => new Array(all[selector] || 0).fill({})
  };
}

const sandbox = {
  console,
  document: { addEventListener() {}, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }) },
  setInterval: () => 0,
  clearInterval() {},
  clearTimeout() {},
  setTimeout: () => 0
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/positions-panel.js"), "utf8"), sandbox, { filename: "positions-panel.js" });
const Panel = sandbox.CopyTradingLensPositionsPanel;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("the empty-state block itself is safe to hide", () => {
  assert.equal(Panel.isSafeToHide(stubElement()), true);
});

test("a block carrying the tab strip is refused", () => {
  assert.equal(Panel.isSafeToHide(stubElement({ matches: { '[role="tab"], [role="tablist"]': true } })), false);
});

test("a block holding more than one tab panel is refused", () => {
  assert.equal(Panel.isSafeToHide(stubElement({ all: { '[role="tabpanel"]': 5 } })), false);
});

test("the class-based pane container Binance ships is refused", () => {
  // This is the exact node the anchor wrongly resolved to: five `bn-tab-pane`
  // children, no ARIA roles anywhere.
  assert.equal(Panel.isSafeToHide(stubElement({ all: { '[class*="tab-pane"], [class*="tab-panel"]': 5 } })), false);
});

test("a single nested pane is not treated as a pane container", () => {
  assert.equal(Panel.isSafeToHide(stubElement({ all: { '[class*="tab-pane"], [class*="tab-panel"]': 1 } })), true);
});

test("nothing to hide is not safe to hide", () => {
  assert.equal(Panel.isSafeToHide(null), false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
