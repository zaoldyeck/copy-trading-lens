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
    if (!run) return clearRoot();
    if ((run.phase === "ready" || run.phase === "streaming") && run.analysis?.stopLossRadar) {
      mountInlineSettingHelper(run.analysis.stopLossRadar);
    }
    if (collapsed) return renderLauncher(run.context);
    if (run.phase === "loading") return renderLoading(run.context);
    if (run.phase === "failed") return renderError(run.error);

    const isStreaming = run.phase === "streaming";
    if (run.context?.pageType === "copy-setting" && settingModeView === "advisor") {
      return renderSettingAdvisor(run.context, run.raw, run.analysis, isStreaming);
    }

    return renderAnalysis(run.context, run.raw, run.analysis, isStreaming);
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

  function metricLoadingCard(label, hint = "") {
    return h("div", { class: "ctl-metric is-streaming-metric" }, [
      h("span", { text: label }),
      h("strong", { class: "ctl-loading-text", text: t("metricLoadingText") }),
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

  function applyStopLossToBinanceInputs(value) {
    const inputs = Array.from(document.querySelectorAll("input"));
    const stopLossInputs = inputs.filter((i) => {
      if (i.placeholder === "0-95") {
        const p = i.closest("div")?.parentElement?.parentElement?.innerText || "";
        return /止損|Stop Loss|損切り/i.test(p);
      }
      return false;
    });

    const targets = stopLossInputs.length ? stopLossInputs : inputs.filter((i) => i.placeholder === "0-95");
    let filled = 0;

    for (const input of targets) {
      try {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        if (nativeSetter) {
          nativeSetter.call(input, String(value));
        } else {
          input.value = String(value);
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
        filled++;
      } catch (_err) {}
    }
    return filled > 0;
  }

  function mountInlineSettingHelper(radar) {
    if (!radar || radar.insufficientData) return;
    const inputs = Array.from(document.querySelectorAll("input"));
    const targets = inputs.filter((i) => {
      if (i.placeholder === "0-95") {
        const p = i.closest("div")?.parentElement?.parentElement?.innerText || "";
        return /止損|Stop Loss|損切り/i.test(p);
      }
      return false;
    });

    const target = targets[0] || inputs.find((i) => i.placeholder === "0-95");
    if (!target) return;
    const container = target.closest(".input") || target.parentElement;
    if (!container || container.querySelector(".ctl-inline-helper")) return;

    const chip = h("button", {
      class: "ctl-inline-helper",
      type: "button",
      title: t("inlineChipTitle", [radar.recommendedRoe]),
      onclick: (e) => {
        e.preventDefault();
        applyStopLossToBinanceInputs(radar.recommendedRoe);
        chip.textContent = `✓ ${t("inlineChipApplied", [radar.recommendedRoe])}`;
        chip.classList.add("is-applied");
      }
    }, [
      h("span", { text: `⚡ CopyLens 推薦: ${radar.recommendedRoe}% (點擊填入)` })
    ]);

    container.appendChild(chip);
  }

  function renderStopLossRadar(radar) {
    if (!radar || radar.insufficientData) return null;
    const hasBag = radar.hasSevereBagHolding;
    return h("section", { class: "ctl-section ctl-radar-section" }, [
      h("div", { class: "ctl-radar-header" }, [
        h("h3", { text: t("sectionStopLossRadar") }),
        !radar.isPreciseMae
          ? h("span", { class: "ctl-radar-badge ctl-streaming-badge", text: t("radarPreciseBadge") })
          : null,
        hasBag
          ? h("span", { class: "ctl-radar-badge is-danger", text: t("badgeBagHoldingAlert") })
          : h("span", { class: "ctl-radar-badge is-safe", text: t("badgeMathOptimal") })
      ]),
      h("div", { class: "ctl-radar-box" }, [
        h("div", { class: "ctl-radar-primary" }, [
          h("div", { class: "ctl-radar-label", text: t("radarRecommendedLabel") }),
          h("div", { class: "ctl-radar-value" }, [
            h("span", { class: "ctl-radar-number", text: `${radar.recommendedRoe}%` }),
            h("span", { class: "ctl-radar-unit", text: t("radarRoeUnit") })
          ]),
          h("div", { class: "ctl-radar-sub", text: t("radarEquivalentPrice", [radar.dominantLeverage, radar.recommendedPriceDrop]) }),
          h("div", { class: "ctl-radar-direct-hint", text: t("radarDirectInputHint", [radar.recommendedRoe]) }),
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
                  btn.textContent = `⚡ ${t("btnApplyToBinanceForm", [radar.recommendedRoe])}`;
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
              ? `⚡ ${t("btnApplyToBinanceForm", [radar.recommendedRoe])}`
              : `📋 ${t("btnCopyToClipboard", [radar.recommendedRoe])}`
            })
          ])
        ]),
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
          h("div", { class: "ctl-radar-stat" }, [
            h("span", { text: t("radarConservative") }),
            h("strong", { text: `${radar.conservativeRoe}%` })
          ])
        ])
      ]),
      hasBag
        ? h("div", { class: "ctl-radar-alert", text: t("radarSevereBagWarning", [radar.worstHistoricalRoeMae]) })
        : null,
      h("div", { class: "ctl-radar-notice", text: t("radarBinanceRoeNotice") })
    ]);
  }

  function renderLoading(context) {
    ensureRoot().replaceChildren(
      h("section", { class: "ctl-panel" }, [
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
        ])
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

  function stageBannerContent(stage) {
    if (stage === "detail") {
      return t("streamingBanner", [t("stageLoadedDetail"), t("stageLoadingPositions")]);
    }
    if (stage === "positions") {
      return t("streamingBanner", [t("stageLoadedPositions"), t("stageLoadingOrders")]);
    }
    if (stage === "orders") {
      return t("streamingBanner", [t("stageLoadedOrders"), t("stageLoadingMarket")]);
    }
    return t("streamingBanner", [t("stageLoadedDetail"), t("stageLoadingPositions")]);
  }

  function renderSettingAdvisor(context, raw, analysis, isStreaming) {
    const radar = analysis?.stopLossRadar;
    const meta = analysis?.meta || {};
    const traderName = meta.name || context.id;
    const leverage = radar?.dominantLeverage || 1;

    ensureRoot().replaceChildren(
      h("section", { class: "ctl-panel ctl-setting-card" }, [
        h("header", { class: "ctl-header" }, [
          h("div", {}, [
            h("span", { class: "ctl-eyebrow", text: `Copy Trading Lens · ${context.platform}` }),
            h("h2", { text: t("settingAdvisorTitle") }),
            h("p", { class: "ctl-advisor-subtitle", text: t("settingAdvisorSubtitle", [traderName, leverage]) })
          ]),
          h("div", { class: "ctl-actions" }, [
            h("button", { class: "ctl-icon-btn", title: t("refreshTitle"), onclick: () => runAnalysis(true) }, "↻"),
            collapseButton()
          ])
        ]),

        isStreaming
          ? h("div", { class: "ctl-streaming-banner", text: stageBannerContent(run?.streamingStage) })
          : null,

        radar && !radar.insufficientData ? h("div", { class: "ctl-advisor-hero" }, [
          h("div", { class: "ctl-advisor-hero-label", text: t("radarRecommendedLabel") }),
          h("div", { class: "ctl-advisor-hero-val" }, [
            h("span", { class: "ctl-advisor-num", text: `${radar.recommendedRoe}%` }),
            h("span", { class: "ctl-advisor-unit", text: t("radarRoeUnit") })
          ]),
          h("div", { class: "ctl-advisor-sub", text: t("radarEquivalentPrice", [radar.dominantLeverage, radar.recommendedPriceDrop]) }),
          h("button", {
            class: "ctl-primary ctl-advisor-apply-btn",
            type: "button",
            onclick: (e) => {
              const btn = e.currentTarget;
              applyStopLossToBinanceInputs(radar.recommendedRoe);
              btn.textContent = `✓ ${t("inlineChipApplied", [radar.recommendedRoe])}`;
              btn.classList.add("is-applied");
              setTimeout(() => {
                btn.textContent = `⚡ ${t("btnApplyToBinanceForm", [radar.recommendedRoe])}`;
                btn.classList.remove("is-applied");
              }, 2500);
            }
          }, [
            h("span", { text: `⚡ ${t("btnApplyToBinanceForm", [radar.recommendedRoe])}` })
          ])
        ]) : h("div", { class: "ctl-loading" }, [
          h("div", { class: "ctl-spinner" }),
          h("p", { text: t("loadingText") })
        ]),

        radar && !radar.insufficientData ? h("div", { class: "ctl-value-pillars" }, [
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
              h("span", { text: t("settingValuePropStatsTitle") }),
              !radar.isPreciseMae
                ? h("span", { class: "ctl-streaming-badge", style: "margin-left: 6px;", text: t("radarPreciseBadge") })
                : null
            ]),
            h("p", {
              text: radar.isPreciseMae
                ? t("settingValuePropStatsDesc", [radar.allStats?.p50?.toFixed(1) || "0.0", radar.allStats?.p90?.toFixed(1) || "0.0"])
                : t("settingValuePropStatsDescLoss", [radar.lossStats?.p50?.toFixed(1) || "0.0", radar.lossStats?.p90?.toFixed(1) || "0.0"])
            })
          ])
        ]) : null,

        radar && !radar.insufficientData ? h("div", { class: "ctl-advisor-range-tip", text: `💡 ${t("radarConservative")}: ${radar.conservativeRoe}% · ${t("badgeMathOptimal")}: ${radar.recommendedRoe}%` }) : null,

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

  function renderAnalysis(context, raw, analysis, isStreaming = false) {
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
        context.pageType === "copy-setting" ? h("button", {
          class: "ctl-advisor-return-btn",
          type: "button",
          onclick: () => {
            settingModeView = "advisor";
            paint();
          }
        }, t("btnReturnToAdvisor")) : null,
        isStreaming
          ? h("div", { class: "ctl-streaming-banner", text: stageBannerContent(run?.streamingStage) })
          : null,
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
        verdict.alerts?.length
          ? h("div", { class: "ctl-alerts" }, verdict.alerts.map((alertText) => h("div", { class: "ctl-alert-badge", text: alertText })))
          : null,
        h("div", { class: `ctl-verdict ${verdictClass(verdict.level)}` }, [
          h("strong", { text: verdict.title }),
          h("span", { text: strategy.family })
        ]),
        (strategy.labels?.length || verdict.momentumStatus || (isStreaming && !orders.openOrders)) ? h("div", { class: "ctl-tags" }, [
          ...(isStreaming && !orders.openOrders ? [h("span", { class: "ctl-tag ctl-streaming-badge", text: `↻ ${t("streamingStrategyLoading")}` })] : []),
          ...(verdict.momentumStatus === "active" ? [h("span", { class: "ctl-tag is-active-momentum", text: t("badgeActiveMomentum") })] : []),
          ...(verdict.momentumStatus === "stagnant" ? [h("span", { class: "ctl-tag is-stagnant", text: t("badgeStagnant") })] : []),
          ...(verdict.momentumStatus === "drawdown" ? [h("span", { class: "ctl-tag is-drawdown", text: t("badgeInDrawdown") })] : []),
          ...(strategy.labels || []).map((label) => h("span", { class: "ctl-tag", text: label }))
        ]) : null,
        h("div", { class: "ctl-grid" }, [
          metricCard(t("metricAllPeriodRoi"), fmt.formatPct(meta.roi), meta.performanceSource || t("hintHistoryApi")),
          metricCard(t("metricAnnualized"), fmt.formatPct(meta.annualizedReturn), meta.annualizedSource || "CAGR/APY"),
          metricCard(t("metricMdd"), fmt.formatPct(meta.mdd), meta.primaryWindow ? t("hintMddWindowMax") : (meta.performanceQuality || t("colSource"))),
          metricCard(t("metricAllPeriodPnl"), fmt.formatMoney(meta.pnl), t("hintCurrentCapitalFormula")),
          metricCard(t("metricTradingDays"), meta.days ? t("daysValue", [meta.days.toFixed(0)]) : "N/A"),
          metricCard(t("metricCopierPnlAum"), meta.aum ? `${(meta.copierPnl / meta.aum * 100).toFixed(1)}%` : "N/A"),
          isStreaming && !summary.closedTrades && !raw.historyStatus?.positionHistory?.complete
            ? metricLoadingCard(t("metricWinRate"), t("streamingHintPositions"))
            : metricCard(
              t("metricWinRate"),
              fmt.formatPct(summary.winRate * 100),
              summary.openPositionsExcluded
                ? t("closedTradesOpenExcluded", [summary.closedTrades, summary.openPositionsExcluded])
                : t("closedTrades", [summary.closedTrades])
            ),
          isStreaming && !summary.closedTrades && !raw.historyStatus?.positionHistory?.complete
            ? metricLoadingCard(t("metricPayoffRatio"), t("streamingHintPositions"))
            : metricCard(
              t("metricPayoffRatio"),
              summary.payoffRatio === null ? "N/A" : summary.payoffRatio.toFixed(2),
              payoffUnavailableReason(summary)
            ),
          isStreaming && !summary.closedTrades && !raw.historyStatus?.positionHistory?.complete
            ? metricLoadingCard(t("metricLossHold"), t("streamingHintPositions"))
            : metricCard(t("metricLossHold"), fmt.formatHours(summary.avgLossHoldHours), t("longestHold", [fmt.formatHours(summary.maxLossHoldHours)])),
          isStreaming && !orders.openOrders
            ? metricLoadingCard(t("metricAdverseAdd"), t("streamingHintOrders"))
            : metricCard(t("metricAdverseAdd"), fmt.formatPct(orders.adverseAddRate * 100), `${orders.adverseAdds}/${orders.openOrders}`),
          metricCard(t("metricFloatingLoss"), fmt.formatMoney(live.openUnrealizedLoss), t("marginPct", [(live.openUnrealizedLossToMargin * 100).toFixed(1)])),
          isStreaming && !raw.endpointResults?.transferHistory?.ok
            ? metricLoadingCard(t("metricLossPeriodDeposit"), t("streamingHintTransfers"))
            : metricCard(
              t("metricLossPeriodDeposit"),
              t("lossPeriodDepositCount", [transfers.lossPeriodDepositCount]),
              transfers.lossPeriodDepositCount > 0
                ? t("lossPeriodDepositHint", [fmt.formatMoney(transfers.lossPeriodDepositTotal), fmt.formatDateTime(transfers.lastLossPeriodDepositAt)])
                : t("lossPeriodDepositNone"),
              transfers.lossPeriodDepositCount > 0 ? "is-danger" : ""
            ),
          metricCard(t("metricRestartCount"), String(meta.closeLeadCount || 0), t("portfolioRestart")),
          isStreaming && !orders.openOrders
            ? metricLoadingCard(t("metricBiggestBet"), t("streamingHintEquity"))
            : (analysis.biggestBet
              ? metricCard(
                t("metricBiggestBet"),
                t("biggestBetValue", [analysis.biggestBet.leverage.toFixed(1)]),
                t(analysis.biggestBet.boundByLeverage ? "biggestBetHintBound" : "biggestBetHint", [
                  t("biggestBetPosition", [analysis.biggestBet.symbol, t(analysis.biggestBet.side === "SHORT" ? "posShort" : "posLong")]),
                  fmt.formatDateTime(analysis.biggestBet.at),
                  analysis.biggestBet.wipeOutMovePct.toFixed(1)
                ])
              )
              : metricCard(t("metricBiggestBet"), "N/A"))
        ]),
        h("section", { class: "ctl-section" }, [
          h("h3", { text: t("sectionRisks") }),
          bullets(verdict.cautions, t("noMajorRisks"))
        ]),
        h("section", { class: "ctl-section" }, [
          h("h3", { text: t("sectionPositives") }),
          bullets(verdict.positives, t("noPositives"))
        ]),
        renderStopLossRadar(analysis.stopLossRadar),
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
          if (!superseded()) window.CopyTradingLensPositionsPanel?.setProgress(event);
        },
        onProgressive: (event) => {
          if (superseded()) return;
          try {
            const partialAnalysis = context.platform === "Binance"
              ? window.CopyTradingLensAnalysis.analyzeBinance(event.raw)
              : window.CopyTradingLensAnalysis.analyzeOkx(event.raw);
            run = {
              ...current,
              phase: "streaming",
              streamingStage: event.stage,
              raw: event.raw,
              analysis: partialAnalysis
            };
            paint();
          } catch (_e) {}
        }
      });
      if (superseded()) return;
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

  function scheduleRouteCheck() {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => runAnalysis(false), 350);
  }

  // Tell the service worker a content script just loaded. In an unpacked build
  // that is what triggers the stale-build check (see src/background.js); in a
  // packed build nothing listens and the message is a no-op.
  try {
    chrome.runtime?.sendMessage?.({ type: "ctl:content-loaded" });
  } catch (_error) {
    // Extension context can be invalidated mid-reload; nothing to recover.
  }

  window.addEventListener("popstate", scheduleRouteCheck);
  setInterval(scheduleRouteCheck, 1500);
  runAnalysis(false);
})();
