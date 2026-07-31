(function initCopyTradingLens() {
  "use strict";

  const ROOT_ID = "copy-trading-lens-root";
  let currentKey = "";
  let collapsed = false;
  let root = null;
  let routeTimer = null;

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

  function renderLauncher(context) {
    ensureRoot().replaceChildren(
      h("button", {
        class: "ctl-launcher",
        title: t("launcherTitle"),
        onclick: () => {
          collapsed = false;
          runAnalysis(true);
        }
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

  function renderLoading(context) {
    ensureRoot().replaceChildren(
      h("section", { class: "ctl-panel" }, [
        h("header", { class: "ctl-header" }, [
          h("div", {}, [
            h("span", { class: "ctl-eyebrow", text: "Copy Trading Lens" }),
            h("h2", { text: t("analysisInProgress", [context.platform]) })
          ]),
          h("button", { class: "ctl-icon-btn", title: t("collapseTitle"), onclick: () => {
            collapsed = true;
            renderLauncher(context);
          } }, "−")
        ]),
        h("div", { class: "ctl-loading" }, [
          h("div", { class: "ctl-spinner" }),
          h("p", { text: t("loadingText") })
        ])
      ])
    );
  }

  function renderError(context, error) {
    ensureRoot().replaceChildren(
      h("section", { class: "ctl-panel" }, [
        h("header", { class: "ctl-header" }, [
          h("div", {}, [
            h("span", { class: "ctl-eyebrow", text: "Copy Trading Lens" }),
            h("h2", { text: t("analysisFailed") })
          ]),
          h("button", { class: "ctl-icon-btn", title: t("collapseTitle"), onclick: () => {
            collapsed = true;
            renderLauncher(context);
          } }, "−")
        ]),
        h("p", { class: "ctl-error", text: error instanceof Error ? error.message : String(error) }),
        h("button", { class: "ctl-primary", onclick: () => runAnalysis(true) }, t("retry"))
      ])
    );
  }

  function verdictClass(level) {
    if (level === "avoid") return "is-avoid";
    if (level === "risky") return "is-risky";
    if (level === "preferred") return "is-preferred";
    if (level === "followable") return "is-followable";
    return "is-watch";
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

    ensureRoot().replaceChildren(
      h("section", { class: "ctl-panel" }, [
        h("header", { class: "ctl-header" }, [
          h("div", {}, [
            h("span", { class: "ctl-eyebrow", text: `${context.platform} / ${meta.id}` }),
            h("h2", { text: meta.name })
          ]),
          h("div", { class: "ctl-actions" }, [
            h("button", { class: "ctl-icon-btn", title: t("refreshTitle"), onclick: () => runAnalysis(true) }, "↻"),
            h("button", { class: "ctl-icon-btn", title: t("collapseTitle"), onclick: () => {
              collapsed = true;
              renderLauncher(context);
            } }, "−")
          ])
        ]),
        h("div", { class: `ctl-verdict ${verdictClass(verdict.level)}` }, [
          h("strong", { text: verdict.title }),
          h("span", { text: strategy.family })
        ]),
        strategy.labels?.length ? h("div", { class: "ctl-tags" }, strategy.labels.map((label) => h("span", { text: label }))) : null,
        h("div", { class: "ctl-grid" }, [
          metricCard(t("metricAllPeriodRoi"), fmt.formatPct(meta.roi), meta.performanceSource || t("hintHistoryApi")),
          metricCard(t("metricAnnualized"), fmt.formatPct(meta.annualizedReturn), meta.annualizedSource || "CAGR/APY"),
          metricCard(t("metricMdd"), fmt.formatPct(meta.mdd), meta.primaryWindow ? t("hintMddWindowMax") : (meta.performanceQuality || t("colSource"))),
          metricCard(t("metricAllPeriodPnl"), fmt.formatMoney(meta.pnl), t("hintCurrentCapitalFormula")),
          metricCard(t("metricTradingDays"), meta.days ? t("daysValue", [meta.days.toFixed(0)]) : "N/A"),
          metricCard(t("metricCopierPnlAum"), meta.aum ? `${(meta.copierPnl / meta.aum * 100).toFixed(1)}%` : "N/A"),
          metricCard(t("metricWinRate"), fmt.formatPct(summary.winRate * 100), t("closedTrades", [summary.closedTrades])),
          metricCard(t("metricPayoffRatio"), summary.payoffRatio === null ? "N/A" : summary.payoffRatio.toFixed(2)),
          metricCard(t("metricLossHold"), fmt.formatHours(summary.avgLossHoldHours), t("longestHold", [fmt.formatHours(summary.maxLossHoldHours)])),
          metricCard(t("metricAdverseAdd"), fmt.formatPct(orders.adverseAddRate * 100), `${orders.adverseAdds}/${orders.openOrders}`),
          metricCard(t("metricFloatingLoss"), fmt.formatMoney(live.openUnrealizedLoss), t("marginPct", [(live.openUnrealizedLossToMargin * 100).toFixed(1)])),
          metricCard(
            t("metricLossPeriodDeposit"),
            t("lossPeriodDepositCount", [transfers.lossPeriodDepositCount]),
            transfers.lossPeriodDepositCount > 0 ? t("lossPeriodDepositHint", [fmt.formatMoney(transfers.lossPeriodDepositTotal)]) : t("lossPeriodDepositNone"),
            transfers.lossPeriodDepositCount > 0 ? "is-danger" : ""
          ),
          metricCard(t("metricRestartCount"), String(meta.closeLeadCount || 0), t("portfolioRestart"))
        ]),
        h("section", { class: "ctl-section" }, [
          h("h3", { text: t("sectionRisks") }),
          bullets(verdict.cautions, t("noMajorRisks"))
        ]),
        h("section", { class: "ctl-section" }, [
          h("h3", { text: t("sectionPositives") }),
          bullets(verdict.positives, t("noPositives"))
        ]),
        h("section", { class: "ctl-section" }, [
          h("h3", { text: t("sectionSettings") }),
          bullets(settingAdvice(analysis), "")
        ]),
        h("details", { class: "ctl-details" }, [
          h("summary", { text: t("advancedData", [statusText(raw.endpointResults)]) }),
          h("h3", { text: t("advancedWindowCrossCheck") }),
          performanceWindowTable(meta, fmt),
          h("p", { class: "ctl-muted ctl-small-note", text: t("historyDataPrefix", [historyCompleteness(raw)]) }),
          endpointList(raw.endpointResults),
          h("pre", { text: JSON.stringify(analysis.rawCounts, null, 2) })
        ]),
        h("p", { class: "ctl-disclaimer", text: t("disclaimer") })
      ])
    );
  }

  async function runAnalysis(force = false) {
    const context = window.CopyTradingLensProviders.detectLeadPage();
    if (!context) {
      currentKey = "";
      clearRoot();
      return;
    }
    const key = `${context.platform}:${context.id}:${location.href}`;
    if (!force && currentKey === key && root) return;
    currentKey = key;
    if (collapsed) {
      renderLauncher(context);
      return;
    }
    renderLoading(context);
    try {
      const raw = await window.CopyTradingLensProviders.fetchLeadData(context);
      const analysis = context.platform === "Binance"
        ? window.CopyTradingLensAnalysis.analyzeBinance(raw)
        : window.CopyTradingLensAnalysis.analyzeOkx(raw);
      renderAnalysis(context, raw, analysis);
    } catch (error) {
      renderError(context, error);
    }
  }

  function scheduleRouteCheck() {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => runAnalysis(false), 350);
  }

  window.addEventListener("popstate", scheduleRouteCheck);
  setInterval(scheduleRouteCheck, 1500);
  runAnalysis(false);
})();
