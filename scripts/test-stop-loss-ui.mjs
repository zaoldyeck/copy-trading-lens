import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Execute the production render helpers with a tiny DOM factory; the overlay's route/network lifecycle is
// covered separately. This catches wrong claims about the selected utility, disjoint bands and stop reachability.
const source = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
const begin = source.indexOf("  function stableBand(");
const end = source.indexOf("  function applyLabel(", begin);
assert.ok(begin > 0 && end > begin);
const context = vm.createContext({
  t: (key, args = []) => ({ key, args }),
  h: (tag, props, children) => ({ tag, props, children })
});
vm.runInContext(`${source.slice(begin, end)}\nthis.ui = {stableBand,stopExplanation,stopPriceList};`, context);
const radar = {
  recommendedRoe: 1, stopOptional: true, simulatedPositions: 10, positionCount: 20,
  tradeoff: { positions: 10, triggered: 0, triggeredAny: 1, pnlNone: -15, pnlStopWorse: -15, pnlStopBetter: -0.1,
    helped: 0, helpedUsdt: 0, hurt: 0, hurtUsdt: 0, worstLoss: null },
  stopSelection: { objective: "growth", band: [1, 2, 4, 5], curve: Array.from({ length: 95 }, (_, i) => ({ stop: i + 1, triggered: 1, pnlMin: -15, pnlMax: -0.1 })) }
};
assert.equal(context.ui.stableBand(radar), "1–2%, 4–5%", "missing 3% must not be called part of a contiguous stable interval");
const explanation = context.ui.stopExplanation(radar);
assert.equal(explanation[0].key, "radarObjectiveGrowth", "log utility must be disclosed even when USDT profit is lower");
assert.ok(explanation.some((line) => line.key === "radarCoverage"));
assert.ok(explanation.some((line) => line.key === "radarWhyOptional"), "a no-trigger PnL witness cannot erase other trigger possibilities");
assert.ok(!explanation.some((line) => line.key === "radarWhyNoCost"));
radar.tradeoff.triggeredAny = 0;
assert.ok(context.ui.stopExplanation(radar).some((line) => line.key === "radarWhyNoCost"));
radar.stopSelection.objective = "pnl";
assert.equal(context.ui.stopExplanation(radar)[0].key, "radarObjectivePnl");
const list = context.ui.stopPriceList(radar);
assert.equal(list.tag, "details");
assert.equal(list.children[1].children.length, 95, "every integer stop outcome must be inspectable");
assert.equal(list.children[1].children[0].props.text.args[2], "-15～0", "render the conservative model range");
console.log("PASS: stop UI discloses the objective/coverage, preserves band holes and trigger reachability, and renders all95 outcomes");
