(function attachAnalysis(global) {
  "use strict";

  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  function t(key, substitutions = []) {
    return global.CopyTradingLensI18n?.t(key, substitutions) || key;
  }

  function num(value, fallback = 0) {
    if (value === null || value === undefined || value === "") return fallback;
    const parsed = Number(String(value).replace(/,/g, "").replace("%", ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function int(value, fallback = 0) {
    const parsed = Math.trunc(num(value, fallback));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function safeDivide(numerator, denominator, fallback = 0) {
    return Math.abs(denominator) > 1e-9 ? numerator / denominator : fallback;
  }

  function median(values) {
    const cleaned = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!cleaned.length) return 0;
    const mid = Math.floor(cleaned.length / 2);
    return cleaned.length % 2 ? cleaned[mid] : (cleaned[mid - 1] + cleaned[mid]) / 2;
  }

  function percentile(values, p) {
    const cleaned = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!cleaned.length) return 0;
    const idx = Math.min(cleaned.length - 1, Math.max(0, Math.ceil((p / 100) * cleaned.length) - 1));
    return cleaned[idx];
  }

  function firstDefined(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  }

  function formatPct(value, digits = 1) {
    if (!Number.isFinite(value)) return "N/A";
    return `${value.toFixed(digits)}%`;
  }

  function formatMoney(value, digits = 0) {
    if (!Number.isFinite(value)) return "N/A";
    return `${value.toLocaleString(undefined, { maximumFractionDigits: digits })} USDT`;
  }

  // An instant in the reader's own clock and locale.
  function formatDateTime(ms) {
    if (!ms) return "N/A";
    return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }

  function formatHours(hours) {
    if (!Number.isFinite(hours) || hours <= 0) return "0h";
    if (hours >= 24) return `${(hours / 24).toFixed(1)}d`;
    return `${hours.toFixed(1)}h`;
  }

  function parseVisibleMetrics(text) {
    const normalized = (text || "").replace(/\s+/g, " ");
    const pickNear = (label, suffix = "") => {
      const pattern = new RegExp(`${label}\\s*([+\\-]?[0-9,.]+)\\s*${suffix}`);
      const match = normalized.match(pattern);
      return match ? num(match[1], null) : null;
    };
    return {
      roi: pickNear("收益率", "%"),
      pnl: pickNear("盈虧"),
      copierPnl: pickNear("跟單者盈虧"),
      sharpe: pickNear("夏普比率"),
      mdd: pickNear("最大交易回撤", "%"),
      winRate: pickNear("勝率", "%"),
      winningPositions: pickNear("獲勝倉位"),
      totalPositions: pickNear("總倉位"),
      tradingDays: pickNear("交易天數"),
      closeLeadCount: pickNear("歷史關閉項目")
    };
  }

  function annualizedFromRoi(roiPercent, days) {
    if (!Number.isFinite(roiPercent) || !Number.isFinite(days) || days <= 0) return null;
    const growth = 1 + roiPercent / 100;
    if (growth <= 0) return -100;
    const annualized = (growth ** (365 / days) - 1) * 100;
    return Number.isFinite(annualized) ? annualized : null;
  }

  function xirrAnnualized(cashFlows) {
    const flows = (cashFlows || [])
      .filter((flow) => Number.isFinite(flow.ts) && Number.isFinite(flow.amount) && Math.abs(flow.amount) > 1e-9)
      .sort((a, b) => a.ts - b.ts);
    if (flows.length < 2) return null;
    if (!flows.some((flow) => flow.amount < 0) || !flows.some((flow) => flow.amount > 0)) return null;
    const start = flows[0].ts;
    const npv = (rate) => flows.reduce((sum, flow) => {
      const years = Math.max(0, (flow.ts - start) / (365 * DAY_MS));
      return sum + flow.amount / ((1 + rate) ** years);
    }, 0);

    let low = -0.999999;
    let high = 10;
    let lowValue = npv(low);
    let highValue = npv(high);
    for (let i = 0; i < 24 && lowValue * highValue > 0; i += 1) {
      high *= 2;
      highValue = npv(high);
      if (!Number.isFinite(highValue)) break;
    }
    if (!Number.isFinite(lowValue) || !Number.isFinite(highValue) || lowValue * highValue > 0) return null;

    for (let i = 0; i < 100; i += 1) {
      const mid = (low + high) / 2;
      const value = npv(mid);
      if (!Number.isFinite(value)) return null;
      if (Math.abs(value) < 1e-7) return mid * 100;
      if (lowValue * value <= 0) {
        high = mid;
        highValue = value;
      } else {
        low = mid;
        lowValue = value;
      }
    }
    return ((low + high) / 2) * 100;
  }

  function normalizeWindowMetric(row) {
    if (!row || typeof row !== "object") return null;
    const roi = num(row.roi, null);
    const mdd = num(row.mdd, null);
    const days = timeRangeDays(row.timeRange || "");
    return {
      timeRange: row.timeRange || "",
      roi,
      annualizedReturn: annualizedFromRoi(roi, days),
      mdd,
      pnl: num(row.pnl, null),
      startTime: num(row.startTime, null),
      chartPoints: Array.isArray(row.chartItems) ? row.chartItems.length : 0,
      lookupSource: row.lookupSource || "",
      searchedPages: row.searchedPages || 0
    };
  }

  function extractPerformanceWindows(raw) {
    const windows = {};
    for (const [timeRange, row] of Object.entries(raw.performanceWindows || {})) {
      const metric = normalizeWindowMetric({ ...row, timeRange });
      if (metric) windows[timeRange] = metric;
    }
    return windows;
  }

  function timeRangeDays(timeRange) {
    const match = String(timeRange || "").match(/^(\d+)D$/);
    return match ? Number(match[1]) : 0;
  }

  function pickLongestWindow(windows, days) {
    const ordered = Object.keys(windows)
      .map((timeRange) => ({ timeRange, days: timeRangeDays(timeRange) }))
      .filter((item) => item.days > 0)
      .sort((a, b) => b.days - a.days);
    const supported = ordered.find((item) => !days || item.days <= days + 0.5);
    return supported?.timeRange || ordered[0]?.timeRange || "";
  }

  function transferDirection(row) {
    const type = String(row.transType || row.type || "").toUpperCase();
    const from = String(row.from || "").toLowerCase();
    const to = String(row.to || "").toLowerCase();
    if (type.includes("WITHDRAW") || (from.includes("lead") && !to.includes("lead"))) return "out";
    if (type.includes("INVEST") || type.includes("DEPOSIT") || (!from.includes("lead") && to.includes("lead"))) return "in";
    return "";
  }

  function reconstructBinanceAllPeriodPerformance(raw, pageMetrics) {
    const detail = raw.detail || {};
    const positions = Array.isArray(raw.positionHistory) ? raw.positionHistory : [];
    const transfers = Array.isArray(raw.transferHistory) ? raw.transferHistory : [];
    const marginBalance = num(firstDefined(detail.marginBalance, detail.marginAsset), null);
    const historyStatus = raw.historyStatus || {};
    const events = [];
    const cashFlows = [];
    let grossDeposits = 0;
    let withdrawals = 0;
    let currentEquityFromEvents = 0;
    let firstEventTime = Infinity;
    let lastEventTime = 0;

    for (const transfer of transfers) {
      const ts = num(firstDefined(transfer.time, transfer.ts, transfer.cTime), 0);
      const amount = Math.abs(num(firstDefined(transfer.amount, transfer.amt), 0));
      if (!ts || !amount) continue;
      const direction = transferDirection(transfer);
      if (!direction) continue;
      firstEventTime = Math.min(firstEventTime, ts);
      lastEventTime = Math.max(lastEventTime, ts);
      events.push({ ts, kind: "transfer", direction, amount });
      if (direction === "in") {
        grossDeposits += amount;
        cashFlows.push({ ts, amount: -amount });
      }
      if (direction === "out") {
        withdrawals += amount;
        cashFlows.push({ ts, amount });
      }
    }

    let realizedPnl = 0;
    for (const position of positions) {
      const closed = num(firstDefined(position.closed, position.closeTime, position.updateTime), 0);
      const opened = num(firstDefined(position.opened, position.openTime, position.createTime), 0);
      const pnl = binancePositionPnl(position);
      if (opened) firstEventTime = Math.min(firstEventTime, opened);
      if (closed) {
        firstEventTime = Math.min(firstEventTime, closed);
        lastEventTime = Math.max(lastEventTime, closed);
        events.push({ ts: closed, kind: "pnl", amount: pnl });
      }
      realizedPnl += pnl;
    }

    events.sort((a, b) => a.ts - b.ts);
    let equity = 0;
    let cumulativeIn = 0;
    let cumulativeOut = 0;
    let peakReturn = null;
    let reconstructedMdd = 0;
    const curve = [];

    for (const event of events) {
      if (event.kind === "transfer") {
        if (event.direction === "in") {
          equity += event.amount;
          cumulativeIn += event.amount;
        } else {
          equity -= event.amount;
          cumulativeOut += event.amount;
        }
      } else if (event.kind === "pnl") {
        equity += event.amount;
      }
      currentEquityFromEvents = equity;
      if (cumulativeIn > 0) {
        const returnPct = (equity + cumulativeOut - cumulativeIn) / cumulativeIn * 100;
        if (peakReturn === null) peakReturn = returnPct;
        peakReturn = Math.max(peakReturn, returnPct);
        reconstructedMdd = Math.max(reconstructedMdd, peakReturn - returnPct);
        curve.push({ ts: event.ts, returnPct });
      }
    }

    const currentEquity = Number.isFinite(marginBalance) ? marginBalance : currentEquityFromEvents;
    if (cumulativeIn > 0 && Number.isFinite(currentEquity)) {
      if (currentEquity > 0) cashFlows.push({ ts: Date.now(), amount: currentEquity });
      const finalReturn = (currentEquity + cumulativeOut - cumulativeIn) / cumulativeIn * 100;
      if (peakReturn === null) peakReturn = finalReturn;
      peakReturn = Math.max(peakReturn, finalReturn);
      reconstructedMdd = Math.max(reconstructedMdd, peakReturn - finalReturn);
      curve.push({ ts: Date.now(), returnPct: finalReturn });
    }

    const netProfit = Number.isFinite(currentEquity)
      ? currentEquity + withdrawals - grossDeposits
      : null;
    const roi = grossDeposits > 0 && Number.isFinite(netProfit)
      ? netProfit / grossDeposits * 100
      : null;

    const detailStart = num(firstDefined(detail.startTime, pageMetrics.tradingDays ? Date.now() - pageMetrics.tradingDays * DAY_MS : 0), 0);
    const firstAt = Number.isFinite(firstEventTime) ? firstEventTime : detailStart;
    // Signed, not clamped to >=0: a NEGATIVE gap (events recorded before the
    // official portfolio start) means position/transfer history from a prior,
    // closed lead incarnation is bleeding into "current" stats — e.g. a
    // catastrophic loss two months before this portfolio's start date still
    // dragging down the reported payoff ratio. Clamping that to 0 (the old
    // behavior) made reliable=true pass for exactly this contaminated case.
    const startGapSignedDays = detailStart && firstAt ? (firstAt - detailStart) / DAY_MS : 0;
    const startGapDays = Math.abs(startGapSignedDays);
    const preStartHistoryDays = startGapSignedDays < 0 ? startGapDays : 0;
    const complete = Boolean(
      historyStatus.positionHistory?.complete
      && historyStatus.transferHistory?.complete
    );
    const reliable = Boolean(
      Number.isFinite(roi)
      && grossDeposits > 0
      && complete
      && (!detailStart || startGapDays <= 2)
    );
    const xirr = xirrAnnualized(cashFlows);
    const elapsedDays = firstAt ? Math.max(0, (Date.now() - firstAt) / DAY_MS) : null;
    const cagrFallback = annualizedFromRoi(roi, elapsedDays);
    const annualizedReturn = Number.isFinite(xirr) ? xirr : cagrFallback;

    return {
      roi,
      annualizedReturn,
      annualizedSource: Number.isFinite(xirr) ? t("annualizedSourceXirr") : (Number.isFinite(cagrFallback) ? t("annualizedSourceCagr") : ""),
      mdd: curve.length >= 2 ? reconstructedMdd : null,
      netProfit,
      realizedPnl,
      grossDeposits,
      withdrawals,
      currentEquity: Number.isFinite(currentEquity) ? currentEquity : null,
      currentEquityFromEvents,
      firstEventTime: firstAt || null,
      lastEventTime: lastEventTime || null,
      positionRows: positions.length,
      curvePoints: curve.length,
      cashFlowCount: cashFlows.length,
      complete,
      reliable,
      startGapDays,
      preStartHistoryDays,
      source: "cash-flow-reconstruction"
    };
  }

  function extractBinanceMeta(raw, pageMetrics) {
    const detail = raw.detail || {};
    const listItem = raw.listItem || {};
    const performanceWindows = extractPerformanceWindows(raw);
    const reconstructed = reconstructBinanceAllPeriodPerformance(raw, pageMetrics);
    const startTime = num(firstDefined(detail.startTime, listItem.startTime, reconstructed.firstEventTime), 0);
    const daysFromStart = startTime > 0 ? (Date.now() - startTime) / DAY_MS : 0;
    const days = num(firstDefined(detail.tradeDays, detail.runningDays, detail.leadDays, pageMetrics.tradingDays), daysFromStart);
    const primaryWindow = pickLongestWindow(performanceWindows, days);
    const primaryWindowMetric = primaryWindow ? performanceWindows[primaryWindow] : null;
    const worstWindowMdd = Object.values(performanceWindows)
      .map((metric) => metric.mdd)
      .filter((value) => Number.isFinite(value))
      .reduce((maxValue, value) => Math.max(maxValue, value), null);
    const roi = num(firstDefined(reconstructed.roi, primaryWindowMetric?.roi, detail.roi, detail.yieldRate, pageMetrics.roi), null);
    const annualizedReturn = num(
      firstDefined(
        reconstructed.annualizedReturn,
        primaryWindowMetric?.annualizedReturn,
        annualizedFromRoi(roi, days)
      ),
      null
    );
    const mdd = num(firstDefined(worstWindowMdd, reconstructed.mdd, detail.mdd, detail.maxDrawdown, pageMetrics.mdd), null);
    const performanceSource = Number.isFinite(reconstructed.roi)
      ? t("performanceSourceCashFlow")
      : (primaryWindow ? t("performanceSourceWindow", [primaryWindow]) : t("performanceSourceFallback"));
    const performanceQuality = reconstructed.reliable
      ? t("performanceQualityComplete")
      : (Number.isFinite(reconstructed.roi) ? t("performanceQualityReconstructed") : t("performanceQualityUnavailable"));
    return {
      name: String(firstDefined(detail.nickname, listItem.nickname, raw.pageTitle, "Unknown Binance Lead")),
      id: raw.id,
      exchange: "Binance",
      url: raw.url,
      days,
      roi,
      annualizedReturn,
      annualizedSource: reconstructed.annualizedSource || (primaryWindow ? `${primaryWindow} CAGR` : t("annualizedSourceCagr")),
      mdd,
      pnl: num(firstDefined(reconstructed.netProfit, listItem.pnl, detail.pnl, pageMetrics.pnl), null),
      copierPnl: num(firstDefined(detail.copierPnl, pageMetrics.copierPnl), 0),
      aum: num(firstDefined(detail.aumAmount, listItem.aum), 0),
      marginBalance: num(firstDefined(detail.marginBalance, detail.marginAsset), 0),
      currentCopyCount: int(firstDefined(detail.currentCopyCount, listItem.currentCopyCount), 0),
      maxCopyCount: int(firstDefined(detail.maxCopyCount, listItem.maxCopyCount), 0),
      totalCopyCount: int(firstDefined(detail.totalCopyCount, listItem.totalCopyCount), 0),
      mockCopyCount: int(detail.mockCopyCount, 0),
      closeLeadCount: int(firstDefined(detail.closeLeadCount, pageMetrics.closeLeadCount), 0),
      profitSharingRate: num(detail.profitSharingRate, 0),
      positionShow: detail.positionShow,
      lastTradeTime: num(detail.lastTradeTime, 0),
      portfolioType: String(detail.portfolioType || "").toUpperCase() === "PRIVATE" || (detail.privateLeadPortfolioId && detail.privateLeadPortfolioId === raw.id) ? "PRIVATE" : "PUBLIC",
      isPrivate: String(detail.portfolioType || "").toUpperCase() === "PRIVATE" || (detail.privateLeadPortfolioId && detail.privateLeadPortfolioId === raw.id),
      description: String(firstDefined(detail.description, detail.descTranslate, "")),
      pageMetrics,
      performanceSource,
      performanceQuality,
      primaryWindow,
      allPeriodPerformance: reconstructed,
      performanceWindows
    };
  }

  function binancePositionPnl(position) {
    return num(firstDefined(position.closingPnl, position.pnl, position.realizedProfit), 0);
  }

  function positionOpenedAt(position) {
    return num(firstDefined(position.opened, position.openTime, position.createTime), 0);
  }

  // Binance leaves `closed` null while a position is still open (status
  // "Partially Closed"); its updateTime is the latest partial close, not a
  // close. 0 means the position is still open.
  function positionClosedAt(position) {
    return num(position.closed, 0);
  }

  // Last moment the position is known to have been held: its close, or for a
  // still-open row the latest partial close.
  function positionHeldUntil(position) {
    return positionClosedAt(position) || num(position.updateTime, 0);
  }

  // roundStartMs clamps the holding clock to this lead portfolio's own start.
  // A position opened before the portfolio existed and closed inside it was
  // only "held" by a copier from the start date onward — charging them the
  // pre-portfolio months produces dead-loss readings longer than the
  // portfolio's entire lifetime (the tell that the caliber is wrong).
  //
  // The clock runs per unit held, not from the first entry to the last exit: a
  // position closed 98% in two minutes and left 0.1 of 6 contracts open for
  // eleven days was held for 4.6 hours on average, and a copier — whose
  // partial closes follow the lead's by percentage — held it the same way
  // (portfolio 5172137479216744961, CLUSDT, 2026-08-20, read as an 11.5-day
  // dead loss before). A row whose fills the order history does not hold keeps
  // the first-entry-to-last-exit clock, which is never shorter.
  function binanceHoldHours(position, roundStartMs = 0, episode = null) {
    const rawOpened = positionOpenedAt(position);
    const closed = positionHeldUntil(position);
    const opened = roundStartMs && rawOpened && rawOpened < roundStartMs ? roundStartMs : rawOpened;
    if (!opened || !closed || closed < opened) return 0;
    return episode ? unitHoldHours(episode, opened, closed) : (closed - opened) / HOUR_MS;
  }

  // Mean time each unit entered was held between `from` and `until`: the
  // integral of the open quantity over time, divided by the quantity entered.
  function unitHoldHours(episode, from, until) {
    let open = 0;
    let entered = 0;
    let unitMs = 0;
    let previous = from;
    for (const fill of episode.fills) {
      const t = Math.min(Math.max(fill.t, from), until);
      unitMs += open * (t - previous);
      previous = t;
      if (fill.entry) {
        open += fill.qty;
        entered += fill.qty;
      } else {
        open = Math.max(0, open - fill.qty);
      }
    }
    unitMs += open * (until - previous);
    return entered > 0 ? unitMs / entered / HOUR_MS : (until - from) / HOUR_MS;
  }

  // The replayed position (src/positions.js via src/style.js) behind a
  // position-history row: same symbol and side, overlapping it the longest.
  // Start times rarely differ by more than a fill's duration, but a row and its
  // replay are not guaranteed to share a millisecond, so the match is by overlap.
  function episodeIndex(episodes) {
    const index = new Map();
    for (const episode of episodes) {
      const key = `${episode.symbol}|${episode.direction}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(episode);
    }
    // Per book: episodes by start, with the running maximum of their ends, so
    // a lookup visits only the episodes that can overlap the row. A trader with
    // thousands of rows on one symbol made the plain scan quadratic.
    const books = new Map();
    for (const [key, list] of index) {
      const sorted = [...list].sort((a, b) => a.start - b.start);
      const maxEnd = [];
      sorted.forEach((episode, i) => maxEnd.push(Math.max(episode.end, i ? maxEnd[i - 1] : -Infinity)));
      books.set(key, { sorted, maxEnd });
    }
    return (row) => {
      const book = books.get(`${row.symbol}|${String(row.side || "").toUpperCase()}`);
      if (!book) return null;
      const from = positionOpenedAt(row);
      const until = positionHeldUntil(row);
      const { sorted, maxEnd } = book;
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].start <= until) lo = mid + 1;
        else hi = mid;
      }
      // Walking back from the last episode starting by `until`; ties go to the
      // earliest episode, as the forward scan did.
      let best = null;
      let bestOverlap = 0;
      for (let i = lo - 1; i >= 0 && maxEnd[i] >= from; i -= 1) {
        const episode = sorted[i];
        const overlap = Math.min(until, episode.end) - Math.max(from, episode.start);
        if (overlap >= 0 && (best === null || overlap >= bestOverlap)) {
          best = episode;
          bestOverlap = overlap;
        }
      }
      return best;
    };
  }

  function binancePriceMoveBps(position) {
    const cost = num(firstDefined(position.avgCost, position.entryPrice, position.openPrice), 0);
    const close = num(firstDefined(position.avgClosePrice, position.closePrice), 0);
    const side = String(firstDefined(position.positionSide, position.side, "")).toUpperCase();
    if (!cost || !close) return 0;
    const move = side === "SHORT" ? cost / close - 1 : close / cost - 1;
    return move * 10000;
  }

  function analyzeBinanceOrders(orders, episodes) {
    let openOrders = 0;
    let closeOrders = 0;
    let adverseAdds = 0;
    let maxLayers = 0;
    const initialNotionals = [];
    const addNotionals = [];
    const adverseStepBps = [];
    const symbols = new Map();

    for (const order of orders) {
      const symbol = String(order.symbol || "");
      if (symbol) symbols.set(symbol, (symbols.get(symbol) || 0) + 1);
    }

    // Which fills open, add to, close or flip a position comes from the one
    // shared replay (src/positions.js via src/style.js), never from guessing
    // here: one-way accounts flip through zero and a breakeven close has zero pnl.
    for (const episode of episodes) {
      const long = episode.direction === "LONG";
      openOrders += episode.entries.length;
      closeOrders += episode.exits.length;
      maxLayers = Math.max(maxLayers, episode.entries.length);
      episode.entries.forEach((fill, index) => {
        if (index === 0) {
          initialNotionals.push(fill.notional);
          return;
        }
        addNotionals.push(fill.notional);
        const previous = episode.entries[index - 1].price;
        if (long ? fill.price < previous : fill.price > previous) {
          adverseAdds += 1;
          adverseStepBps.push(Math.abs(long ? (previous / fill.price - 1) * 10000 : (fill.price / previous - 1) * 10000));
        }
      });
    }

    const initialOrderMedian = median(initialNotionals);
    const addOrderMedian = median(addNotionals);
    const addSizeExpansion = initialOrderMedian > 0 && addOrderMedian > initialOrderMedian * 1.2;

    const dominantSymbol = [...symbols.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      openOrders,
      closeOrders,
      adverseAdds,
      adverseAddRate: safeDivide(adverseAdds, openOrders, 0),
      maxLayers,
      initialOrderMedian,
      addOrderMedian,
      addSizeExpansion,
      adverseStepMedianBps: median(adverseStepBps),
      dominantSymbol: dominantSymbol ? dominantSymbol[0] : "",
      dominantSymbolShare: dominantSymbol ? safeDivide(dominantSymbol[1], orders.length, 0) : 0
    };
  }

  function isCapitalInflowTransfer(item) {
    // LEAD_DEPOSIT / LEAD_INVEST = real capital added by the trader.
    // LEAD_FEE_DEPOSIT = the trader topping up to settle a profit-share fee owed
    // to copiers — routed through the same account, but not a position rescue.
    // A plain substring match on "DEPOSIT" mixes the two (every fee top-up is
    // literally named *_FEE_DEPOSIT_*) and inflates the loss-period-deposit count
    // with $0.03-$2 fee noise alongside real five/six-figure injections.
    const type = String(item.transType || item.type || "").toUpperCase();
    return (type.includes("DEPOSIT") || type.includes("INVEST")) && !type.includes("FEE");
  }

  function analyzeTransfers(transfers, losses) {
    const deposits = transfers.filter(isCapitalInflowTransfer);
    const lossIntervals = losses
      .map((position) => ({
        symbol: String(firstDefined(position.symbol, position.instId, "")),
        pnl: binancePositionPnl(position),
        opened: num(firstDefined(position.opened, position.openTime, position.createTime), 0),
        closed: num(firstDefined(position.closed, position.closeTime, position.updateTime), 0)
      }))
      .filter((range) => range.opened > 0 && range.closed >= range.opened);

    const depositAmounts = deposits.map((item) => num(firstDefined(item.amount, item.amt), 0)).filter((value) => value > 0);
    const lossPeriodDeposits = deposits.filter((item) => {
      const ts = num(firstDefined(item.time, item.ts, item.cTime), 0);
      return ts > 0 && lossIntervals.some((range) => range.opened <= ts && ts <= range.closed);
    });
    const lossPeriodAmount = lossPeriodDeposits.reduce((sum, item) => sum + Math.max(0, num(firstDefined(item.amount, item.amt), 0)), 0);
    const maxDeposit = depositAmounts.length ? Math.max(...depositAmounts) : 0;
    const rescueTimeline = lossPeriodDeposits
      .map((item) => {
        const time = num(firstDefined(item.time, item.ts, item.cTime), 0);
        const amount = num(firstDefined(item.amount, item.amt), 0);
        const positions = lossIntervals
          .filter((range) => range.opened <= time && time <= range.closed)
          .map((range) => ({ symbol: range.symbol, pnl: range.pnl, opened: range.opened, closed: range.closed }));
        return { time, amount, positions };
      })
      .filter((entry) => entry.time > 0 && entry.amount > 0)
      .sort((a, b) => a.time - b.time);
    return {
      depositCount: depositAmounts.length,
      depositTotal: depositAmounts.reduce((sum, value) => sum + value, 0),
      maxDeposit,
      lossPeriodDepositCount: lossPeriodDeposits.length,
      lossPeriodDepositTotal: lossPeriodAmount,
      lastLossPeriodDepositAt: lossPeriodDeposits.reduce((latest, item) => Math.max(latest, num(firstDefined(item.time, item.ts, item.cTime), 0)), 0) || null,
      rescueTimeline
    };
  }

  // The largest single position against the account it was opened on: peak
  // notional (maxOpenInterest x avgCost) over the account at that moment. The
  // account is counted back from today's margin balance (the exchange's own
  // number): less pnl realised since, less USDT paid in since, plus USDT paid
  // out since. Counting forward from the first deposit instead needs every
  // position since the start, and Binance keeps about 120 days of them — for a
  // February portfolio it read 350 USDT where the account held thousands.
  // The inverse is the adverse move that would have zeroed the account.
  // Unrealised pnl today is not subtracted, so it is an estimate.
  function biggestBetOf(allPositions, roundPositions, transfers, marginBalance) {
    if (!(marginBalance > 0)) return null;
    const flows = transfers
      .filter((item) => String(item.coin || "USDT").toUpperCase() === "USDT")
      .map((item) => {
        const amount = Math.abs(num(firstDefined(item.amount, item.amt), 0));
        const sign = isCapitalInflowTransfer(item) ? 1 : transferDirection(item) === "out" ? -1 : 0;
        return { time: num(firstDefined(item.time, item.ts, item.cTime), 0), amount: sign * amount };
      })
      .filter((flow) => flow.time > 0 && flow.amount !== 0);
    // Everything realised or transferred at or after a moment, by suffix sums
    // over time-sorted events: one pass instead of a rescan per position.
    const since = (events) => {
      const sorted = [...events].sort((a, b) => a.time - b.time);
      const suffix = new Array(sorted.length + 1).fill(0);
      for (let i = sorted.length - 1; i >= 0; i -= 1) suffix[i] = suffix[i + 1] + sorted[i].amount;
      return (moment) => {
        let lo = 0;
        let hi = sorted.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (sorted[mid].time < moment) lo = mid + 1;
          else hi = mid;
        }
        return suffix[lo];
      };
    };
    const pnlSince = since(allPositions
      .filter((row) => positionClosedAt(row) > 0)
      .map((row) => ({ time: positionClosedAt(row), amount: binancePositionPnl(row) })));
    const flowsSince = since(flows);
    let biggest = null;
    for (const row of roundPositions) {
      const opened = positionOpenedAt(row);
      const notional = num(row.maxOpenInterest, 0) * num(row.avgCost, 0);
      if (!opened || !(notional > 0)) continue;
      // Binance will not open a position whose initial margin exceeds the
      // account, so its notional over the account cannot exceed the leverage it
      // was opened at. When the count-back says otherwise (82 of 444 cached
      // traders: unrealised pnl in today's balance, fee and profit-share flows
      // that are not transfers), the estimate is wrong and the exchange's
      // bound is the figure that is known to hold.
      const rowLeverage = num(row.leverage, 0);
      const estimate = marginBalance - pnlSince(opened) - flowsSince(opened);
      const account = rowLeverage > 0 ? Math.max(estimate, notional / rowLeverage) : estimate;
      if (!(account > 0)) continue;
      const leverage = notional / account;
      if (!biggest || leverage > biggest.leverage) {
        biggest = { leverage, symbol: String(row.symbol || ""), openedAt: opened, notional, account, boundByLeverage: account !== estimate, wipeOutMovePct: 100 / leverage };
      }
    }
    return biggest;
  }

  function analyzeLivePositions(livePositions, orderAnalysis, marginBalance) {
    // Binance's lead-data/positions endpoint returns one placeholder row per
    // symbol/side combination the trader has ever configured, most with zero
    // quantity — filter to rows with a real position before counting/listing,
    // or `openCount`/`dominantOpenSymbols` report hundreds of empty scaffolding
    // rows as if they were live positions.
    const rows = Array.isArray(livePositions) ? livePositions : [];
    let openUnrealizedLoss = 0;
    let openUnrealizedProfit = 0;
    let openNotional = 0;
    const losingPositions = [];
    const openPositions = [];

    for (const position of rows) {
      const qty = num(firstDefined(position.positionAmount, position.pos, position.quantity, position.availPos), 0);
      const pnl = num(firstDefined(position.unrealizedProfit, position.pnl, position.upl), 0);
      const mark = num(firstDefined(position.markPrice, position.last, position.close), 0);
      let notional = Math.abs(num(firstDefined(position.notionalValue, position.notionalUsd, position.margin), 0));
      if (!notional && mark && qty) notional = Math.abs(qty * mark);
      if (Math.abs(qty) > 0 || notional > 0) {
        openPositions.push(position);
        openNotional += notional;
        if (pnl < 0) {
          openUnrealizedLoss += Math.abs(pnl);
          losingPositions.push(position);
        } else {
          openUnrealizedProfit += pnl;
        }
      }
    }

    return {
      openCount: openPositions.length,
      losingOpenCount: losingPositions.length,
      openUnrealizedLoss,
      openUnrealizedProfit,
      openUnrealizedLossToMargin: safeDivide(openUnrealizedLoss, marginBalance, 0),
      openNotional,
      openNotionalToMargin: safeDivide(openNotional, marginBalance, 0),
      dominantOpenSymbols: openPositions.slice(0, 5).map((p) => String(firstDefined(p.symbol, p.instId, p.instIdCode, ""))).filter(Boolean),
      orderAnalysis
    };
  }

  // This lead portfolio's own start. Binance's position-history endpoint
  // returns rows from before the portfolio existed — a prior closed lead
  // round, or the trader's personal trading — and a copier of THIS portfolio
  // never experienced them. The cash-flow reconstruction already detects the
  // condition (preStartHistoryDays); the behaviour statistics must actually
  // exclude it, or one pre-portfolio disaster sets win rate, payoff ratio and
  // dead-loss duration for a round that never contained it.
  function roundStartMsOf(raw) {
    const detail = raw?.detail || {};
    return num(firstDefined(detail.startTime, 0), 0);
  }

  function splitPositionsByRound(positions, roundStartMs) {
    const all = Array.isArray(positions) ? positions : [];
    if (!roundStartMs) return { inRound: all, preRound: [] };
    const inRound = [];
    const preRound = [];
    for (const position of all) {
      const closed = positionClosedAt(position);
      // closed === 0 marks a row that is still open, which is current-round by
      // definition.
      if (closed > 0 && closed < roundStartMs) preRound.push(position);
      else inRound.push(position);
    }
    return { inRound, preRound };
  }

  function summarizeClosedPositions(positions, exchange, options = {}) {
    const roundStartMs = num(options.roundStartMs, 0);
    const episodeOf = options.episodes ? episodeIndex(options.episodes) : null;
    const { inRound, preRound } = splitPositionsByRound(positions, roundStartMs);
    // Binance's own definition: a partially closed position is not a closed
    // position. Its realized-so-far pnl says nothing about how it ends, so it
    // stays out of the closed sample, win rate and payoff until it closes.
    const stillOpen = exchange === "Binance" ? inRound.filter((row) => !positionClosedAt(row)) : [];
    const closed = exchange === "Binance" ? inRound.filter((row) => positionClosedAt(row) > 0) : inRound;
    let holdClampedToRoundStart = 0;
    const getPnl = exchange === "OKX"
      ? (row) => num(row.pnl, 0)
      : binancePositionPnl;
    const getClose = exchange === "OKX"
      ? (row) => num(firstDefined(row.uTime, row.closeTime), 0)
      : positionClosedAt;
    // hours: per unit held where the row's fills are in the history, otherwise
    // first entry to last exit; rowHours: always first entry to last exit.
    const getHold = exchange === "OKX"
      ? (row) => {
        const open = num(row.openTime, 0);
        const close = getClose(row);
        const hours = open && close && close >= open ? (close - open) / HOUR_MS : 0;
        return { hours, rowHours: hours, perUnit: false };
      }
      : (row) => {
        const rawOpened = positionOpenedAt(row);
        if (roundStartMs && rawOpened && rawOpened < roundStartMs && positionHeldUntil(row) >= roundStartMs) {
          holdClampedToRoundStart += 1;
        }
        const episode = episodeOf ? episodeOf(row) : null;
        return {
          hours: binanceHoldHours(row, roundStartMs, episode),
          rowHours: binanceHoldHours(row, roundStartMs),
          perUnit: Boolean(episode)
        };
      };

    const wins = [];
    const losses = [];
    const winHoldRecords = [];
    // Each loss hold with the moment it ended: its close, or null while the
    // position is still open.
    const lossHoldEvents = [];
    const priceMoves = [];
    const symbols = new Map();

    for (const row of closed) {
      const pnl = getPnl(row);
      const hold = getHold(row);
      const symbol = String(firstDefined(row.symbol, row.instId, ""));
      if (symbol) symbols.set(symbol, (symbols.get(symbol) || 0) + 1);
      if (exchange === "Binance") priceMoves.push(binancePriceMoveBps(row));
      if (pnl > 0) {
        wins.push(pnl);
        if (hold.hours) winHoldRecords.push(hold);
      } else if (pnl < 0) {
        losses.push(pnl);
        if (hold.hours) lossHoldEvents.push({ ...hold, endedAt: getClose(row) });
      }
    }

    // A still-open position that already realized a loss on a partial close was
    // held underwater at least until that close: it counts toward how long
    // losses are held, not toward win rate.
    for (const row of stillOpen) {
      if (getPnl(row) >= 0) continue;
      const hold = getHold(row);
      if (hold.hours) lossHoldEvents.push({ ...hold, endedAt: null });
    }
    const winHolds = winHoldRecords.map((record) => record.hours);
    const lossHolds = lossHoldEvents.map((event) => event.hours);
    const mean = (values) => safeDivide(values.reduce((sum, value) => sum + value, 0), values.length, 0);
    // Win holds against loss holds only on one clock. Rows outside the order
    // history keep the longer row clock, so a trader whose losses predate the
    // fills and whose wins do not would otherwise compare a row clock with a
    // per-unit one (4216060947283912192 flipped from watch to avoid that way).
    const winPerUnit = winHoldRecords.filter((record) => record.perUnit);
    const lossPerUnit = lossHoldEvents.filter((event) => event.perUnit);
    const comparableHoldHours = winPerUnit.length && lossPerUnit.length
      ? { win: mean(winPerUnit.map((record) => record.hours)), loss: mean(lossPerUnit.map((event) => event.hours)) }
      : { win: mean(winHoldRecords.map((record) => record.rowHours)), loss: mean(lossHoldEvents.map((event) => event.rowHours)) };

    const dominantSymbol = [...symbols.entries()].sort((a, b) => b[1] - a[1])[0];
    const avgWin = safeDivide(wins.reduce((sum, value) => sum + value, 0), wins.length, 0);
    const avgLoss = safeDivide(losses.reduce((sum, value) => sum + value, 0), losses.length, 0);
    const winRate = safeDivide(wins.length, closed.length, 0);
    return {
      closedTrades: closed.length,
      // Reported, not swallowed: a reader has to be able to see that N rows
      // were dropped for predating this portfolio, and how many holding
      // clocks were clipped at the start date.
      preRoundPositionsExcluded: preRound.length,
      openPositionsExcluded: stillOpen.length,
      holdClampedToRoundStart,
      roundStartMs: roundStartMs || null,
      winCount: wins.length,
      lossCount: losses.length,
      winRate,
      avgWin,
      avgLoss,
      payoffRatio: avgLoss < 0 ? avgWin / Math.abs(avgLoss) : null,
      expectancy: safeDivide(wins.reduce((sum, value) => sum + value, 0) + losses.reduce((sum, value) => sum + value, 0), closed.length, 0),
      avgWinHoldHours: mean(winHolds),
      avgLossHoldHours: mean(lossHolds),
      maxLossHoldHours: lossHolds.length ? Math.max(...lossHolds) : 0,
      lossHoldEvents,
      medianHoldHours: median([...winHolds, ...lossHolds]),
      medianWinHoldHours: median(winHolds),
      medianLossHoldHours: median(lossHolds),
      comparableHoldHours,
      lossHoldRatio: safeDivide(comparableHoldHours.loss, Math.max(0.1, comparableHoldHours.win), 0),
      dominantSymbol: dominantSymbol ? dominantSymbol[0] : "",
      dominantSymbolShare: dominantSymbol ? safeDivide(dominantSymbol[1], closed.length, 0) : 0,
      tpMedianBps: median(priceMoves.filter((value) => value > 0)),
      lossMoveP90Bps: percentile(priceMoves.filter((value) => value < 0).map(Math.abs), 90)
    };
  }

  const STYLE_FAMILY_KEYS = {
    insufficient: "familyInsufficient",
    martingale: "familyMartingale",
    grid: "familyGrid",
    dcaNoStop: "familyDcaNoStop",
    dcaWithStop: "familyDcaWithStop",
    shortTerm: "familyShortTerm",
    swing: "familySwing"
  };
  const STYLE_SECONDARY_KEYS = {
    martingale: "labelSomeMartingale",
    grid: "labelSomeGrid",
    neverRealisedLoss: "labelNeverRealisedLoss"
  };
  // Which style gate failed, with the trader's number beside the bar it missed.
  const STYLE_INSUFFICIENT_LABELS = {
    fewOrders: (evidence, bars) => t("styleNeedOrders", [evidence.orders, bars.MIN_ORDERS]),
    fewClosedPositions: (evidence, bars) => t("styleNeedClosedPositions", [evidence.closedEpisodes, bars.MIN_CLOSED_EPISODES]),
    // Rounded down: 6.96 days shown as "7.0, at least 7" would contradict itself.
    shortWindow: (evidence, bars) => t("styleNeedWindow", [
      (Math.floor(evidence.spanDays * 10) / 10).toFixed(1), evidence.closedEpisodes, bars.MIN_SPAN_DAYS, bars.MIN_SHORT_WINDOW_DAYS, bars.MIN_CLOSED_IN_SHORT_WINDOW
    ]),
    mostlyCutOff: (evidence) => t("styleMostlyCutOff", [evidence.cutOffPositions, evidence.closedEpisodes])
  };

  // The style itself is decided from the fills in src/style.js; this only
  // renders it and adds the descriptive facts read off closed position rows.
  function inferStrategy(summary, style) {
    const evidence = style.evidence || {};
    const bars = global.CopyTradingLensStyle.THRESHOLDS;
    const labels = [
      ...(style.insufficient || []).map((key) => STYLE_INSUFFICIENT_LABELS[key](evidence, bars)),
      ...(style.secondary || []).map((key) => t(STYLE_SECONDARY_KEYS[key]))
    ];
    // Averaging in is a family only when it is a habit; below that it is still a
    // fact worth showing. Measured on 89 hand-labelled traders, occasional
    // averagers and discretionary traders overlap completely between 6% and 14%,
    // so the share is stated rather than forced into either family.
    const deepAddPercent = Math.round((evidence.deepAddShare || 0) * 100);
    if ((style.family === "shortTerm" || style.family === "swing") && deepAddPercent >= 1) {
      labels.push(t("labelSomeDeepAdds", [deepAddPercent]));
    }
    // Binance serves only the most recent fills (about 60 days, at most ~6,000
    // orders), so the style describes that window, not the whole portfolio.
    if (style.family !== "insufficient" && evidence.spanDays > 0) {
      labels.push(t("labelStyleWindow", [Math.round(evidence.spanDays)]));
    }
    if (summary.payoffRatio !== null && summary.payoffRatio < 0.5) labels.push(t("labelPoorPayoff"));
    if (summary.winRate >= 0.95) labels.push(t("labelHighWinTailRisk"));
    if (summary.dominantSymbolShare >= 0.5) labels.push(t("labelSingleSymbol"));
    return { family: t(STYLE_FAMILY_KEYS[style.family]), style: style.family, labels: [...new Set(labels)] };
  }

  // OKX serves closed positions but no fills, so the mechanism (grid,
  // martingale, averaging in) cannot be seen — only how long positions are held.
  function styleFromPositionRows(summary) {
    const { MIN_CLOSED_EPISODES, SWING_HOLD_HOURS } = global.CopyTradingLensStyle.THRESHOLDS;
    if (summary.closedTrades < MIN_CLOSED_EPISODES) return { family: "insufficient", secondary: [] };
    return { family: summary.medianHoldHours < SWING_HOLD_HOURS ? "shortTerm" : "swing", secondary: [] };
  }

  // The longest dead loss, and when the latest one at the same bar ended — or
  // that it has not: a still-open position whose partial close realized a loss
  // is still being held, and its last partial close is not an end.
  function severeDeadLossAlert(maxHours, events, bar) {
    const severe = events.filter((event) => event.hours >= bar);
    if (severe.some((event) => event.endedAt === null)) {
      return t("alertSevereDeadLossStillOpen", [formatHours(maxHours)]);
    }
    const latest = severe.reduce((max, event) => Math.max(max, event.endedAt), 0);
    return t("alertSevereDeadLoss", [formatHours(maxHours), formatDateTime(latest)]);
  }

  // A single bet this large against the account is how accounts end.
  // tools/research/backtest-risk-rules.mjs (2026-09-14): 225 cached traders,
  // the biggest bet read from their snapshot, followed a median 39 days. Share
  // that closed the portfolio or fell 30%+ on Binance's own ROI curve, scanned
  // at every 1x from 1x to 40x and on two halves split by portfolio id:
  //   at or above 12x: 81% of 83 (halves 76% / 85%), flat at 81-86% up to 21x
  //   below 3x:        19% of 59 (halves 16% / 21%)
  //   all traders:     53%; by verdict level before this gate avoid 57%,
  //                    risky 53%, followable 44%; with it avoid 59%, risky 35%
  // The bar sits where the above-share stops rising on both halves (12-15x).
  const BIGGEST_BET_AVOID_LEVERAGE = 12;

  function buildVerdict(meta, summary, orders, transfers, live, biggestBet = null) {
    const evidence = [];
    const cautions = [];
    const positives = [];
    const alerts = [];
    let level = "watch";
    let title = t("verdictWatch");

    const copierPnlToAum = safeDivide(meta.copierPnl, meta.aum, 0);
    const adverseRate = orders.adverseAddRate || 0;
    const poorPayoff = summary.payoffRatio !== null && summary.payoffRatio < 0.5;
    const strongPayoff = summary.payoffRatio !== null && summary.payoffRatio >= 1;
    const lowMdd = Number.isFinite(meta.mdd) && meta.mdd < 15;
    const enoughHistory = meta.days >= 60 && summary.closedTrades >= 50;
    const cleanOpenRisk = live.openUnrealizedLossToMargin < 0.02 && live.openUnrealizedLoss < 2000;

    // Initial leverage risk
    const marginBalance = Math.max(1, meta.marginBalance || meta.aum || 0);
    const initialOrderNotional = orders.initialOrderMedian || 0;
    const initialLeverage = safeDivide(initialOrderNotional, marginBalance, 0);
    const highInitialLeverage = initialLeverage >= 10 && adverseRate >= 0.30;

    // Dead loss duration thresholds
    const SEVERE_DEAD_LOSS_HOURS = 150;
    const severeDeadLoss = summary.maxLossHoldHours >= SEVERE_DEAD_LOSS_HOURS;
    const extremeDeadLoss = summary.maxLossHoldHours >= 300;

    // Stagnant momentum detection
    const roi30 = meta.performanceWindows?.["30D"]?.roi;
    const roi7 = meta.performanceWindows?.["7D"]?.roi;
    const tradesPerDay = safeDivide(summary.closedTrades, Math.max(1, meta.days), 0);
    const isStagnant = meta.days >= 60
      && (
        (Number.isFinite(roi30) && roi30 < 6)
        || (tradesPerDay < 0.35 && (Number.isFinite(roi30) ? roi30 < 10 : (Number.isFinite(meta.roi) ? meta.roi < 15 : true)))
      );

    // Momentum status for UI
    let momentumStatus = "normal";
    if (live.openUnrealizedLossToMargin >= 0.10 || (Number.isFinite(roi7) && roi7 <= -5)) {
      momentumStatus = "drawdown";
    } else if (isStagnant) {
      momentumStatus = "stagnant";
    } else if (Number.isFinite(roi30) && roi30 >= 20 && tradesPerDay >= 0.5) {
      momentumStatus = "active";
    }

    // Alerts
    if (transfers.lossPeriodDepositCount > 0) {
      alerts.push(t("alertLossDeposit", [transfers.lossPeriodDepositCount]));
    }
    if (severeDeadLoss) {
      alerts.push(severeDeadLossAlert(summary.maxLossHoldHours, summary.lossHoldEvents, SEVERE_DEAD_LOSS_HOURS));
    }

    const destructiveMartingale = (
      adverseRate > 0.35
      && summary.avgLossHoldHours > 12
      && summary.lossHoldRatio > 1.5
      && orders.addSizeExpansion
    ) || (
      adverseRate > 0.50
      && poorPayoff
      && orders.addSizeExpansion
    );

    const isZeroLossMartingaleBomb = summary.closedTrades >= 20
      && summary.lossCount === 0
      && (adverseRate >= 0.35 || orders.maxLayers >= 5);

    const hasProvenCopierProfit = (meta.copierPnl >= 50000 || copierPnlToAum >= 0.20)
      && transfers.lossPeriodDepositCount === 0
      && summary.expectancy > 0
      && !poorPayoff
      && summary.closedTrades >= 30
      && !destructiveMartingale
      && !isZeroLossMartingaleBomb
      && !isStagnant;

    if (hasProvenCopierProfit) {
      positives.unshift(t("positiveHighCopierProfit", [formatMoney(meta.copierPnl)]));
    }

    if (meta.days >= 30) positives.push(t("positiveDays", [meta.days.toFixed(0)]));
    if (summary.closedTrades >= 50) positives.push(t("positiveClosedTrades", [summary.closedTrades]));
    if (summary.payoffRatio !== null && summary.payoffRatio >= 1) positives.push(t("positivePayoff", [summary.payoffRatio.toFixed(2)]));
    if (summary.comparableHoldHours.loss > 0 && summary.comparableHoldHours.loss < summary.comparableHoldHours.win) positives.push(t("positiveLossHoldShort"));
    if (meta.days > 0 && meta.days < 30) cautions.push(t("cautionTooFewDays", [meta.days.toFixed(1)]));
    if (!Number.isFinite(meta.roi)) cautions.push(t("cautionNoAllPeriodRoi"));
    if (Number.isFinite(meta.roi) && !meta.allPeriodPerformance?.reliable) cautions.push(t("cautionReconstructedNeedsCompleteness"));
    if (summary.closedTrades === 0) cautions.push(t("cautionNoClosedTrades"));
    else if (summary.closedTrades < 30) cautions.push(t("cautionThinClosedTrades", [summary.closedTrades]));
    if (meta.mdd >= 30) cautions.push(t("cautionHighMdd", [formatPct(meta.mdd)]));
    if (extremeDeadLoss || severeDeadLoss) {
      cautions.push(t("cautionSevereDeadLoss", [formatHours(summary.maxLossHoldHours)]));
    } else if (summary.maxLossHoldHours >= 72) {
      cautions.push(t("cautionLongLossHold", [formatHours(summary.maxLossHoldHours)]));
    }
    if (poorPayoff) cautions.push(t("cautionPoorPayoff", [summary.payoffRatio?.toFixed(2)]));
    if (isZeroLossMartingaleBomb) {
      cautions.push(t("cautionZeroLossMartingaleBomb", [orders.maxLayers]));
    } else if (summary.winRate >= 0.98 && summary.lossCount <= 1 && summary.closedTrades >= 20) {
      cautions.push(t("cautionNearPerfectWin"));
    }
    if (orders.openOrders >= 300 && summary.avgWin > 0 && summary.avgWin <= 2) cautions.push(t("cautionMicroProfit"));
    if (adverseRate >= 0.35) cautions.push(t("cautionAdverseAdd", [`${(adverseRate * 100).toFixed(0)}%`]));
    if (highInitialLeverage) cautions.push(t("cautionHighInitialLeverage", [initialLeverage.toFixed(1)]));
    if (isStagnant) cautions.push(t("cautionStagnantMomentum", [Number.isFinite(roi30) ? `${roi30.toFixed(1)}%` : "0%", tradesPerDay.toFixed(2)]));
    if (transfers.lossPeriodDepositCount > 0) cautions.push(t("cautionLossPeriodDeposit", [transfers.lossPeriodDepositCount]));
    if (live.openUnrealizedLossToMargin >= 0.05 || live.openUnrealizedLoss >= 5000) cautions.push(t("cautionFloatingLoss", [formatMoney(live.openUnrealizedLoss), (live.openUnrealizedLossToMargin * 100).toFixed(1)]));
    if (copierPnlToAum <= -0.05 && meta.roi > 0) cautions.push(t("cautionCopierDivergence", [`${(copierPnlToAum * 100).toFixed(1)}%`]));
    if (meta.closeLeadCount >= 8) cautions.push(t("cautionCloseLeadCount", [meta.closeLeadCount]));
    if (meta.allPeriodPerformance?.preStartHistoryDays > 2) cautions.push(t("cautionPreStartHistory", [meta.allPeriodPerformance.preStartHistoryDays.toFixed(0)]));

    const allInBet = Boolean(biggestBet && biggestBet.leverage >= BIGGEST_BET_AVOID_LEVERAGE);
    if (allInBet) {
      cautions.unshift(t("cautionBiggestBet", [biggestBet.leverage.toFixed(1), biggestBet.symbol, biggestBet.wipeOutMovePct.toFixed(1)]));
    }

    if (transfers.lossPeriodDepositCount > 0) {
      level = "avoid";
      title = t("verdictAvoid");
      evidence.push(t("evidenceLossDeposit"));
    } else if (allInBet) {
      level = "avoid";
      title = t("verdictAvoid");
      evidence.push(t("evidenceBiggestBet"));
    } else if (extremeDeadLoss) {
      level = "avoid";
      title = t("verdictAvoid");
      evidence.push(t("evidenceExtremeDeadLoss"));
    } else if (isZeroLossMartingaleBomb && (meta.mdd >= 40 || orders.maxLayers >= 15)) {
      level = "avoid";
      title = t("verdictAvoid");
      evidence.push(t("evidenceZeroLossMartingaleBomb"));
    } else if (destructiveMartingale) {
      level = "avoid";
      title = t("verdictAvoid");
      evidence.push(t("evidenceDestructiveMartingale"));
    } else if (live.openUnrealizedLossToMargin >= 0.20 || live.openUnrealizedLoss >= 50000) {
      level = "avoid";
      title = t("verdictWait");
      evidence.push(t("evidenceFloatingLoss"));
    } else if (meta.copierPnl <= -20000 && (copierPnlToAum <= -0.20 || meta.pnl >= 0)) {
      level = "avoid";
      title = t("verdictAvoid");
      evidence.push(t("evidenceCopierBleed"));
    } else if (meta.mdd >= 50 && !hasProvenCopierProfit) {
      level = "avoid";
      title = t("verdictHighRiskAvoid");
      evidence.push(t("evidenceHugeMdd"));
    } else if (isStagnant) {
      level = "watch";
      title = t("verdictWatch");
    } else if (hasProvenCopierProfit && (meta.mdd >= 40 || adverseRate >= 0.35) && !severeDeadLoss && !highInitialLeverage && !isZeroLossMartingaleBomb && !isStagnant) {
      level = "followable";
      title = t("verdictAggressiveGrowth");
      evidence.push(t("evidenceAggressiveGrowth"));
    } else if (severeDeadLoss || highInitialLeverage || isZeroLossMartingaleBomb || cautions.length >= 3 || meta.mdd >= 30 || adverseRate >= 0.35 || poorPayoff) {
      level = "risky";
      title = t("verdictRisky");
    } else if (enoughHistory && lowMdd && strongPayoff && adverseRate < 0.15 && cleanOpenRisk && !severeDeadLoss && !highInitialLeverage && !isZeroLossMartingaleBomb && !isStagnant) {
      level = "preferred";
      title = t("verdictPreferred");
    } else if (meta.days >= 30 && summary.closedTrades >= 30 && !severeDeadLoss && !highInitialLeverage && !isZeroLossMartingaleBomb && !isStagnant) {
      level = "followable";
      title = t("verdictFollowSmall");
    }

    return {
      level,
      title,
      positives,
      cautions,
      evidence,
      momentumStatus,
      alerts
    };
  }

  // What the analysis would be missing if it ran now. A history that errored, or that the
  // exchange stopped serving before its reported total (the order-history depth cap), is a
  // gap; so is a core endpoint that never answered. A trader simply absent from the ranking
  // list is not a gap — that lookup answered.
  function binanceDataGaps(raw) {
    const status = raw.historyStatus || {};
    const endpoints = raw.endpointResults || {};
    const gaps = [];
    for (const [key, label] of [["positionHistory", "histPosition"], ["orderHistory", "histOrder"], ["transferHistory", "histTransfer"]]) {
      const item = status[key];
      if (!item || item.error || !item.complete) gaps.push(t(label));
    }
    if (endpoints.detail && !endpoints.detail.ok) gaps.push(t("gapDetail"));
    if (endpoints.livePositions && !endpoints.livePositions.ok) gaps.push(t("gapLivePositions"));
    if (Object.entries(endpoints).some(([key, result]) => key.startsWith("performance:") && !result.ok)) gaps.push(t("gapPerformance"));
    return gaps;
  }

  function okxDataGaps(raw) {
    const endpoints = raw.endpointResults || {};
    return [["positionHistory", "histPosition"], ["livePositions", "gapLivePositions"], ["candidate", "gapDetail"]]
      .filter(([key]) => endpoints[key] && !endpoints[key].ok)
      .map(([, label]) => t(label));
  }

  // With gaps, no pattern test can be trusted: an unread order history makes every
  // martingale and grid check read zero, which is indistinguishable from a clean trader.
  function incompleteAnalysis(gaps) {
    return {
      strategy: { family: t("familyIncompleteData"), labels: [] },
      verdict: {
        level: "incomplete",
        title: t("verdictIncomplete"),
        positives: [],
        cautions: gaps.map((label) => t("gapItem", [label])),
        evidence: [],
        alerts: []
      }
    };
  }

  function analyzeBinance(raw) {
    const pageMetrics = parseVisibleMetrics(raw.visibleText || "");
    const meta = extractBinanceMeta(raw, pageMetrics);
    const roundStart = roundStartMsOf(raw);
    const { inRound: roundPositions, preRound: preRoundPositions } = splitPositionsByRound(raw.positionHistory || [], roundStart);
    const { episodes } = global.CopyTradingLensStyle.buildEpisodes(raw.orderHistory || []);
    const summary = summarizeClosedPositions(raw.positionHistory || [], "Binance", { roundStartMs: roundStart, episodes });
    const orders = analyzeBinanceOrders(raw.orderHistory || [], episodes);
    // Same caliber for the rescue-deposit test: a deposit is only "capital
    // injected while bleeding" if the losing position belongs to this round.
    // A still-open row counts here: a partial close at a loss proves the position
    // was bleeding while it was open, and that window is what the test reads.
    const losses = roundPositions.filter((position) => binancePositionPnl(position) < 0);
    const transfers = analyzeTransfers(raw.transferHistory || [], losses);
    const live = analyzeLivePositions(raw.livePositions || [], orders, meta.marginBalance);
    // Only positions opened inside this portfolio: one opened before its first
    // deposit was sized against an account the count-back cannot see (a 60M
    // USDT portfolio read a pre-start BTC short as 3x, bound by leverage).
    const openedInRound = roundStart ? roundPositions.filter((row) => positionOpenedAt(row) >= roundStart) : roundPositions;
    const biggestBet = biggestBetOf(raw.positionHistory || [], openedInRound, raw.transferHistory || [], meta.marginBalance);
    const gaps = binanceDataGaps(raw);
    const { strategy, verdict } = gaps.length
      ? incompleteAnalysis(gaps)
      : {
        strategy: inferStrategy(summary, global.CopyTradingLensStyle.classify(raw.orderHistory || [])),
        verdict: buildVerdict(meta, summary, orders, transfers, live, biggestBet)
      };
    return {
      platform: "Binance",
      generatedAt: new Date().toISOString(),
      meta,
      summary,
      orders,
      transfers,
      live,
      biggestBet,
      strategy,
      verdict,
      rawCounts: {
        positionHistory: (raw.positionHistory || []).length,
        positionHistoryPreRound: preRoundPositions.length,
        orderHistory: (raw.orderHistory || []).length,
        transferHistory: (raw.transferHistory || []).length,
        livePositions: (raw.livePositions || []).length,
        performanceWindows: Object.keys(raw.performanceWindows || {}).length,
        historyStatus: raw.historyStatus || {}
      }
    };
  }

  function extractOkxMeta(raw, pageMetrics) {
    const candidate = raw.candidate || {};
    const rates = Array.isArray(candidate.rates) ? candidate.rates : [];
    const curve = ratioCurveStats(rates, "unit_return");
    const roi = firstDefined(curve.roi30, curve.fullRoi, num(candidate.yieldRatio, 0) * 100, pageMetrics.roi);
    const roiValue = num(roi, 0);
    const days = num(firstDefined(candidate.initialDay, pageMetrics.tradingDays), 0);
    return {
      name: String(firstDefined(candidate.nickName, candidate.nickname, raw.pageTitle, "Unknown OKX Lead")),
      id: raw.id,
      exchange: "OKX",
      url: raw.url,
      days,
      roi: roiValue,
      annualizedReturn: annualizedFromRoi(roiValue, days || 30),
      annualizedSource: t("annualizedSourceCagr"),
      mdd: num(firstDefined(curve.mdd, pageMetrics.mdd), 0),
      pnl: num(candidate.pnl, 0),
      copierPnl: num(firstDefined(candidate.followPnl, pageMetrics.copierPnl), 0),
      aum: num(candidate.aum, 0),
      marginBalance: 0,
      currentCopyCount: int(candidate.followerNum, 0),
      maxCopyCount: int(candidate.followerLimit, 0),
      totalCopyCount: int(candidate.historyFollowerNum, 0),
      closeLeadCount: 0,
      profitSharingRate: num(candidate.profitSharingRate, 0),
      positionShow: true,
      lastTradeTime: 0,
      description: "",
      pageMetrics,
      curve
    };
  }

  function ratioCurveStats(rates, ratioUnit) {
    const points = rates
      .map((row) => ({ ts: num(row.statTime, 0), ratio: num(row.ratio, 0) }))
      .filter((point) => point.ts > 0)
      .sort((a, b) => a.ts - b.ts);
    if (points.length < 2) return { mdd: 0, fullRoi: 0, roi30: 0 };
    const equity = (ratio) => ratioUnit === "unit_return" ? Math.max(1 + ratio, 0.0001) : Math.max(1 + ratio / 100, 0.0001);
    let peak = equity(points[0].ratio);
    let mdd = 0;
    for (const point of points) {
      const value = equity(point.ratio);
      peak = Math.max(peak, value);
      mdd = Math.max(mdd, (peak - value) / peak * 100);
    }
    const last = points[points.length - 1];
    const start30 = points.filter((point) => point.ts <= last.ts - 30 * DAY_MS).pop() || points[0];
    const fullRoi = (equity(last.ratio) / equity(points[0].ratio) - 1) * 100;
    const roi30 = (equity(last.ratio) / equity(start30.ratio) - 1) * 100;
    return { mdd, fullRoi, roi30 };
  }

  function analyzeOkx(raw) {
    const pageMetrics = parseVisibleMetrics(raw.visibleText || "");
    const meta = extractOkxMeta(raw, pageMetrics);
    const summary = summarizeClosedPositions(raw.positionHistory || [], "OKX");
    const orders = {
      openOrders: 0,
      closeOrders: 0,
      adverseAdds: 0,
      adverseAddRate: 0,
      maxLayers: 0,
      initialOrderMedian: 0,
      addOrderMedian: 0,
      addSizeExpansion: false,
      adverseStepMedianBps: 0,
      dominantSymbol: summary.dominantSymbol,
      dominantSymbolShare: summary.dominantSymbolShare
    };
    const transfers = {
      depositCount: 0,
      depositTotal: 0,
      maxDeposit: 0,
      lossPeriodDepositCount: 0,
      lossPeriodDepositTotal: 0,
      lastLossPeriodDepositAt: null
    };
    const liveMargin = (raw.livePositions || []).reduce((sum, row) => sum + Math.abs(num(row.margin, 0)), 0);
    meta.marginBalance = liveMargin || meta.aum || 0;
    const live = analyzeLivePositions(raw.livePositions || [], orders, meta.marginBalance);
    const gaps = okxDataGaps(raw);
    const { strategy, verdict } = gaps.length
      ? incompleteAnalysis(gaps)
      : { strategy: inferStrategy(summary, styleFromPositionRows(summary)), verdict: buildVerdict(meta, summary, orders, transfers, live) };
    return {
      platform: "OKX",
      generatedAt: new Date().toISOString(),
      meta,
      summary,
      orders,
      transfers,
      live,
      // OKX serves no transfer history, so the account behind a bet is unknown.
      biggestBet: null,
      strategy,
      verdict,
      rawCounts: {
        positionHistory: (raw.positionHistory || []).length,
        orderHistory: 0,
        transferHistory: 0,
        livePositions: (raw.livePositions || []).length
      }
    };
  }

  global.CopyTradingLensAnalysis = {
    analyzeBinance,
    analyzeOkx,
    binanceDataGaps,
    inferStrategy,
    buildVerdict,
    formatPct,
    formatMoney,
    formatHours,
    formatDateTime,
    num,
    int
  };
})(window);
