import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Execute the production render helpers with a tiny DOM factory; the overlay's route/network lifecycle is
// covered separately. This catches wrong claims about the selected utility, disjoint bands and stop reachability.
const source = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
const begin = source.indexOf("  function stableBand(");
const end = source.indexOf("  function renderStopLossRadar(", begin);
assert.ok(begin > 0 && end > begin);
const context = vm.createContext({
  t: (key, args = []) => ({ key, args }),
  loadingBlock: (className, text) => ({ className, text }),
  h: (tag, props = {}, children = []) => ({ tag, props, children, replaceChildren(...next) { this.children = next; } })
});
vm.runInContext(`${source.slice(begin, end)}\nthis.ui = {stableBand,stopExplanation,stopPriceList,jointExitExplanation,jointProfileRows,jointExitProfiles,renderJointExits};`, context);
const radar = {
  recommendedRoe: 1, stopOptional: true, simulatedPositions: 10, positionCount: 20,
  tradeoff: { positions: 10, triggered: 0, triggeredAny: 1, pnlNone: -15, pnlStopWorse: -15, pnlStopBetter: -0.1,
    helped: 0, helpedUsdt: 0, hurt: 0, hurtUsdt: 0, worstLoss: null },
  stopSelection: { objective: "pnl", band: [1, 2, 4, 5], curve: Array.from({ length: 95 }, (_, i) => ({ stop: i + 1, triggered: 1, pnlMin: -15, pnlMax: -0.1 })) }
};
assert.equal(context.ui.stableBand(radar), "1–2%, 4–5%", "missing 3% must not be called part of a contiguous stable interval");
const explanation = context.ui.stopExplanation(radar);
assert.equal(explanation[0].key, "radarObjectivePnl", "fixed-capital price ROI must be distinguished from average trade ROE and net account return");
assert.ok(explanation.some((line) => line.key === "radarCoverage"));
assert.ok(explanation.some((line) => line.key === "radarWhyOptional"), "a no-trigger PnL witness cannot erase other trigger possibilities");
assert.ok(!explanation.some((line) => line.key === "radarWhyNoCost"));
radar.tradeoff.triggeredAny = 0;
assert.ok(context.ui.stopExplanation(radar).some((line) => line.key === "radarWhyNoCost"));
const list = context.ui.stopPriceList(radar);
assert.equal(list.tag, "details");
assert.equal(list.children[1].children.length, 95, "every integer stop outcome must be inspectable");
assert.equal(list.children[1].children[0].props.text.args[2], "-15～0", "render the conservative model range");

radar.stopSelection.neverTriggeredStop = null;
radar.stopSelection.neverTriggeredEquivalentToOptimal = false;
radar.tradeoff.triggeredAny = 13;
assert.ok(context.ui.stopExplanation(radar).some((line) => line.key === "radarNoFreeInsurance"), "no 1–95% never-triggered level must be stated, not replaced with a guessed free insurance stop");
radar.stopSelection.historicalNeverTriggerRoe = 264;
assert.deepEqual(Array.from(context.ui.stopExplanation(radar).find((line) => line.key === "radarOutsideInsurance").args), [264, 95], "a computed outside-range insurance threshold must disclose the Binance cap without becoming an input recommendation");
assert.equal(radar.recommendedRoe, 1, "outside-range diagnosis must not replace the enabled recommendation");
radar.stopSelection.historicalNeverTriggerRoe = 95;
assert.ok(!context.ui.stopExplanation(radar).some((line) => line.key === "radarOutsideInsurance"));
radar.stopSelection.historicalNeverTriggerRoe = NaN;
assert.ok(!context.ui.stopExplanation(radar).some((line) => line.key === "radarOutsideInsurance"), "missing diagnostic data cannot create a guessed threshold");
radar.stopSelection.neverTriggeredStop = 90;
radar.stopSelection.neverTriggeredEquivalentToOptimal = true;
let insuranceExplanation = context.ui.stopExplanation(radar);
assert.equal(insuranceExplanation.find((line) => line.key === "radarFreeInsurance").args[0], 90);
assert.ok(!insuranceExplanation.some((line) => line.key === "radarNoFreeInsurance"));
radar.stopOptional = false;
radar.stopSelection.neverTriggeredEquivalentToOptimal = false;
insuranceExplanation = context.ui.stopExplanation(radar);
assert.ok(insuranceExplanation.some((line) => line.key === "radarFreeBaselineOnly"), "a never-triggered level preserves the no-stop baseline, not a higher positive-stop optimum");
assert.ok(!insuranceExplanation.some((line) => line.key === "radarFreeInsurance"));
radar.stopOptional = true;

radar.exitSelection = {
  objective: "priceROI", optimal: { stop: null, takeProfit: 125 },
  simulatedPositions: 10, baselinePnl: 123, optimalPnlMin: 140, optimalPnlMax: 145,
  deltaMin: 17, deltaMax: 22, capital: null, roiMin: null, roiMax: null,
  optima: [{ stop: null, takeProfit: 125 }, { stop: 95, takeProfit: 125 }],
  tradeoff: { triggeredAny: 3, helped: 2, hurt: 1, helpedUsdt: 30, hurtUsdt: -13 },
  profileStop: Array.from({ length: 96 }, (_, i) => ({ stop: i ? i : null, takeProfit: 125, pnlMin: 140, pnlMax: 145, triggered: 3 })),
  profileTakeProfit: Array.from({ length: 2001 }, (_, i) => ({ stop: null, takeProfit: i ? i : null, pnlMin: 140, pnlMax: 145, triggered: 3 }))
};
const jointExplanation = context.ui.jointExitExplanation(radar);
assert.equal(jointExplanation[0].key, "exitObjectivePriceRoi");
assert.ok(jointExplanation.some((line) => line.key === "exitValidationNeeded"), "an in-sample historical optimum must not be promoted as an OOS/execution-validated setting");
assert.ok(jointExplanation.some((line) => line.key === "exitCapitalUnknown"), "unverified capital must not become an invented ROI denominator");
assert.ok(!jointExplanation.some((line) => line.key === "exitCapitalRoi"));
assert.equal(jointExplanation.find((line) => line.key === "exitTiedOptima").args[0], 2, "exact ties cannot be presented as a unique solution");
assert.equal(jointExplanation.find((line) => line.key === "exitHistoricalResult").args[0], "140～145");
assert.equal(context.ui.jointProfileRows(radar.exitSelection.profileTakeProfit).length, 2001, "every TP level and disabled control remains inspectable");
const profiles = context.ui.jointExitProfiles(radar.exitSelection);
assert.equal(profiles.length, 2);
assert.equal(profiles[1].children[1].children.length, 0, "large profiles must not create DOM rows until the user opens them");
profiles[1].props.ontoggle({ currentTarget: { open: true } });
assert.equal(profiles[1].children[1].children.length, 2001);
profiles[1].props.ontoggle({ currentTarget: { open: true } });
assert.equal(profiles[1].children[1].children.length, 2001, "reopening does not duplicate profile rows");
const rendered = context.ui.renderJointExits(radar);
assert.equal(rendered.children[1].props.text.args[0].key, "exitDisabled", "joint no-stop must not display the optional insurance stop");
assert.equal(rendered.children[1].props.text.args[1], "125%");
assert.equal(context.ui.renderJointExits({ ...radar, insufficientData: true }), null);
assert.equal(context.ui.renderJointExits({ ...radar, exitSelection: null }), null, "there must be no default TP while the selection is unavailable");
assert.equal(context.ui.renderJointExits({ ...radar, exitSelection: null }, true, true).text.key, "exitOptimizing");
assert.equal(context.ui.renderJointExits({ ...radar, exitSelection: null }, true, { done: 5, total: 100, percent: 5 }).text.key, "exitOptimizingProgress");
assert.equal(context.ui.renderJointExits({ ...radar, exitSelection: null }, true, { done: 5, total: 100, percent: 5, scope: "holdout" }).text.key, "exitValidatingProgress");
radar.exitSelection.capital = 100;
radar.exitSelection.roiMin = 140;
radar.exitSelection.roiMax = 145;
assert.ok(context.ui.jointExitExplanation(radar).some((line) => line.key === "exitCapitalRoi"));
radar.exitSelection.holdout = {
  insufficientData: false, cutoff: "2026-09-01T00:00:00.000Z", trainPositions: 5, testPositions: 4,
  excludedStraddling: 1, trainOptimal: { stop: 37, takeProfit: 125 }, heldoutUsedForSelection: false,
  fixed: { deltaMin: -4, deltaMax: 5 }
};
let holdoutExplanation = context.ui.jointExitExplanation(radar);
assert.ok(holdoutExplanation.some((line) => line.key === "exitHoldoutResult"));
assert.ok(holdoutExplanation.some((line) => line.key === "exitHoldoutNoBenefit"), "a negative lower holdout bound cannot be promoted by a positive optimistic outcome");
assert.ok(!holdoutExplanation.some((line) => line.key === "exitHoldoutPriceBenefit"));
assert.equal(holdoutExplanation.find((line) => line.key === "exitHoldoutResult").args[5], "-4～5");
radar.exitSelection.holdout.fixed = { deltaMin: 4, deltaMax: 5 };
assert.ok(context.ui.jointExitExplanation(radar).some((line) => line.key === "exitHoldoutPriceBenefit"));
radar.exitSelection.holdout.insufficientData = true;
holdoutExplanation = context.ui.jointExitExplanation(radar);
assert.ok(holdoutExplanation.some((line) => line.key === "exitHoldoutInsufficient"));
assert.ok(!holdoutExplanation.some((line) => line.key === "exitHoldoutResult"));
radar.exitSelection.holdout.insufficientData = false;
radar.exitSelection.holdout.heldoutUsedForSelection = true;
assert.ok(context.ui.jointExitExplanation(radar).some((line) => line.key === "exitHoldoutInsufficient"), "a leaked or unverified protocol must fail closed for OOS claims");
console.log("PASS: exit UI discloses objectives, coverage, bounds, ties and capital gaps; keeps every integer outcome and draws large profiles on demand");
