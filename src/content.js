(function initCopyTradingLens() {
  "use strict";

  const ROOT_ID = "copy-trading-lens-root";
  let currentKey = "";
  let collapsed = false;
  let root = null;
  let routeTimer = null;

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
        title: "Open Copy Trading Lens",
        onclick: () => {
          collapsed = false;
          runAnalysis(true);
        }
      }, [
        h("span", { text: "Lens" }),
        h("strong", { text: context.platform })
      ])
    );
  }

  function statusText(endpointResults) {
    const entries = Object.values(endpointResults || {});
    const ok = entries.filter((item) => item?.ok).length;
    const total = entries.length;
    if (!total) return "尚未取得資料";
    return `${ok}/${total} endpoints 可用`;
  }

  function endpointLabel(label) {
    const labels = {
      detail: "基本資料",
      livePositions: "目前持倉",
      positionHistory: "倉位歷史",
      orderHistory: "訂單歷史",
      transferHistory: "轉帳歷史",
      candidate: "排行/profile",
      "performance:7D": "7D績效",
      "performance:30D": "30D績效",
      "performance:90D": "90D績效",
      "performance:180D": "180D績效",
      "performance:365D": "365D績效"
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

  function metricCard(label, value, hint = "") {
    return h("div", { class: "ctl-metric" }, [
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
    if (!ordered.length) return h("p", { class: "ctl-muted", text: "沒有抓到交易所標準時間窗資料。" });
    return h("table", { class: "ctl-table" }, [
      h("thead", {}, h("tr", {}, [
        h("th", { text: "時間窗" }),
        h("th", { text: "ROI" }),
        h("th", { text: "MDD" }),
        h("th", { text: "來源" })
      ])),
      h("tbody", {}, ordered.map((range) => {
        const metric = windows[range] || {};
        return h("tr", {}, [
          h("td", { text: range }),
          h("td", { text: fmt.formatPct(metric.roi) }),
          h("td", { text: fmt.formatPct(metric.mdd) }),
          h("td", { text: metric.lookupSource || "API" })
        ]);
      }))
    ]);
  }

  function historyCompleteness(raw) {
    const status = raw.historyStatus || {};
    const items = [
      ["倉位歷史", status.positionHistory],
      ["訂單歷史", status.orderHistory],
      ["轉帳歷史", status.transferHistory]
    ];
    return items.map(([label, item]) => {
      if (!item) return `${label}: N/A`;
      if (item.error) return `${label}: 失敗`;
      if (!item.total && !item.fetched) return `${label}: 無資料`;
      const retries = item.retryCount ? `，重試 ${item.retryCount} 次` : "";
      const state = item.complete ? "完整" : "未完整";
      return `${label}: ${item.fetched || 0}/${item.total || 0} ${state}${retries}`;
    }).join("；");
  }

  function settingAdvice(analysis) {
    const cautions = [];
    if (analysis.live.openUnrealizedLoss > 0) {
      cautions.push("不要複製現有持倉；等下一筆新開倉再跟。");
    }
    if (analysis.orders.adverseAddRate >= 0.35 || analysis.summary.payoffRatio < 0.5) {
      cautions.push("若仍要測試，只用小比例定比跟單，並設定總帳戶止損。");
    }
    if (analysis.meta.mdd >= 30) {
      cautions.push("最大回撤偏高，單一帶單員配置不宜過大。");
    }
    if (!cautions.length) {
      cautions.push("仍建議定比跟單、不要複製現有倉位，並設定總帳戶止損。");
    }
    return cautions;
  }

  function renderLoading(context) {
    ensureRoot().replaceChildren(
      h("section", { class: "ctl-panel" }, [
        h("header", { class: "ctl-header" }, [
          h("div", {}, [
            h("span", { class: "ctl-eyebrow", text: "Copy Trading Lens" }),
            h("h2", { text: `${context.platform} 帶單員分析中` })
          ]),
          h("button", { class: "ctl-icon-btn", title: "Collapse", onclick: () => {
            collapsed = true;
            renderLauncher(context);
          } }, "−")
        ]),
        h("div", { class: "ctl-loading" }, [
          h("div", { class: "ctl-spinner" }),
          h("p", { text: "正在抓取目前頁面的公開/登入可見資料並在本機分析..." })
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
            h("h2", { text: "分析失敗" })
          ]),
          h("button", { class: "ctl-icon-btn", title: "Collapse", onclick: () => {
            collapsed = true;
            renderLauncher(context);
          } }, "−")
        ]),
        h("p", { class: "ctl-error", text: error instanceof Error ? error.message : String(error) }),
        h("button", { class: "ctl-primary", onclick: () => runAnalysis(true) }, "重新分析")
      ])
    );
  }

  function verdictClass(level) {
    if (level === "avoid") return "is-avoid";
    if (level === "risky") return "is-risky";
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

    ensureRoot().replaceChildren(
      h("section", { class: "ctl-panel" }, [
        h("header", { class: "ctl-header" }, [
          h("div", {}, [
            h("span", { class: "ctl-eyebrow", text: `${context.platform} / ${meta.id}` }),
            h("h2", { text: meta.name })
          ]),
          h("div", { class: "ctl-actions" }, [
            h("button", { class: "ctl-icon-btn", title: "Refresh analysis", onclick: () => runAnalysis(true) }, "↻"),
            h("button", { class: "ctl-icon-btn", title: "Collapse", onclick: () => {
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
          metricCard("全期間 ROI", fmt.formatPct(meta.roi), meta.performanceSource || "歷史/API"),
          metricCard("MDD", fmt.formatPct(meta.mdd), meta.primaryWindow ? "交易所時間窗最大值" : (meta.performanceQuality || "資料品質")),
          metricCard("全期間 PnL", fmt.formatMoney(meta.pnl), "目前資金 + 提領 - 投入"),
          metricCard("交易天數", meta.days ? `${meta.days.toFixed(0)} 天` : "N/A"),
          metricCard("跟單 PnL/AUM", meta.aum ? `${(meta.copierPnl / meta.aum * 100).toFixed(1)}%` : "N/A"),
          metricCard("勝率", fmt.formatPct(summary.winRate * 100), `${summary.closedTrades} 筆已平倉`),
          metricCard("盈虧比", summary.payoffRatio === null ? "N/A" : summary.payoffRatio.toFixed(2)),
          metricCard("虧損持倉", fmt.formatHours(summary.avgLossHoldHours), `最長 ${fmt.formatHours(summary.maxLossHoldHours)}`),
          metricCard("逆勢加倉", fmt.formatPct(orders.adverseAddRate * 100), `${orders.adverseAdds}/${orders.openOrders}`),
          metricCard("目前浮虧", fmt.formatMoney(live.openUnrealizedLoss), `${(live.openUnrealizedLossToMargin * 100).toFixed(1)}% margin`),
          metricCard("歷史關閉", String(meta.closeLeadCount || 0), "portfolio restart")
        ]),
        h("section", { class: "ctl-section" }, [
          h("h3", { text: "主要風險" }),
          bullets(verdict.cautions, "目前未觸發主要風險規則，但仍不代表安全或保證獲利。")
        ]),
        h("section", { class: "ctl-section" }, [
          h("h3", { text: "正向訊號" }),
          bullets(verdict.positives, "目前正向訊號不足，建議先觀察更多樣本。")
        ]),
        h("section", { class: "ctl-section" }, [
          h("h3", { text: "建議設定" }),
          bullets(settingAdvice(analysis), "")
        ]),
        h("details", { class: "ctl-details" }, [
          h("summary", { text: `進階資料：${statusText(raw.endpointResults)}` }),
          h("h3", { text: "時間窗交叉檢查" }),
          performanceWindowTable(meta, fmt),
          h("p", { class: "ctl-muted ctl-small-note", text: `歷史資料：${historyCompleteness(raw)}` }),
          endpointList(raw.endpointResults),
          h("pre", { text: JSON.stringify(analysis.rawCounts, null, 2) })
        ]),
        h("p", { class: "ctl-disclaimer", text: "此分析只使用目前瀏覽器可取得資料並在本機計算，不是投資建議，也不保證收益或安全。" })
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
