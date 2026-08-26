(function attachPositionsPanel(global) {
  "use strict";

  // Renders the reconstructed open book (src/positions.js) directly over
  // Binance's "this lead trader has set their current positions to private"
  // empty state, inside the page's own Positions tab — the place a reader
  // already looks for this information.
  //
  // Takeover rules, in order of importance:
  //   1. Nothing is deleted. The original notice is hidden, never removed, and
  //      a control puts it back. A DOM the extension mutilated is a DOM the
  //      user cannot get back without a reload.
  //   2. The anchor is found by meaning, not by class name. Binance ships
  //      hashed CSS classes that change on every deploy; the notice's own text
  //      is the only stable handle, so it is matched across the locales the
  //      exchange serves.
  //   3. Every number says where it came from. A reconstructed size carries a
  //      confidence, an inferred leverage says it was inferred, and an
  //      unpriced symbol renders as unavailable rather than as zero.

  const PANEL_ID = "ctl-positions-panel";
  const HIDDEN_ATTR = "data-ctl-hidden-notice";

  // How often the mark prices are re-read while the panel is on screen. This is
  // a display-freshness choice, not a measured threshold — it changes nothing the
  // reconstruction decides, only how stale the PnL on screen can be. The panel
  // always prints the timestamp of the prices it used, so the staleness is
  // visible rather than assumed, and the refresh button forces a read.
  const MARK_REFRESH_MS = 3000;

  const PRIVATE_TOKEN = /私人|私密|不公開|不公开|非公開|非公开|\bprivate\b/i;
  const POSITION_TOKEN = /倉位|仓位|持倉|持仓|ポジション|positions?/i;
  const NOTICE_MIN_CHARS = 12;
  const NOTICE_MAX_CHARS = 400;

  let state = null;
  let observer = null;
  let refreshTimer = null;
  let scanTimer = null;

  function t(key, substitutions = []) {
    return global.CopyTradingLensI18n?.t(key, substitutions) || key;
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
      if (child === null || child === undefined || child === false) continue;
      el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return el;
  }

  function ownText(element) {
    return (element.textContent || "").trim();
  }

  /**
   * The private-positions notice, found by what it says rather than by how it
   * is styled. The deepest element that carries the whole sentence wins, so a
   * page wrapper that happens to contain the notice is never mistaken for it.
   */
  function findPrivateNotice() {
    const candidates = [];
    for (const element of document.querySelectorAll("div,p,span,section,article")) {
      if (element.closest(`#${PANEL_ID}`) || element.id === "copy-trading-lens-root") continue;
      const text = ownText(element);
      if (text.length < NOTICE_MIN_CHARS || text.length > NOTICE_MAX_CHARS) continue;
      if (!PRIVATE_TOKEN.test(text) || !POSITION_TOKEN.test(text)) continue;
      candidates.push({ element, length: text.length });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.length - b.length);
    return candidates[0].element;
  }

  /**
   * Grow the notice into the whole empty-state block it belongs to: keep
   * climbing while the parent adds no text of its own (it only adds the
   * illustration and padding around the same sentence). Stops as soon as a
   * parent contributes other content, so the tab bar and sibling panels are
   * never swallowed.
   */
  function emptyStateBlockOf(notice) {
    let block = notice;
    const baseline = ownText(notice).length;
    while (block.parentElement && block.parentElement !== document.body) {
      const parentText = ownText(block.parentElement).length;
      if (parentText > baseline) break;
      block = block.parentElement;
    }
    return block;
  }

  function formatMoney(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    if (abs === 0) return "$0";
    const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
    return `${value < 0 ? "-" : ""}$${abs.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }

  function formatSignedMoney(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    return `${value > 0 ? "+" : ""}${formatMoney(value)}`;
  }

  function formatRatio(value, digits = 1) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    return `${value > 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
  }

  function formatPlainRatio(value, digits = 1) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    return `${(value * 100).toFixed(digits)}%`;
  }

  function formatQty(value) {
    if (!Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    const digits = abs >= 1000 ? 0 : abs >= 1 ? 2 : 6;
    return value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits });
  }

  function formatPrice(value) {
    if (!Number.isFinite(value) || value === 0) return "—";
    const abs = Math.abs(value);
    const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: digits });
  }

  function formatClock(ms) {
    if (!ms) return "—";
    return new Date(ms).toLocaleString();
  }

  function formatAge(hours) {
    if (!Number.isFinite(hours)) return "—";
    if (hours < 1) return t("posAgeMinutes", [Math.max(1, Math.round(hours * 60))]);
    if (hours < 48) return t("posAgeHours", [hours.toFixed(1)]);
    return t("posAgeDays", [(hours / 24).toFixed(1)]);
  }

  function pnlClass(value) {
    if (!Number.isFinite(value) || value === 0) return "";
    return value > 0 ? "is-up" : "is-down";
  }

  function confidenceBadge(position) {
    if (position.confidence === "exact") {
      return h("span", { class: "ctl-pos-badge is-exact", text: t("posConfidenceExact"), title: t("posConfidenceExactHint") });
    }
    if (position.confidence === "reconciled") {
      return h("span", {
        class: "ctl-pos-badge is-partial",
        text: t("posConfidenceReconciled"),
        title: t("posConfidenceReconciledHint", [formatQty(position.reconciliation?.missingOpenVolume || 0)])
      });
    }
    if (position.confidence === "partialFills") {
      return h("span", { class: "ctl-pos-badge is-partial", text: t("posConfidencePartial"), title: t("posConfidencePartialHint") });
    }
    return h("span", { class: "ctl-pos-badge is-estimated", text: t("posConfidenceEstimated"), title: t("posConfidenceEstimatedHint") });
  }

  function summaryStrip(summary, marginBalance) {
    const cells = [
      [t("posSummaryOpenCount"), String(summary.openCount), ""],
      [t("posSummaryGrossNotional"), formatMoney(summary.grossNotional), marginBalance ? t("posSummaryGrossLeverage", [summary.grossLeverage === null ? "—" : `${summary.grossLeverage.toFixed(2)}x`]) : ""],
      [t("posSummaryUnrealized"), formatSignedMoney(summary.unrealizedPnl), formatRatio(summary.unrealizedToMarginBalance), pnlClass(summary.unrealizedPnl)],
      [t("posSummaryMarginUsed"), formatMoney(summary.marginUsed), formatPlainRatio(summary.marginUsedToBalance)],
      [t("posSummaryDirection"), t("posSummaryLongShort", [formatMoney(summary.longNotional), formatMoney(summary.shortNotional)]), summary.netNotional >= 0 ? t("posSummaryNetLong", [formatMoney(Math.abs(summary.netNotional))]) : t("posSummaryNetShort", [formatMoney(Math.abs(summary.netNotional))])],
      [t("posSummaryConcentration"), formatPlainRatio(summary.concentration), t("posSummaryConcentrationHint")]
    ];
    return h("div", { class: "ctl-pos-summary" }, cells.map(([label, value, hint, accent]) =>
      h("div", { class: `ctl-pos-summary-cell${accent ? ` ${accent}` : ""}` }, [
        h("span", { class: "ctl-pos-summary-label", text: label }),
        h("strong", { class: "ctl-pos-summary-value", text: value }),
        hint ? h("small", { class: "ctl-pos-summary-hint", text: hint }) : null
      ])
    ));
  }

  function fillLadder(position) {
    if (!position.events.length) {
      return h("p", { class: "ctl-pos-muted", text: t("posNoLadder") });
    }
    return h("table", { class: "ctl-pos-ladder" }, [
      h("thead", {}, h("tr", {}, [
        h("th", { text: t("posLadderTime") }),
        h("th", { text: t("posLadderAction") }),
        h("th", { text: t("posLadderQty") }),
        h("th", { text: t("posLadderPrice") }),
        h("th", { text: t("posLadderPnl") })
      ])),
      h("tbody", {}, position.events.slice().reverse().map((event) =>
        h("tr", { class: event.kind === "open" ? "is-open-fill" : "is-close-fill" }, [
          h("td", { text: formatClock(event.time) }),
          h("td", { text: event.kind === "open" ? t("posLadderOpenFill") : t("posLadderCloseFill") }),
          h("td", { text: formatQty(event.qty) }),
          h("td", { text: formatPrice(event.price) }),
          h("td", { class: pnlClass(event.pnl), text: event.kind === "open" ? "—" : formatSignedMoney(event.pnl) })
        ])
      ))
    ]);
  }

  function positionRow(position) {
    const directionClass = position.side === "LONG" ? "is-long" : "is-short";
    const detailsId = `ctl-pos-detail-${position.symbol}-${position.side}`.replace(/\s+/g, "-");
    return h("details", { class: "ctl-pos-row", id: detailsId }, [
      h("summary", { class: "ctl-pos-row-head" }, [
        h("span", { class: `ctl-pos-symbol ${directionClass}` }, [
          h("strong", { text: position.symbol }),
          h("em", { text: position.side === "LONG" ? t("posLong") : t("posShort") }),
          h("span", {
            class: "ctl-pos-leverage",
            text: position.leverage ? `${position.leverage}x` : t("posLeverageUnknown"),
            title: position.leverageSource === "inferredFromSameSymbol"
              ? t("posLeverageInferredHint")
              : position.leverageSource === "unknown" ? t("posLeverageUnknownHint") : t("posLeverageReadHint")
          }),
          position.leverageSource === "inferredFromSameSymbol"
            ? h("span", { class: "ctl-pos-badge is-inferred", text: t("posLeverageInferred") })
            : null
        ]),
        h("span", { class: "ctl-pos-cell" }, [
          h("small", { text: t("posColQty") }),
          h("span", { text: formatQty(position.qty) })
        ]),
        h("span", { class: "ctl-pos-cell" }, [
          h("small", { text: t("posColNotional") }),
          h("span", { text: formatMoney(position.notional) })
        ]),
        h("span", { class: "ctl-pos-cell" }, [
          h("small", { text: t("posColEntry") }),
          h("span", { text: formatPrice(position.entryPrice) })
        ]),
        h("span", { class: "ctl-pos-cell" }, [
          h("small", { text: t("posColMark") }),
          h("span", { text: formatPrice(position.markPrice) })
        ]),
        h("span", { class: `ctl-pos-cell ${pnlClass(position.unrealizedPnl)}` }, [
          h("small", { text: t("posColUnrealized") }),
          h("span", { text: formatSignedMoney(position.unrealizedPnl) })
        ]),
        h("span", { class: `ctl-pos-cell ${pnlClass(position.roi)}` }, [
          h("small", { text: t("posColRoi") }),
          h("span", { text: formatRatio(position.roi) })
        ]),
        h("span", { class: `ctl-pos-cell ${pnlClass(position.pnlPercentOnNotional)}` }, [
          h("small", { text: t("posColPriceMove") }),
          h("span", { text: formatRatio(position.pnlPercentOnNotional, 2) })
        ]),
        h("span", { class: "ctl-pos-cell" }, [
          h("small", { text: t("posColAge") }),
          h("span", { text: formatAge(position.ageHours) })
        ]),
        confidenceBadge(position)
      ]),
      h("div", { class: "ctl-pos-row-body" }, [
        h("div", { class: "ctl-pos-facts" }, [
          fact(t("posFactOpened"), formatClock(position.openedAt)),
          fact(t("posFactLastFill"), formatClock(position.lastFillAt)),
          fact(t("posFactPriceMove"), formatRatio(position.pnlPercentOnNotional, 2)),
          fact(t("posFactInitialMargin"), formatMoney(position.initialMargin)),
          fact(t("posFactPeakQty"), formatQty(position.peakQty)),
          fact(
            t("posFactClosedSoFar"),
            position.partiallyClosed
              ? t("posFactClosedValue", [formatQty(position.closedQty), formatPlainRatio(position.closedRatio)])
              : t("posFactNotClosed")
          ),
          fact(t("posFactRealized"), formatSignedMoney(position.realizedPnl)),
          fact(t("posFactAdds"), t("posFactAddsValue", [position.addCount, position.reduceCount])),
          fact(t("posFactMarginMode"), position.marginMode || "—"),
          fact(t("posFactExchangeStatus"), position.exchangeStatus || "—"),
          fact(t("posFactNotionalShare"), formatPlainRatio(position.notionalToMarginBalance))
        ]),
        h("h4", { class: "ctl-pos-subtitle", text: t("posLadderTitle") }),
        fillLadder(position)
      ])
    ]);
  }

  function fact(label, value) {
    return h("div", { class: "ctl-pos-fact" }, [
      h("span", { text: label }),
      h("strong", { text: value })
    ]);
  }

  function coverageNotes(coverage, marks) {
    const notes = [];
    if (!coverage.orderHistoryComplete) {
      notes.push(t("posNoteOrderDepthLimited", [coverage.orderHistoryFetched, coverage.orderHistoryTotal]));
    }
    if (!coverage.positionHistoryComplete) {
      notes.push(t("posNotePositionDepthLimited"));
    }
    if (coverage.estimatedCount > 0) {
      notes.push(t("posNoteEstimatedRows", [coverage.estimatedCount]));
    }
    if (coverage.reconciledCount > 0) {
      notes.push(t("posNoteReconciledRows", [coverage.reconciledCount]));
    }
    if (marks.missing.length) {
      notes.push(t("posNoteMissingMarks", [marks.missing.join(", ")]));
    }
    notes.push(t("posNoteNotDerivable"));
    return notes;
  }

  function renderPanel() {
    const { positions, coverage, marks, summary, marginBalance, nickname } = state.view;
    return h("section", { id: PANEL_ID, class: `ctl-pos-panel ${state.theme}` }, [
      h("header", { class: "ctl-pos-header" }, [
        h("div", { class: "ctl-pos-title" }, [
          h("span", { class: "ctl-pos-eyebrow", text: t("posEyebrow") }),
          h("h3", { text: t("posTitle", [nickname || t("posThisTrader")]) }),
          h("p", { class: "ctl-pos-subtitle-note", text: t("posSubtitle") })
        ]),
        h("div", { class: "ctl-pos-actions" }, [
          h("span", { class: "ctl-pos-stamp", text: t("posMarkStamp", [formatClock(marks.fetchedAtMs)]) }),
          h("button", { class: "ctl-pos-btn", type: "button", onclick: () => refreshMarks(true) }, t("posRefresh")),
          h("button", { class: "ctl-pos-btn is-ghost", type: "button", onclick: restoreOriginal }, t("posRestoreOriginal"))
        ])
      ]),
      positions.length
        ? h("div", {}, [
          summaryStrip(summary, marginBalance),
          h("div", { class: "ctl-pos-rows" }, positions.map(positionRow))
        ])
        : h("p", { class: "ctl-pos-empty", text: t("posEmpty") }),
      h("ul", { class: "ctl-pos-notes" }, coverageNotes(coverage, marks).map((note) => h("li", { text: note }))),
      h("p", { class: "ctl-pos-disclaimer", text: t("posDisclaimer") })
    ]);
  }

  function paint() {
    if (!state || !state.block || !state.block.isConnected) return false;
    const existing = document.getElementById(PANEL_ID);
    // The mark-price refresh repaints the whole panel every few seconds. Without
    // this, a reader who opened a position's fill ladder would watch it snap shut
    // on the next tick, which makes the detail effectively unreadable.
    const expanded = existing
      ? new Set([...existing.querySelectorAll("details[open]")].map((row) => row.id))
      : new Set();
    const panel = renderPanel();
    for (const id of expanded) {
      const row = panel.querySelector(`#${CSS.escape(id)}`);
      if (row) row.open = true;
    }
    if (existing) existing.replaceWith(panel);
    else state.block.insertAdjacentElement("afterend", panel);
    state.block.setAttribute(HIDDEN_ATTR, "1");
    state.block.style.display = "none";
    return true;
  }

  function restoreOriginal() {
    stopRefresh();
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
    if (state?.block) {
      state.block.style.display = state.originalDisplay || "";
      state.block.removeAttribute(HIDDEN_ATTR);
    }
    state = null;
  }

  /**
   * Pick a light or dark palette from the colour actually behind the insertion
   * point. Binance ships its own theme switch, so asking the DOM what it looks
   * like beats guessing from a media query the exchange does not follow.
   */
  function detectTheme(anchor) {
    let node = anchor;
    while (node && node !== document.documentElement) {
      const background = getComputedStyle(node).backgroundColor;
      const match = /rgba?\(([^)]+)\)/.exec(background || "");
      if (match) {
        const parts = match[1].split(",").map((value) => Number(value.trim()));
        const alpha = parts.length > 3 ? parts[3] : 1;
        if (alpha > 0.1) {
          const luminance = (0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]) / 255;
          return luminance < 0.5 ? "is-dark" : "is-light";
        }
      }
      node = node.parentElement;
    }
    return "is-dark";
  }

  async function refreshMarks(force = false) {
    if (!state) return;
    if (document.hidden && !force) return;
    const symbols = state.positions.map((position) => position.symbol);
    if (!symbols.length) return;
    try {
      const marks = await global.CopyTradingLensProviders.fetchBinanceMarkPrices(symbols);
      state.view.marks = marks;
      state.view.positions = global.CopyTradingLensPositions.enrichWithMarks(state.positions, marks.marks, {
        nowMs: Date.now(),
        marginBalance: state.view.marginBalance
      });
      state.view.summary = global.CopyTradingLensPositions.summarizePortfolio(state.view.positions, state.view.marginBalance);
      paint();
    } catch (_error) {
      // A failed mark refresh leaves the previous, timestamped prices on
      // screen; the stamp is what tells the reader how old they are.
    }
  }

  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(() => refreshMarks(false), MARK_REFRESH_MS);
  }

  function stopRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function scan() {
    if (!state) return;
    if (state.block && state.block.isConnected && document.getElementById(PANEL_ID)) return;
    const notice = findPrivateNotice();
    if (!notice) {
      // The reader navigated away from the Positions tab; drop our panel with
      // it instead of leaving it stranded under another tab's content.
      const orphan = document.getElementById(PANEL_ID);
      if (orphan) orphan.remove();
      state.block = null;
      return;
    }
    const block = emptyStateBlockOf(notice);
    state.block = block;
    state.originalDisplay = block.style.display;
    state.theme = detectTheme(block.parentElement || block);
    paint();
  }

  function observe() {
    if (observer) return;
    observer = new MutationObserver(() => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scan, 250);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /**
   * @param {{platform: string, id: string}} context
   * @param {object} raw  provider payload already fetched for the overlay —
   *   the panel deliberately does not re-fetch it, so the page pays for the
   *   trader's full history exactly once.
   */
  async function mount(context, raw) {
    if (context.platform !== "Binance") return;
    const { positions, coverage } = global.CopyTradingLensPositions.reconstructBinanceOpenPositions(raw);
    const marginBalance = Number(raw.detail?.marginBalance || 0);
    const marks = await global.CopyTradingLensProviders.fetchBinanceMarkPrices(positions.map((p) => p.symbol));
    const priced = global.CopyTradingLensPositions.enrichWithMarks(positions, marks.marks, {
      nowMs: Date.now(),
      marginBalance
    });

    state = {
      context,
      positions,
      block: null,
      originalDisplay: "",
      theme: "is-dark",
      view: {
        positions: priced,
        coverage,
        marks,
        marginBalance,
        nickname: raw.detail?.nickname || "",
        summary: global.CopyTradingLensPositions.summarizePortfolio(priced, marginBalance)
      }
    };

    scan();
    observe();
    startRefresh();
  }

  function unmount() {
    stopRefresh();
    if (observer) observer.disconnect();
    observer = null;
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
    if (state?.block) {
      state.block.style.display = state.originalDisplay || "";
      state.block.removeAttribute(HIDDEN_ATTR);
    }
    state = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshMarks(false);
  });

  global.CopyTradingLensPositionsPanel = { mount, unmount, findPrivateNotice, emptyStateBlockOf };
})(window);
