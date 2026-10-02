(function initCopyTradingLens() {
  "use strict";

  const ROOT_ID = "copy-trading-lens-root";
  // The analysis of the lead page in view: { key, context, phase: "loading" |
  // "ready" | "failed", raw, analysis, error }. Collapsing a loading run pauses
  // its provider at the next request boundary; reopening resumes that same run.
  // A finished run is kept in memory, so reopening never reads the trader again.
  let run = null;
  let runSeq = 0;
  let collapsed = false;
  let root = null;
  let routeTimer = null;

  function createFetchControl(initiallyPaused = false) {
    let paused = initiallyPaused;
    const waiters = new Set();
    return {
      pause() {
        paused = true;
      },
      resume() {
        if (!paused) return;
        paused = false;
        const pending = [...waiters];
        waiters.clear();
        pending.forEach((resolve) => resolve());
      },
      waitUntilResumed() {
        if (!paused) return Promise.resolve();
        return new Promise((resolve) => waiters.add(resolve));
      }
    };
  }

  function t(key, substitutions = []) {
    return window.CopyTradingLensI18n?.t(key, substitutions) || key;
  }

  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value);
      else if (value !== false && value !== null && value !== undefined) el.setAttribute(key, String(value));
    }
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child === null || child === undefined) continue;
      el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return el;
  }

  function ensureRoot() {
    let existing = document.getElementById(ROOT_ID);
    if (!existing) {
      existing = h("div", { id: ROOT_ID });
      document.documentElement.appendChild(existing);
    }
    root = existing;
    return root;
  }

  function clearRoot() {
    const existing = document.getElementById(ROOT_ID);
    if (existing) existing.remove();
    root = null;
  }

  let settingModeView = "advisor";

  function paint() {
    if (run?.phase !== "ready" || !run.analysis?.stopLossRadar || run.analysis.stopLossRadar.insufficientData) {
      clearInlineSettingHelpers();
    }
    if (!run) return clearRoot();
    if (run.phase === "ready" && run.analysis?.stopLossRadar) mountInlineSettingHelper(run.analysis.stopLossRadar);
    if (collapsed) return renderLauncher(run.context);
    if (run.phase === "failed") return renderError(run.error);

    const prevPanel = typeof root !== "undefined" && root && typeof root.querySelector === "function" ? root.querySelector(".ctl-panel") : null;
    const prevScrollTop = prevPanel ? prevPanel.scrollTop : 0;

    // Nothing has landed yet: only the loading view. Once something has, the card fills in piece by piece, and each
    // value waits for its own inputs (see landed()) instead of showing a default.
    if (!run.analysis) {
      renderLoading(run.context);
    } else if (run.context?.pageType === "copy-setting" && settingModeView === "advisor") {
      renderSettingAdvisor(run.context, run.raw, run.analysis);
    } else {
      renderAnalysis(run.context, run.raw, run.analysis);
    }

    if (prevScrollTop > 0 && typeof root !== "undefined" && root && typeof root.querySelector === "function") {
      const newPanel = root.querySelector(".ctl-panel");
      if (newPanel) newPanel.scrollTop = prevScrollTop;
    }
  }

  function setCollapsed(value) {
    collapsed = value;
    if (run?.phase === "loading") {
      if (collapsed) run.fetchControl.pause();
      else run.fetchControl.resume();
    }
    paint();
  }

  function collapseButton() {
    return h("button", { class: "ctl-icon-btn", title: t("collapseTitle"), onclick: () => setCollapsed(true) }, "−");
  }

  function renderLauncher(context) {
    ensureRoot().replaceChildren(
      h("button", {
        class: "ctl-launcher",
        title: t("launcherTitle"),
        onclick: () => setCollapsed(false)
      }, [
        h("span", { text: t("launcherLabel") }),
        h("strong", { text: context.platform })
      ])
    );
  }

  function statusText(endpointResults) {
    const entries = Object.values(endpointResults || {});
    const ok = entries.filter((item) => item?.ok).length;
    const total = entries.length;
    if (!total) return t("noDataYet");
    return t("endpointsAvailable", [ok, total]);
  }

  function endpointLabel(label) {
    const labels = {
      detail: t("endpointDetail"),
      livePositions: t("endpointLivePositions"),
      positionHistory: t("endpointPositionHistory"),
      orderHistory: t("endpointOrderHistory"),
      transferHistory: t("endpointTransferHistory"),
      candidate: t("endpointCandidate"),
      "performance:7D": t("endpointPerformance", ["7D"]),
      "performance:30D": t("endpointPerformance", ["30D"]),
      "performance:90D": t("endpointPerformance", ["90D"]),
      "performance:180D": t("endpointPerformance", ["180D"]),
      "performance:365D": t("endpointPerformance", ["365D"])
    };
    return labels[label] || label;
  }

  function endpointList(endpointResults) {
    return h("div", { class: "ctl-endpoints" }, Object.values(endpointResults || {}).map((item) =>
      h("div", { class: `ctl-endpoint ${item.ok ? "is-ok" : "is-fail"}` }, [
        h("span", { text: endpointLabel(item.label), title: item.error || "" }),
        h("strong", { text: item.ok ? "OK" : "FAIL" })
      ])
    ));
  }

  function metricCard(label, value, hint = "", accent = "") {
    return h("div", { class: accent ? `ctl-metric ${accent}` : "ctl-metric" }, [
      h("span", { text: label }),
      h("strong", { text: value }),
      hint ? h("small", { text: hint }) : null
    ]);
  }

  function bullets(items, emptyText) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list.length) return h("p", { class: "ctl-muted", text: emptyText });
    return h("ul", { class: "ctl-list" }, list.slice(0, 8).map((item) => h("li", { text: item })));
  }


  function performanceWindowTable(meta, fmt) {
    const windows = meta.performanceWindows || {};
    const ordered = ["7D", "30D", "90D", "180D", "365D"].filter((range) => windows[range]);
    if (!ordered.length) return h("p", { class: "ctl-muted", text: t("noWindowData") });
    return h("table", { class: "ctl-table" }, [
      h("thead", {}, h("tr", {}, [
        h("th", { text: t("colTimeRange") }),
        h("th", { text: t("colRoi") }),
        h("th", { text: t("colAnnualized") }),
        h("th", { text: t("colMdd") }),
        h("th", { text: t("colSource") })
      ])),
      h("tbody", {}, ordered.map((range) => {
        const metric = windows[range] || {};
        return h("tr", {}, [
          h("td", { text: range }),
          h("td", { text: fmt.formatPct(metric.roi) }),
          h("td", { text: fmt.formatPct(metric.annualizedReturn) }),
          h("td", { text: fmt.formatPct(metric.mdd) }),
          h("td", { text: metric.lookupSource || "API" })
        ]);
      }))
    ]);
  }

  function historyCompleteness(raw) {
    const status = raw.historyStatus || {};
    const items = [
      [t("histPosition"), status.positionHistory],
      [t("histOrder"), status.orderHistory],
      [t("histTransfer"), status.transferHistory]
    ];
    return items.map(([label, item]) => {
      if (!item) return `${label}: ${t("statusNA")}`;
      if (item.error) return `${label}: ${t("statusFail")}`;
      if (!item.total && !item.fetched) return `${label}: ${t("statusEmpty")}`;
      const retries = item.retryCount ? t("retrySuffix", [item.retryCount]) : "";
      const state = item.complete ? t("statusComplete") : t("statusIncomplete");
      return t("historyItem", [label, item.fetched || 0, item.total || 0, state, retries]);
    }).join("；");
  }

  function settingAdvice(analysis) {
    const cautions = [];
    if (analysis.live.openUnrealizedLoss > 0) {
      cautions.push(t("settingNoCopyExisting"));
    }
    if (analysis.orders.adverseAddRate >= 0.35 || analysis.summary.payoffRatio < 0.5) {
      cautions.push(t("settingSmallRatio"));
    }
    if (analysis.meta.mdd >= 30) {
      cautions.push(t("settingHighMdd"));
    }
    if (!cautions.length) {
      cautions.push(t("settingDefault"));
    }
    return cautions;
  }

  // Only the position-risk pair may be changed. Placeholder-only matching can confuse a
  // portfolio-wide stop with a position stop, so an ambiguous page is never filled.
  function exitInputRange(input) {
    const parse = (text) => {
      const match = String(text || "").replace(/[,，\s%]/g, "").match(/^(\d+)[–—−-](\d+)$/);
      return match ? [Number(match[1]), Number(match[2])] : null;
    };
    const placeholder = parse(input.placeholder);
    const rawMin = input.getAttribute?.("min");
    const rawMax = input.getAttribute?.("max");
    const attributes = rawMin !== null && rawMin !== "" && rawMax !== null && rawMax !== ""
      && Number.isFinite(Number(rawMin)) && Number.isFinite(Number(rawMax)) ? [Number(rawMin), Number(rawMax)] : null;
    if (placeholder && attributes && (placeholder[0] !== attributes[0] || placeholder[1] !== attributes[1])) return null;
    return attributes || placeholder;
  }

  function exitScopeText(node) {
    let text = node?.innerText || node?.textContent || "";
    for (const helper of node?.querySelectorAll?.(".ctl-inline-helper") || []) {
      text = text.replace(helper.innerText || helper.textContent || "", "");
    }
    return text;
  }

  function exitInputKind(input) {
    const stop = /止損|止损|Stop\s*Loss|損切り|ストップロス/i;
    const takeProfit = /止盈|Take\s*Profit|利確|利益確定|テイクプロフィット/i;
    const classify = (text) => stop.test(text) !== takeProfit.test(text) ? (stop.test(text) ? "stop" : "takeProfit") : null;
    const label = [input.getAttribute?.("aria-label"), ...(Array.from(input.labels || []).map(exitScopeText))].filter(Boolean).join(" ");
    if (label) return classify(label);
    for (let node = input.parentElement; node && node !== document.body; node = node.parentElement) {
      if (Array.from(node.querySelectorAll?.("input") || []).filter((item) => exitInputRange(item)).length !== 1) break;
      const kind = classify(exitScopeText(node));
      if (kind) return kind;
    }
    return null;
  }

  function positionExitInputs() {
    const positionRisk = /倉位風險|仓位风险|Position\s*Risk|ポジションリスク|ポジションのリスク/i;
    const portfolioRisk = /投資組合風險|投资组合风险|Portfolio\s*Risk|Total\s*Stop\s*Loss|總止損|总止损|ポートフォリオリスク/i;
    const candidates = Array.from(document.querySelectorAll("input")).filter((input) =>
      !input.disabled && !input.readOnly && input.type !== "hidden" && exitInputRange(input));
    const pairs = [];
    for (const input of candidates) {
      for (let node = input.parentElement; node && node !== document.body; node = node.parentElement) {
        const text = exitScopeText(node);
        if (!positionRisk.test(text)) continue;
        if (portfolioRisk.test(text)) break;
        const members = candidates.filter((item) => node.contains(item));
        if (members.length !== 2) break;
        const stop = members.filter((item) => exitInputKind(item) === "stop" && exitInputRange(item)?.[0] === 0 && exitInputRange(item)?.[1] === 95);
        const takeProfit = members.filter((item) => exitInputKind(item) === "takeProfit" && exitInputRange(item)?.[0] === 0 && exitInputRange(item)?.[1] === 2000);
        if (stop.length === 1 && takeProfit.length === 1 && !pairs.some((pair) => pair.stop === stop[0] && pair.takeProfit === takeProfit[0])) {
          pairs.push({ stop: stop[0], takeProfit: takeProfit[0] });
        }
        break;
      }
    }
    return pairs.length === 1 ? pairs[0] : null;
  }

  function fillExitInputs(values) {
    const pair = positionExitInputs();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (!pair || !setter) return false;
    const entries = Object.entries(values);
    if (!entries.length || entries.some(([kind, value]) => !pair[kind] || !Number.isInteger(value)
      || value < 0 || value > (kind === "stop" ? 95 : 2000))) return false;
    const before = entries.map(([kind]) => [pair[kind], pair[kind].value]);
    const notify = (input) => {
      for (const event of ["input", "change", "blur"]) input.dispatchEvent(new Event(event, { bubbles: true }));
    };
    try {
      for (const [kind, value] of entries) setter.call(pair[kind], String(value));
      if (entries.some(([kind, value]) => pair[kind].value !== String(value))) throw new Error("Input value was rejected");
      for (const [kind] of entries) notify(pair[kind]);
      return true;
    } catch (_error) {
      // Restore the values if a setter or event handler rejects either side of the pair.
      for (const [input, value] of before) {
        try { setter.call(input, value); notify(input); } catch (_restoreError) { /* The result stays failed. */ }
      }
      return false;
    }
  }

  function applyStopLossToBinanceInputs(value) {
    return fillExitInputs({ stop: value });
  }

  function applyJointExitsToBinanceInputs(selection) {
    if (!selection?.optimal) return false;
    return fillExitInputs({ stop: selection.optimal.stop ?? 0, takeProfit: selection.optimal.takeProfit ?? 0 });
  }

  function clearInlineSettingHelpers() {
    for (const helper of document.querySelectorAll?.(".ctl-inline-helper") || []) helper.remove();
  }

  function mountInlineSettingHelper(radar) {
    // A reused SPA input or refresh must never retain an older trader's recommendation.
    clearInlineSettingHelpers();
    if (!radar || radar.insufficientData) return;
    const pair = positionExitInputs();
    const target = pair?.stop;
    if (!target) return;
    const container = target.closest(".input") || target.parentElement;
    if (!container) return;
    const selection = radar.exitSelection;
    const chip = h("button", {
      class: "ctl-inline-helper",
      type: "button",
      title: selection ? t("exitApplyPair") : applyLabel(radar),
      onclick: (e) => {
        e.preventDefault();
        const filled = selection ? applyJointExitsToBinanceInputs(selection) : applyStopLossToBinanceInputs(radar.recommendedRoe);
        chip.textContent = filled ? `✓ ${t("exitApplied")}` : t("exitInputUnavailable");
        chip.classList.toggle("is-applied", filled);
      }
    }, [h("span", { text: "⚡ CopyLens" })]);
    container.appendChild(chip);
  }

  // Which pieces of the read have landed (providers.js `loaded`); a finished read has all of them. A value is drawn
  // only when the pieces it is computed from are loaded; until then its own placeholder spins, so the card fills in
  // as data arrives and never shows a default or half-computed number as if it were real.
  function landed(...pieces) {
    return run.phase === "ready" || (run.streamingStage === "exits" && run.raw && !run.raw.loaded)
      || pieces.every((piece) => run.raw?.loaded?.[piece]);
  }

  function loadingBlock(className, text) {
    return h("div", { class: `${className} ctl-block-loading` }, [
      h("span", { class: "ctl-mini-spinner" }),
      h("span", { text })
    ]);
  }

  function metricOrLoading(pieces, label, hintKey, build) {
    return landed(...pieces) ? build() : metricLoadingCard(label, t(hintKey));
  }

  function metricLoadingCard(label, hint = "") {
    return h("div", { class: "ctl-metric is-streaming-metric" }, [
      h("span", { text: label }),
      h("strong", { class: "ctl-loading-text" }, [
        h("span", { class: "ctl-mini-spinner" }),
        h("span", { text: t("metricLoadingText") })
      ]),
      hint ? h("small", { text: hint }) : null
    ]);
  }

  // Preserve holes: bootstrap alternatives can be disjoint, so never fill the interval between min and max.
  function stableBand(radar) {
    const band = radar?.stopSelection?.band || [];
    const ranges = [];
    for (const value of [...band].sort((a, b) => a - b)) {
      const last = ranges.at(-1);
      if (last && value === last[1] + 1) last[1] = value;
      else ranges.push([value, value]);
    }
    return ranges.map(([lo, hi]) => lo === hi ? `${lo}%` : `${lo}–${hi}%`).join(", ");
  }

  function noStopOptimal(radar) {
    // The historical selector is authoritative; bootstrap alternatives cannot turn a positive-stop optimum off.
    return Object.prototype.hasOwnProperty.call(radar.stopSelection || {}, "optimal")
      ? radar.stopSelection.optimal === null : radar.stopOptional;
  }

  function stopDecision(radar) {
    return noStopOptimal(radar) ? t("radarDecisionOptional") : t("radarDecisionStop", [radar.recommendedRoe]);
  }

  // Compare total PnL with the same no-stop history. A lower positive profit is not an actual money loss, and
  // a range crossing the baseline must retain both its downside and upside rather than being called a cost.
  function relativePnl(low, high, baseline) {
    const deltaLow = low - baseline;
    const deltaHigh = high - baseline;
    if (deltaLow === 0 && deltaHigh === 0) return t("radarRelativeEqual");
    if (deltaHigh <= 0) return t(low >= 0 && baseline >= 0 ? "radarRelativeLessProfit" : "radarRelativeLowerPnl", [exitMoneyRange(-deltaHigh, -deltaLow)]);
    if (deltaLow >= 0) return t(baseline >= 0 ? "radarRelativeMoreProfit" : "radarRelativeHigherPnl", [exitMoneyRange(deltaLow, deltaHigh)]);
    return t(low >= 0 && baseline >= 0 ? "radarRelativeMixedProfit" : "radarRelativeMixedPnl", [exitMoneyRange(-deltaLow, -deltaLow), exitMoneyRange(deltaHigh, deltaHigh)]);
  }

  function historicalPnl(low, high) {
    if (low >= 0) return t("radarTotalProfit", [exitMoneyRange(low, high)]);
    if (high <= 0) return t("radarTotalLoss", [exitMoneyRange(-high, -low)]);
    return t("radarTotalMixed", [exitMoneyRange(-low, -low), exitMoneyRange(high, high)]);
  }

  function stopSummaryLines(radar) {
    const tradeoff = radar.tradeoff;
    const low = Math.min(tradeoff.pnlStopWorse, tradeoff.pnlStopBetter);
    const high = Math.max(tradeoff.pnlStopWorse, tradeoff.pnlStopBetter);
    const lines = [
      t("radarBaselineSummary", [historicalPnl(tradeoff.pnlNone, tradeoff.pnlNone)]),
      t("radarCandidateSummary", [radar.recommendedRoe, historicalPnl(low, high), relativePnl(low, high, tradeoff.pnlNone)]),
      t(tradeoff.triggeredAny > 0 ? "radarTriggerSummary" : "radarNoTriggerSummary", [tradeoff.triggeredAny]),
      t("radarTotalsMeaning", [tradeoff.positions])
    ];
    if (noStopOptimal(radar) && low < tradeoff.pnlNone) lines.push(t("radarInsuranceCostMeaning"));
    if (low !== high) lines.push(t("radarModelRangeMeaning"));
    return lines;
  }

  function stopModelDetails(radar) {
    return h("details", { class: "ctl-radar-pricelist" }, [
      h("summary", { text: t("radarModelDetailsTitle") }),
      h("div", { class: "ctl-radar-why" }, stopExplanation(radar).map((text) => h("p", { text })))
    ]);
  }

  // Why this answer, in the trader's own numbers: what the stop would have done to a copier on this trader's own
  // history (total money, how many positions it triggers on, how many it helps and how many it hurts), and, when a
  // stop is not shown to help, that a stop is insurance and which one is suggested.
  function stopExplanation(radar) {
    const tradeoff = radar.tradeoff;
    const stop = radar.recommendedRoe;
    const usdt = (value) => (Math.round(value) || 0).toLocaleString("en-US");
    // under the reading that is worse for the stop, and the other: show the range when they differ
    const low = Math.min(tradeoff.pnlStopWorse, tradeoff.pnlStopBetter);
    const high = Math.max(tradeoff.pnlStopWorse, tradeoff.pnlStopBetter);
    const stopTotal = Math.round(low) === Math.round(high) ? usdt(low) : `${usdt(low)}～${usdt(high)}`;
    const effects = [tradeoff.positions, stop, usdt(tradeoff.pnlNone), stopTotal, tradeoff.triggered, tradeoff.helped, usdt(tradeoff.helpedUsdt), tradeoff.hurt, usdt(Math.abs(tradeoff.hurtUsdt))];
    const paragraphs = [];
    paragraphs.push(t("radarObjectivePnl"));
    paragraphs.push(t("radarCoverage", [radar.simulatedPositions, radar.positionCount]));
    if (noStopOptimal(radar)) {
      paragraphs.push(tradeoff.triggeredAny > 0 ? t("radarWhyOptional", effects) : t("radarWhyNoCost", [tradeoff.positions, stop, usdt(tradeoff.pnlNone)]));
      const worst = tradeoff.worstLoss;
      paragraphs.push(worst && worst.returnPct < -stop
        ? t("radarInsurance", [worst.symbol, worst.leverage, Math.abs(Math.round(worst.returnPct)), stop])
        : t("radarInsuranceNone", [stop]));
    } else {
      paragraphs.push(t("radarWhyStop", effects));
    }
    const neverTriggered = radar.stopSelection.neverTriggeredStop;
    if (Number.isInteger(neverTriggered)) {
      paragraphs.push(t(radar.stopSelection.neverTriggeredEquivalentToOptimal
        ? "radarFreeInsurance" : "radarFreeBaselineOnly", [neverTriggered]));
    } else if (neverTriggered === null) {
      if (noStopOptimal(radar)) paragraphs.push(t("radarNoFreeInsurance", [stop]));
      const historicalNeverTrigger = radar.stopSelection.historicalNeverTriggerRoe;
      if (Number.isFinite(historicalNeverTrigger) && historicalNeverTrigger > 95) {
        paragraphs.push(t("radarOutsideInsurance", [historicalNeverTrigger, 95]));
      }
    }
    const band = stableBand(radar);
    if (band) paragraphs.push(t("radarBandSentence", [band]));
    paragraphs.push(t("radarBacktestFootnote"));
    return paragraphs;
  }

  // The price of insurance, level by level: what each stop would have cost on this history.
  function stopPriceList(radar) {
    const usdt = (value) => (Math.round(value) || 0).toLocaleString("en-US");
    const rows = radar.stopSelection.curve.filter((point) => point.stop !== null);
    return h("details", { class: "ctl-radar-pricelist" }, [
      h("summary", { text: t("radarPriceListTitle", [usdt(radar.tradeoff.pnlNone)]) }),
      h("ul", {}, rows.map((point) => {
        const low = point.pnlMin;
        const high = point.pnlMax;
        return h("li", { text: t("radarPriceListRow", [point.stop, point.triggered, Math.round(low) === Math.round(high) ? usdt(low) : `${usdt(low)}～${usdt(high)}`, relativePnl(low, high, radar.tradeoff.pnlNone)]) });
      })),
      h("p", { text: t("radarPriceListMeaning") })
    ]);
  }

  function applyLabel(radar) {
    return noStopOptimal(radar) ? t("radarApplyOptional", [radar.recommendedRoe]) : t("btnApplyToBinanceForm", [radar.recommendedRoe]);
  }

  function exitOptionLabel(value) {
    return value === null ? t("exitDisabled") : `${value}%`;
  }

  function exitMoneyRange(low, high) {
    const money = (value) => (Math.round(value) || 0).toLocaleString("en-US");
    return Math.round(low) === Math.round(high) ? money(low) : `${money(low)}～${money(high)}`;
  }

  function exitPairText(pair) {
    return t("exitPairSummary", [exitOptionLabel(pair.stop), exitOptionLabel(pair.takeProfit)]);
  }

  function jointExitExplanation(radar) {
    const selection = radar.exitSelection;
    if (!selection?.optimal) return [];
    const paragraphs = [
      t("exitObjectivePriceRoi"),
      t("radarCoverage", [selection.simulatedPositions ?? radar.simulatedPositions, radar.positionCount]),
      t("exitHistoricalResult", [exitMoneyRange(selection.optimalPnlMin, selection.optimalPnlMax), exitMoneyRange(selection.baselinePnl, selection.baselinePnl), exitMoneyRange(selection.deltaMin, selection.deltaMax)])
    ];
    if (Number.isFinite(selection.roiMin) && Number.isFinite(selection.roiMax) && Number.isFinite(selection.capital) && selection.capital > 0) {
      paragraphs.push(t("exitCapitalRoi", [exitMoneyRange(selection.capital, selection.capital), selection.roiMin.toFixed(2), selection.roiMax.toFixed(2)]));
    } else paragraphs.push(t("exitCapitalUnknown"));
    const effects = selection.tradeoff;
    if (effects) paragraphs.push(t("exitTradeoff", [effects.triggeredAny, effects.helped, exitMoneyRange(effects.helpedUsdt, effects.helpedUsdt), effects.hurt, exitMoneyRange(Math.abs(effects.hurtUsdt), Math.abs(effects.hurtUsdt))]));
    if ((selection.optima?.length || 0) > 1) paragraphs.push(t("exitTiedOptima", [selection.optima.length]));
    const holdout = selection.holdout;
    if (holdout) {
      if (holdout.insufficientData || holdout.heldoutUsedForSelection !== false || !holdout.trainOptimal
        || !Number.isFinite(holdout.fixed?.deltaMin) || !Number.isFinite(holdout.fixed?.deltaMax)) {
        paragraphs.push(t("exitHoldoutInsufficient"));
      } else {
        paragraphs.push(t("exitHoldoutResult", [holdout.trainPositions, holdout.testPositions, holdout.cutoff,
          exitOptionLabel(holdout.trainOptimal.stop), exitOptionLabel(holdout.trainOptimal.takeProfit),
          exitMoneyRange(holdout.fixed.deltaMin, holdout.fixed.deltaMax), holdout.excludedStraddling]));
        paragraphs.push(t(holdout.fixed.deltaMin > 0 ? "exitHoldoutPriceBenefit" : "exitHoldoutNoBenefit"));
      }
    }
    paragraphs.push(t("exitValidationNeeded"));
    paragraphs.push(t("exitBacktestFootnote"));
    return paragraphs;
  }

  function jointProfileRows(points) {
    return (points || []).map((point) => h("li", { text: t("exitProfileRow", [exitOptionLabel(point.stop), exitOptionLabel(point.takeProfit), exitMoneyRange(point.pnlMin, point.pnlMax), point.triggered]) }));
  }

  function jointExitProfiles(selection) {
    const profiles = [
      ["exitStopProfile", selection.profileStop],
      ["exitTakeProfitProfile", selection.profileTakeProfit]
    ];
    return profiles.filter(([, points]) => points?.length).map(([title, points]) => {
      const list = h("ul");
      let drawn = false;
      return h("details", {
        class: "ctl-radar-pricelist",
        ontoggle: (event) => {
          if (event.currentTarget.open && !drawn) {
            list.replaceChildren(...jointProfileRows(points));
            drawn = true;
          }
        }
      }, [h("summary", { text: t(title) }), list]);
    });
  }

  function renderJointExits(radar, compact = false, pending = false) {
    const selection = radar?.exitSelection;
    if (pending) return loadingBlock(compact ? "ctl-advisor-hero" : "ctl-radar-box", typeof pending === "object"
      ? t(pending.scope === "holdout" ? "exitValidatingProgress" : "exitOptimizingProgress", [pending.done.toLocaleString("en-US"), pending.total.toLocaleString("en-US"), pending.percent])
      : t("exitOptimizing"));
    if (!selection?.optimal || radar.insufficientData) return null;
    const optimal = selection.optimal;
    return h("section", { class: compact ? "ctl-advisor-hero" : "ctl-section ctl-radar-section" }, [
      h("h3", { text: t("sectionJointExits") }),
      h("div", { class: "ctl-radar-decision", text: exitPairText(optimal) }),
      h("div", { class: "ctl-radar-label", text: t("exitHistoricalLabel") }),
      h("div", { class: "ctl-radar-grid" }, [
        h("div", { class: "ctl-radar-stat" }, [h("span", { text: t("exitStopLabel") }), h("strong", { text: exitOptionLabel(optimal.stop) })]),
        h("div", { class: "ctl-radar-stat" }, [h("span", { text: t("exitTakeProfitLabel") }), h("strong", { text: exitOptionLabel(optimal.takeProfit) })])
      ]),
      h("p", { class: "ctl-radar-sub", text: t("exitEquivalentPrice", [radar.dominantLeverage, optimal.stop === null ? t("exitDisabled") : `${Number((optimal.stop / radar.dominantLeverage).toPrecision(4))}%`, optimal.takeProfit === null ? t("exitDisabled") : `${Number((optimal.takeProfit / radar.dominantLeverage).toPrecision(4))}%`]) }),
      h("div", { class: "ctl-radar-why" }, jointExitExplanation(radar).map((text) => h("p", { text }))),
      ...jointExitProfiles(selection),
      h("button", {
        class: compact ? "ctl-primary ctl-advisor-apply-btn" : "ctl-radar-fill-btn",
        type: "button",
        onclick: (event) => {
          const button = event.currentTarget;
          const filled = applyJointExitsToBinanceInputs(selection);
          button.textContent = filled ? `✓ ${t("exitApplied")}` : t("exitInputUnavailable");
          button.classList.toggle("is-applied", filled);
        }
      }, [h("span", { text: `⚡ ${t("exitApplyPair")}` })])
    ]);
  }

  function renderStopLossRadar(radar) {
    if (!radar || radar.insufficientData) return null;
    const hasBag = radar.hasSevereBagHolding;
    return h("section", { class: "ctl-section ctl-radar-section" }, [
      renderJointExits(radar, false, run.phase !== "ready" && run.streamingStage === "exits" && (run.exitProgress || true)),
      h("div", { class: "ctl-radar-header" }, [
        h("h3", { text: t(radar.exitSelection ? "exitStopOnlyTitle" : "sectionStopLossRadar") }),
        hasBag
          ? h("span", { class: "ctl-radar-badge is-danger", text: t("badgeBagHoldingAlert") })
          : null
      ]),
      h("div", { class: "ctl-radar-box" }, [
        h("div", { class: "ctl-radar-primary" }, [
          h("div", { class: "ctl-radar-decision", text: stopDecision(radar) }),
          h("div", { class: "ctl-radar-label", text: t(noStopOptimal(radar) ? "radarInsuranceLabel" : "radarRecommendedLabel") }),
          h("div", { class: "ctl-radar-value" }, [
            h("span", { class: "ctl-radar-number", text: `${radar.recommendedRoe}%` }),
            h("span", { class: "ctl-radar-unit", text: t("radarRoeUnit") })
          ]),
          h("div", { class: "ctl-radar-sub", text: t("radarEquivalentPrice", [radar.dominantLeverage, radar.recommendedPriceDrop]) }),
          h("div", { class: "ctl-radar-direct-hint", text: t(noStopOptimal(radar) ? "radarOptionalInputHint" : "radarDirectInputHint", [radar.recommendedRoe]) }),
          h("button", {
            class: "ctl-radar-fill-btn",
            type: "button",
            onclick: (e) => {
              const btn = e.currentTarget;
              const filled = applyStopLossToBinanceInputs(radar.recommendedRoe);
              if (filled) {
                btn.textContent = `✓ ${t("inlineChipApplied", [radar.recommendedRoe])}`;
                btn.classList.add("is-applied");
                setTimeout(() => {
                  btn.textContent = `⚡ ${applyLabel(radar)}`;
                  btn.classList.remove("is-applied");
                }, 2500);
              } else {
                navigator.clipboard?.writeText?.(String(radar.recommendedRoe));
                btn.textContent = `✓ ${t("btnCopiedToClipboard", [radar.recommendedRoe])}`;
                btn.classList.add("is-applied");
                setTimeout(() => {
                  btn.textContent = `📋 ${t("btnCopyToClipboard", [radar.recommendedRoe])}`;
                  btn.classList.remove("is-applied");
                }, 2500);
              }
            }
          }, [
            h("span", { text: location.href.includes("copy-setting")
              ? `⚡ ${applyLabel(radar)}`
              : `📋 ${t("btnCopyToClipboard", [radar.recommendedRoe])}`
            })
          ])
        ]),
        h("div", { class: "ctl-radar-why" }, stopSummaryLines(radar).map((text) => h("p", { text }))),
        stopModelDetails(radar),
        stopPriceList(radar),
        h("div", { class: "ctl-radar-grid" }, [
          h("div", { class: "ctl-radar-stat" }, [
            h("span", { text: t("radarWinRetention") }),
            h("strong", { text: `${radar.winRetentionRate}%` })
          ]),
          h("div", { class: "ctl-radar-stat" }, [
            h("span", { text: t("radarDominantLev") }),
            h("strong", { text: `${radar.dominantLeverage}x` })
          ]),
          h("div", { class: "ctl-radar-stat" }, [
            h("span", { text: t("radarWorstDrawdown") }),
            h("strong", { class: hasBag ? "is-danger" : "", text: `-${radar.worstHistoricalRoeMae}%` })
          ]),
          radar.mfeStats ? h("div", { class: "ctl-radar-stat" }, [
            h("span", { text: t("radarMfe") }),
            h("strong", { text: `+${radar.mfeStats.max}%` })
          ]) : null
        ])
      ]),
      hasBag
        ? h("div", { class: "ctl-radar-alert", text: t("radarSevereBagWarning", [radar.worstHistoricalRoeMae]) })
        : null,
      h("div", { class: "ctl-radar-notice", text: t("radarBinanceRoeNotice") })
    ]);
  }

  function renderRadarLoading() {
    return h("section", { class: "ctl-section ctl-radar-section" }, [
      h("div", { class: "ctl-radar-header" }, [h("h3", { text: t("sectionStopLossRadar") })]),
      loadingBlock("ctl-radar-loading", t("streamingRadarLoading"))
    ]);
  }

  function renderLoading(context) {
    ensureRoot().replaceChildren(
      h("section", { class: context.pageType === "copy-setting" ? "ctl-panel ctl-setting-card" : "ctl-panel" }, [
        h("header", { class: "ctl-header" }, [
          h("div", {}, [
            h("span", { class: "ctl-eyebrow", text: "Copy Trading Lens" }),
            h("h2", { text: t("analysisInProgress", [context.platform]) })
          ]),
          collapseButton()
        ]),
        h("div", { class: "ctl-loading" }, [
          h("div", { class: "ctl-spinner" }),
          h("p", { text: t("loadingText") })
        ]),
        renderStreamingBanner(run?.streamingStage)
      ])
    );
  }

  function renderError(error) {
    ensureRoot().replaceChildren(
      h("section", { class: "ctl-panel" }, [
        h("header", { class: "ctl-header" }, [
          h("div", {}, [
            h("span", { class: "ctl-eyebrow", text: "Copy Trading Lens" }),
            h("h2", { text: t("analysisFailed") })
          ]),
          collapseButton()
        ]),
        h("p", { class: "ctl-error", text: error instanceof Error ? error.message : String(error) }),
        h("button", { class: "ctl-primary", onclick: () => runAnalysis(true) }, t("retry"))
      ])
    );
  }

  function verdictClass(level) {
    if (level === "incomplete") return "is-incomplete";
    if (level === "avoid") return "is-avoid";
    if (level === "risky") return "is-risky";
    if (level === "preferred") return "is-preferred";
    if (level === "followable") return "is-followable";
    return "is-watch";
  }

  // Payoff divides the average win by the average loss, so it has no value
  // until at least one closed trade lost. Say which of the two gaps it is.
  function payoffUnavailableReason(summary) {
    if (summary.payoffRatio !== null) return "";
    if (summary.closedTrades === 0) return t("payoffNoClosedTrades");
    return t("payoffNoLosses", [summary.closedTrades]);
  }

  // How much of the read has landed, for the progress bar. Each piece of the read has a share; inside a piece the
  // share fills by what has been fetched (pages of a history, windows of candles, symbols of market data), 0 until
  // its total is known and at most 99% of it until the piece has landed, so the bar only ever rises and reaches 100
  // with the finished read. The shares are display weights, not measured durations: on 2026-10-02 a full read of
  // 玄冥二老 landed detail at 0.4 s, positions 0.9 s, marks 3.2 s, orders 72.5 s (Binance's busy-retry backoff on
  // order-history), market history 74.6 s, so the long middle is shown as steady progress inside the orders share.
  const PROGRESS_PIECES = [
    { share: 5, landed: "detail" },
    { share: 15, landed: "positions", counter: "positionHistory" },
    { share: 25, landed: "orders", counter: "orderHistory" },
    { share: 5, landed: "orders", counter: "transferHistory" },
    { share: 5, landed: "orders" },
    { share: 25, landed: "marks", counter: "marks" },
    { share: 20, landed: "market", counter: "market" }
  ];

  function loadPercent(state) {
    if (state.phase === "ready") return 100;
    let sum = 0;
    for (const piece of PROGRESS_PIECES) {
      if (state.raw?.loaded?.[piece.landed]) {
        sum += piece.share;
        continue;
      }
      const counter = state.progress?.[piece.counter];
      if (counter && counter.total > 0) sum += piece.share * Math.min(0.99, counter.done / counter.total);
    }
    return Math.min(99, Math.round(sum));
  }

  function updateProgressBannerOnly() {
    if (typeof root?.querySelector !== "function") return false;
    const banner = root.querySelector(".ctl-streaming-banner");
    if (!banner || typeof banner.querySelector !== "function") return false;
    const fill = banner.querySelector(".ctl-progress-fill");
    const percent = loadPercent(run);
    if (fill) {
      fill.style.width = `${percent}%`;
      const bar = banner.querySelector(".ctl-progress");
      if (bar) bar.setAttribute("aria-valuenow", String(percent));
    }
    return true;
  }

  function renderStreamingBanner(stage) {
    let loaded = t("stageLoadedDetail");
    let loading = t("stageLoadingPositions");
    if (stage === "positions" || stage === "marks") {
      loaded = t("stageLoadedPositions");
      loading = t("stageLoadingOrders");
    } else if (stage === "orders") {
      loaded = t("stageLoadedOrders");
      loading = t("stageLoadingMarket");
    } else if (stage === "exits") {
      loaded = t("exitDataReady");
      loading = t("exitOptimizing");
    }
    const percent = loadPercent(run);
    return h("div", { class: "ctl-streaming-banner", title: t("streamingBanner", [loaded, loading]) }, [
      h("div", { class: "ctl-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percent) }, [
        h("div", { class: "ctl-progress-fill", style: `width: ${percent}%` })
      ]),
      h("div", { class: "ctl-progress-text" }, [
        h("span", { class: "ctl-mini-spinner", style: "border-top-color: #f0b90b; margin-right: 6px;" }),
        h("span", { text: `⚡ ${loaded} ｜ ` }),
        h("span", { text: `${loading}...` })
      ])
    ]);
  }

  function renderAdvisorEmpty(raw) {
    return h("div", { class: "ctl-advisor-hero ctl-advisor-empty" }, [
      h("div", { class: "ctl-advisor-hero-label", text: t("sectionStopLossRadar") }),
      h("p", { class: "ctl-muted", style: "margin: 12px 0 16px; font-size: 13px; line-height: 1.5;", text: t("cautionThinClosedTrades", [raw?.positionHistory?.length || 0]) || t("payoffNoClosedTrades") }),
      h("button", {
        class: "ctl-primary ctl-advisor-apply-btn",
        type: "button",
        onclick: () => {
          settingModeView = "full";
          paint();
        }
      }, [
        h("span", { text: t("btnViewFullAnalysis") })
      ])
    ]);
  }

  function renderAdvisorContent(radar, raw, pending) {
    if (pending) {
      return loadingBlock("ctl-advisor-hero ctl-advisor-empty", typeof pending === "object"
        ? t(pending.scope === "holdout" ? "exitValidatingProgress" : "exitOptimizingProgress", [pending.done.toLocaleString("en-US"), pending.total.toLocaleString("en-US"), pending.percent])
        : t("exitOptimizing"));
    }
    const selection = radar.exitSelection;
    const optimal = selection?.optimal || { stop: (noStopOptimal(radar) ? null : radar.recommendedRoe), takeProfit: null };
    const stopValText = exitOptionLabel(optimal.stop);
    const tpValText = exitOptionLabel(optimal.takeProfit);
    const stopSub = optimal.stop === null ? t("radarDecisionOptional") : t("radarEquivalentPrice", [radar.dominantLeverage, (optimal.stop / radar.dominantLeverage).toFixed(2)]);
    const tpSub = optimal.takeProfit === null ? t("advisorDisabledBadge") : `+${(optimal.takeProfit / radar.dominantLeverage).toFixed(2)}%`;

    const deltaMin = selection?.deltaMin ?? (radar.tradeoff?.helpedUsdt ? (radar.tradeoff.helpedUsdt + radar.tradeoff.hurtUsdt) : 0);
    const deltaMax = selection?.deltaMax ?? deltaMin;
    const baseline = selection?.baselinePnl ?? radar.tradeoff?.pnlNone;
    let pctSuffix = "";
    if (Number.isFinite(baseline) && Math.abs(baseline) > 0) {
      const pLow = ((deltaMin / Math.abs(baseline)) * 100).toFixed(1);
      const pHigh = ((deltaMax / Math.abs(baseline)) * 100).toFixed(1);
      const signL = deltaMin > 0 ? "+" : "";
      const signH = deltaMax > 0 ? "+" : "";
      pctSuffix = deltaMin === deltaMax ? ` (${signL}${pLow}%)` : ` (${signL}${pLow}%～${signH}${pHigh}%)`;
    }
    const gainText = deltaMin > 0
      ? `+${exitMoneyRange(deltaMin, deltaMax)} USDT${pctSuffix}`
      : (deltaMin === 0 && deltaMax === 0 ? `${t("advisorKpiGainNone")}${pctSuffix || " (+0.0%)"}` : `${exitMoneyRange(deltaMin, deltaMax)} USDT${pctSuffix}`);
    const gainClass = deltaMin > 0 ? "is-green" : (deltaMax < 0 ? "is-danger" : "is-gold");

    const hasInsuranceNote = optimal.stop === null && Number.isInteger(radar.recommendedRoe);

    return h("div", {}, [
      // Hero Setting Card
      h("div", { class: "ctl-advisor-hero-card" }, [
        h("div", { class: "ctl-advisor-card-title" }, [
          h("span", { text: t("exitHistoricalLabel") }),
          h("span", { class: "ctl-advisor-badge", text: t("advisorOptimalBadge") })
        ]),
        h("div", { class: "ctl-advisor-pair-grid" }, [
          h("div", { class: "ctl-advisor-cell" }, [
            h("span", { class: "ctl-advisor-cell-label", text: t("exitStopLabel") }),
            h("strong", { class: "ctl-advisor-val-large", text: stopValText }),
            h("span", { class: "ctl-advisor-val-sub", text: stopSub })
          ]),
          h("div", { class: "ctl-advisor-cell" }, [
            h("span", { class: "ctl-advisor-cell-label", text: t("exitTakeProfitLabel") }),
            h("strong", { class: "ctl-advisor-val-large", text: tpValText }),
            h("span", { class: "ctl-advisor-val-sub", text: tpSub })
          ])
        ]),
        hasInsuranceNote ? h("div", { class: "ctl-advisor-insurance-tip", text: t("advisorInsuranceNote", [radar.recommendedRoe, radar.winRetentionRate]) }) : null,
        h("button", {
          class: "ctl-primary ctl-advisor-apply-btn",
          type: "button",
          onclick: (e) => {
            const btn = e.currentTarget;
            const filled = selection ? applyJointExitsToBinanceInputs(selection) : applyStopLossToBinanceInputs(radar.recommendedRoe);
            btn.textContent = filled ? `✓ ${t("exitApplied")}` : t("exitInputUnavailable");
            btn.classList.toggle("is-applied", filled);
            setTimeout(() => {
              btn.textContent = `⚡ ${t("advisorBtnApply")}`;
              btn.classList.remove("is-applied");
            }, 2500);
          }
        }, [
          h("span", { text: `⚡ ${t("advisorBtnApply")}` })
        ])
      ]),

      // 2x2 Key Decision Metrics
      h("div", { class: "ctl-advisor-kpi-grid" }, [
        h("div", { class: "ctl-advisor-kpi-card" }, [
          h("span", { class: "ctl-advisor-kpi-label", text: `🎯 ${t("advisorKpiWinRate")}` }),
          h("strong", { class: "ctl-advisor-kpi-val", text: `${radar.winRetentionRate}%` })
        ]),
        h("div", { class: "ctl-advisor-kpi-card" }, [
          h("span", { class: "ctl-advisor-kpi-label", text: `🛡️ ${t("advisorKpiDrawdown")}` }),
          h("strong", { class: `ctl-advisor-kpi-val ${radar.hasSevereBagHolding ? "is-danger" : ""}`, text: `-${radar.worstHistoricalRoeMae}%` })
        ]),
        h("div", { class: "ctl-advisor-kpi-card" }, [
          h("span", { class: "ctl-advisor-kpi-label", text: `💰 ${t("advisorKpiGain")}` }),
          h("strong", { class: `ctl-advisor-kpi-val ${gainClass}`, text: gainText })
        ]),
        h("div", { class: "ctl-advisor-kpi-card" }, [
          h("span", { class: "ctl-advisor-kpi-label", text: `⚡ ${t("radarDominantLev")}` }),
          h("strong", { class: "ctl-advisor-kpi-val is-gold", text: `${radar.dominantLeverage}x` })
        ])
      ]),

      // Expandable Technical Backtest Details
      h("details", { class: "ctl-advisor-details" }, [
        h("summary", { class: "ctl-advisor-details-summary", text: t("advisorDetailsSummary") }),
        h("div", { class: "ctl-advisor-details-content" }, [
          h("div", { class: "ctl-value-pillars" }, [
            h("div", { class: "ctl-pillar" }, [
              h("strong", {}, [
                h("span", { text: "🎯 " }),
                h("span", { text: t("settingValuePropWinTitle", [radar.winRetentionRate]) })
              ]),
              h("p", { text: t("settingValuePropWinDesc") })
            ]),
            h("div", { class: "ctl-pillar" }, [
              h("strong", {}, [
                h("span", { text: "🛡️ " }),
                h("span", { text: t("settingValuePropBagTitle") })
              ]),
              h("p", { text: t("settingValuePropBagDesc", [radar.worstHistoricalRoeMae]) })
            ]),
            h("div", { class: "ctl-pillar" }, [
              h("strong", {}, [
                h("span", { text: "📊 " }),
                h("span", { text: t("settingValuePropStatsTitle") })
              ]),
              h("p", { text: t("settingValuePropStatsDesc", [radar.allStats.p50.toFixed(1), radar.allStats.p90.toFixed(1)]) })
            ])
          ]),
          h("div", { class: "ctl-radar-why" }, (selection ? jointExitExplanation(radar) : stopSummaryLines(radar)).map((text) => h("p", { text }))),
          ...(selection ? jointExitProfiles(selection) : [stopPriceList(radar)]),
          h("p", { class: "ctl-muted", style: "font-size: 11px; margin-top: 8px;", text: t("radarBinanceRoeNotice") })
        ])
      ])
    ]);
  }

  function renderSettingAdvisor(context, raw, analysis) {
    const radar = analysis?.stopLossRadar;
    const meta = analysis?.meta || {};
    const traderName = meta.name || context.id;
    const radarReady = landed("positions", "marks", "orders", "market");
    const exitsPending = run.phase !== "ready" && run.streamingStage === "exits" && (run.exitProgress || true);

    ensureRoot().replaceChildren(
      h("section", { class: "ctl-panel ctl-setting-card" }, [
        h("header", { class: "ctl-header" }, [
          h("div", {}, [
            h("span", { class: "ctl-eyebrow", text: `Copy Trading Lens · ${context.platform}` }),
            h("h2", { text: t("settingAdvisorTitle") }),
            h("p", { class: "ctl-advisor-subtitle", text: radar && !radar.insufficientData ? t("settingAdvisorSubtitle", [traderName, radar.dominantLeverage]) : traderName })
          ]),
          h("div", { class: "ctl-actions" }, [
            h("button", { class: "ctl-icon-btn", title: t("refreshTitle"), onclick: () => runAnalysis(true) }, "↻"),
            collapseButton()
          ])
        ]),
        run.phase === "ready" ? null : renderStreamingBanner(run.streamingStage),

        !radarReady
          ? loadingBlock("ctl-advisor-hero ctl-advisor-empty", t("streamingRadarLoading"))
          : (radar && !radar.insufficientData ? renderAdvisorContent(radar, raw, exitsPending) : renderAdvisorEmpty(raw)),

        h("div", { class: "ctl-advisor-footer" }, [
          h("button", {
            class: "ctl-advisor-toggle-btn",
            type: "button",
            onclick: () => {
              settingModeView = "full";
              paint();
            }
          }, t("btnViewFullAnalysis"))
        ])
      ])
    );
  }

  function renderAnalysis(context, raw, analysis) {
    const fmt = window.CopyTradingLensAnalysis;
    const meta = analysis.meta;
    const summary = analysis.summary;
    const orders = analysis.orders;
    const live = analysis.live;
    const verdict = analysis.verdict;
    const strategy = analysis.strategy;
    const transfers = analysis.transfers;
    const finished = landed("detail", "positions", "marks", "orders", "market");

    ensureRoot().replaceChildren(
      h("section", { class: "ctl-panel" }, [
        context.pageType === "copy-setting" ? h("button", {
          class: "ctl-advisor-return-btn",
          type: "button",
          onclick: () => {
            settingModeView = "advisor";
            paint();
          }
        }, t("btnReturnToAdvisor")) : null,
        run.phase === "ready" ? null : renderStreamingBanner(run.streamingStage),
        h("header", { class: "ctl-header" }, [
          h("div", {}, [
            h("span", { class: "ctl-eyebrow", text: `${context.platform} / ${meta.id} · ${meta.isPrivate ? t("badgePrivate") : t("badgePublic")}` }),
            h("h2", { text: `${meta.name} (${meta.isPrivate ? t("badgePrivate") : t("badgePublic")})` })
          ]),
          h("div", { class: "ctl-actions" }, [
            h("button", { class: "ctl-icon-btn", title: t("refreshTitle"), onclick: () => runAnalysis(true) }, "↻"),
            collapseButton()
          ])
        ]),
        // The rating and the strategy label are read off everything: positions, fills, transfers, equity.
        finished && verdict.alerts?.length
          ? h("div", { class: "ctl-alerts" }, verdict.alerts.map((alertText) => h("div", { class: "ctl-alert-badge", text: alertText })))
          : null,
        finished
          ? h("div", { class: `ctl-verdict ${verdictClass(verdict.level)}` }, [
            h("strong", { text: verdict.title }),
            h("span", { text: strategy.family })
          ])
          : loadingBlock("ctl-verdict", t("streamingVerdictLoading")),
        finished && (strategy.labels?.length || verdict.momentumStatus) ? h("div", { class: "ctl-tags" }, [
          ...(verdict.momentumStatus === "active" ? [h("span", { class: "ctl-tag is-active-momentum", text: t("badgeActiveMomentum") })] : []),
          ...(verdict.momentumStatus === "stagnant" ? [h("span", { class: "ctl-tag is-stagnant", text: t("badgeStagnant") })] : []),
          ...(verdict.momentumStatus === "drawdown" ? [h("span", { class: "ctl-tag is-drawdown", text: t("badgeInDrawdown") })] : []),
          ...(strategy.labels || []).map((label) => h("span", { class: "ctl-tag", text: label }))
        ]) : null,
        h("div", { class: "ctl-grid" }, [
          metricOrLoading(["orders"], t("metricAllPeriodRoi"), "streamingHintPerformance", () => metricCard(t("metricAllPeriodRoi"), fmt.formatPct(meta.roi), meta.performanceSource || t("hintHistoryApi"))),
          metricOrLoading(["orders"], t("metricAnnualized"), "streamingHintPerformance", () => metricCard(t("metricAnnualized"), fmt.formatPct(meta.annualizedReturn), meta.annualizedSource || "CAGR/APY")),
          metricOrLoading(["orders"], t("metricMdd"), "streamingHintPerformance", () => metricCard(t("metricMdd"), fmt.formatPct(meta.mdd), meta.primaryWindow ? t("hintMddWindowMax") : (meta.performanceQuality || t("colSource")))),
          metricOrLoading(["orders"], t("metricAllPeriodPnl"), "streamingHintPerformance", () => metricCard(t("metricAllPeriodPnl"), fmt.formatMoney(meta.pnl), t("hintCurrentCapitalFormula"))),
          metricCard(t("metricTradingDays"), meta.days ? t("daysValue", [meta.days.toFixed(0)]) : "N/A"),
          metricCard(t("metricCopierPnlAum"), meta.aum ? `${(meta.copierPnl / meta.aum * 100).toFixed(1)}%` : "N/A"),
          metricOrLoading(["positions"], t("metricWinRate"), "streamingHintPositions", () => metricCard(
            t("metricWinRate"),
            fmt.formatPct(summary.winRate * 100),
            summary.openPositionsExcluded
              ? t("closedTradesOpenExcluded", [summary.closedTrades, summary.openPositionsExcluded])
              : t("closedTrades", [summary.closedTrades])
          )),
          metricOrLoading(["positions"], t("metricPayoffRatio"), "streamingHintPositions", () => metricCard(
            t("metricPayoffRatio"),
            summary.payoffRatio === null ? "N/A" : summary.payoffRatio.toFixed(2),
            payoffUnavailableReason(summary)
          )),
          metricOrLoading(["positions"], t("metricLossHold"), "streamingHintPositions", () => metricCard(t("metricLossHold"), fmt.formatHours(summary.avgLossHoldHours), t("longestHold", [fmt.formatHours(summary.maxLossHoldHours)]))),
          metricOrLoading(["orders"], t("metricAdverseAdd"), "streamingHintOrders", () => metricCard(t("metricAdverseAdd"), fmt.formatPct(orders.adverseAddRate * 100), `${orders.adverseAdds}/${orders.openOrders}`)),
          metricOrLoading(["positions", "orders"], t("metricFloatingLoss"), "streamingHintOrders", () => metricCard(t("metricFloatingLoss"), fmt.formatMoney(live.openUnrealizedLoss), t("marginPct", [(live.openUnrealizedLossToMargin * 100).toFixed(1)]))),
          metricOrLoading(["orders"], t("metricLossPeriodDeposit"), "streamingHintTransfers", () => metricCard(
            t("metricLossPeriodDeposit"),
            t("lossPeriodDepositCount", [transfers.lossPeriodDepositCount]),
            transfers.lossPeriodDepositCount > 0
              ? t("lossPeriodDepositHint", [fmt.formatMoney(transfers.lossPeriodDepositTotal), fmt.formatDateTime(transfers.lastLossPeriodDepositAt)])
              : t("lossPeriodDepositNone"),
            transfers.lossPeriodDepositCount > 0 ? "is-danger" : ""
          )),
          metricCard(t("metricRestartCount"), String(meta.closeLeadCount || 0), t("portfolioRestart")),
          metricOrLoading(["market"], t("metricBiggestBet"), "streamingHintEquity", () => (analysis.biggestBet
            ? metricCard(
              t("metricBiggestBet"),
              t("biggestBetValue", [analysis.biggestBet.leverage.toFixed(1)]),
              t(analysis.biggestBet.boundByLeverage ? "biggestBetHintBound" : "biggestBetHint", [
                t("biggestBetPosition", [analysis.biggestBet.symbol, t(analysis.biggestBet.side === "SHORT" ? "posShort" : "posLong")]),
                fmt.formatDateTime(analysis.biggestBet.at),
                analysis.biggestBet.wipeOutMovePct.toFixed(1)
              ])
            )
            : metricCard(t("metricBiggestBet"), "N/A")))
        ]),
        finished ? h("section", { class: "ctl-section" }, [
          h("h3", { text: t("sectionRisks") }),
          bullets(verdict.cautions, t("noMajorRisks"))
        ]) : null,
        finished ? h("section", { class: "ctl-section" }, [
          h("h3", { text: t("sectionPositives") }),
          bullets(verdict.positives, t("noPositives"))
        ]) : null,
        finished ? renderStopLossRadar(analysis.stopLossRadar) : renderRadarLoading(),
        finished ? h("section", { class: "ctl-section" }, [
          h("h3", { text: t("sectionSettings") }),
          bullets(settingAdvice(analysis), "")
        ]) : null,
        finished ? h("details", { class: "ctl-details" }, [
          h("summary", { text: t("advancedData", [statusText(raw.endpointResults)]) }),
          h("h3", { text: t("advancedWindowCrossCheck") }),
          performanceWindowTable(meta, fmt),
          h("p", { class: "ctl-muted ctl-small-note", text: t("historyDataPrefix", [historyCompleteness(raw)]) }),
          endpointList(raw.endpointResults),
          h("pre", { text: JSON.stringify(analysis.rawCounts, null, 2) })
        ]) : null,
        h("p", { class: "ctl-disclaimer", text: t("disclaimer") })
      ])
    );
  }

  const HISTORY_LABELS = new Set(["positionHistory", "orderHistory", "transferHistory"]);
  const STAGE_ORDER = { detail: 0, positions: 1, marks: 1, orders: 2 };

  async function runAnalysis(force = false) {
    const context = window.CopyTradingLensProviders.detectLeadPage();
    if (!context) {
      run?.fetchControl?.resume();
      run = null;
      paint();
      window.CopyTradingLensPositionsPanel?.unmount();
      return;
    }
    const key = `${context.platform}:${context.id}:${location.href}`;
    if (!force && run?.key === key && root) return;
    // Release an older paused read before replacing it. It is superseded and
    // may otherwise remain suspended forever after a route change or refresh.
    run?.fetchControl?.resume();
    // The in-page positions panel needs the same payload as the overlay, so the
    // fetch happens once per run. When the overlay is already collapsed, start
    // the new run paused so a route check cannot unexpectedly flood the page.
    const current = {
      id: ++runSeq,
      key,
      context,
      phase: "loading",
      streamingStage: "init",
      progress: {},
      fetchControl: createFetchControl(collapsed)
    };
    run = current;
    // A refresh or a route change starts a newer run while this one is still
    // reading; whichever answers last, only the newest may land.
    const superseded = () => run?.id !== current.id;
    paint();
    window.CopyTradingLensPositionsPanel?.beginLoading(context, () => runAnalysis(true));
    try {
      const raw = await window.CopyTradingLensProviders.fetchLeadData(context, {
        waitUntilResumed: () => current.fetchControl.waitUntilResumed(),
        onProgress: (event) => {
          if (superseded()) return;
          // the positions panel shows the three paged histories; the bar also counts the candle and market reads
          if (HISTORY_LABELS.has(event.label)) window.CopyTradingLensPositionsPanel?.setProgress(event);
          const before = loadPercent(run);
          run = { ...run, progress: { ...run.progress, [event.label]: { done: event.done ?? event.fetched, total: event.total } } };
          if (loadPercent(run) !== before) {
            if (!updateProgressBannerOnly()) paint();
          }
        },
        // The read lands in pieces and the card fills in as each does. Marks can land after orders: keep the furthest
        // stage reached. A partial analysis can fail on what has not landed; then nothing is drawn yet.
        onProgressive: (event) => {
          if (superseded()) return;
          const reached = (STAGE_ORDER[event.stage] ?? 0) >= (STAGE_ORDER[run.streamingStage] ?? -1) ? event.stage : run.streamingStage;
          let analysis = null;
          try {
            analysis = context.platform === "Binance"
              ? window.CopyTradingLensAnalysis.analyzeBinance(event.raw)
              : window.CopyTradingLensAnalysis.analyzeOkx(event.raw);
          } catch (_error) {
            analysis = null;
          }
          run = { ...run, streamingStage: reached, raw: event.raw, analysis };
          paint();
        }
      });
      if (superseded()) return;
      const exitEngine = window.CopyTradingLensStopLoss;
      if (context.platform === "Binance" && exitEngine?.selectExitAsync) {
        // The joint grid yields to the UI and shares the same pause/cancel boundary as
        // network reads. Partial provider snapshots never launch duplicate searches.
        run = {
          ...run, raw, streamingStage: "exits",
          analysis: window.CopyTradingLensAnalysis.analyzeBinance({ ...raw, exitSelection: null })
        };
        paint();
        const rows = exitEngine.positionExcursions(raw.positionHistory || [], raw.orderHistory || [], raw.positionMarks);
        const exitSelection = await exitEngine.selectExitAsync(rows, null, {
          withHoldout: true,
          isCancelled: superseded,
          waitUntilResumed: () => current.fetchControl.waitUntilResumed(),
          onProgress: (event) => {
            if (superseded() || !(event.count > 0)) return;
            const percent = Math.min(99, Math.floor(event.evaluations / event.count * 100));
            const scope = event.scope || "historical";
            if (run.exitProgress?.percent === percent && run.exitProgress?.scope === scope) return;
            run = { ...run, exitProgress: { done: event.evaluations, total: event.count, percent, scope } };
            paint();
          }
        });
        if (superseded()) return;
        raw.exitSelection = exitSelection;
      }
      const analysis = context.platform === "Binance"
        ? window.CopyTradingLensAnalysis.analyzeBinance(raw)
        : window.CopyTradingLensAnalysis.analyzeOkx(raw);
      run = { ...current, phase: "ready", raw, analysis };
      paint();
      window.CopyTradingLensPositionsPanel?.mount(context, raw);
    } catch (error) {
      if (superseded()) return;
      run = { ...current, phase: "failed", error };
      paint();
      window.CopyTradingLensPositionsPanel?.fail(error);
    }
  }

  let lastKnownHref = location.href;

  function scheduleRouteCheck(delay = 80) {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      runAnalysis(false);
    }, delay);
  }

  // Intercept Next.js / SPA client-side routing via pushState & replaceState
  try {
    const originalPushState = history.pushState;
    if (typeof originalPushState === "function") {
      history.pushState = function (...args) {
        const result = originalPushState.apply(this, args);
        if (location.href !== lastKnownHref) {
          lastKnownHref = location.href;
          scheduleRouteCheck(50);
        }
        return result;
      };
    }

    const originalReplaceState = history.replaceState;
    if (typeof originalReplaceState === "function") {
      history.replaceState = function (...args) {
        const result = originalReplaceState.apply(this, args);
        if (location.href !== lastKnownHref) {
          lastKnownHref = location.href;
          scheduleRouteCheck(50);
        }
        return result;
      };
    }
  } catch (_e) {}

  // Tell the service worker a content script just loaded. In an unpacked build
  // that is what triggers the stale-build check (see src/background.js); in a
  // packed build nothing listens and the message is a no-op.
  try {
    chrome.runtime?.sendMessage?.({ type: "ctl:content-loaded" });
  } catch (_error) {
    // Extension context can be invalidated mid-reload; nothing to recover.
  }

  // Capture phase, so the card is read before the page's own handler navigates.
  document.addEventListener("click", (event) => {
    if (location.pathname.includes("/copy-trading/copy-management")) {
      window.CopyTradingLensProviders.rememberPressedCard(event.target);
    }
  }, true);

  window.addEventListener("popstate", () => {
    lastKnownHref = location.href;
    scheduleRouteCheck(50);
  });
  window.addEventListener("hashchange", () => {
    lastKnownHref = location.href;
    scheduleRouteCheck(50);
  });

  // Fast background polling ticker to detect URL changes that might bypass pushState
  setInterval(() => {
    if (location.href !== lastKnownHref) {
      lastKnownHref = location.href;
      scheduleRouteCheck(50);
    } else if (!run && location.pathname.includes("/copy-trading/copy-setting")) {
      runAnalysis(false);
    }
  }, 250);

  runAnalysis(false);
})();
