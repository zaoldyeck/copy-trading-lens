(function attachAnalysis(global) {
  "use strict";

  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

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

  function normalizeWindowMetric(row) {
    if (!row || typeof row !== "object") return null;
    const roi = num(row.roi, null);
    const mdd = num(row.mdd, null);
    return {
      timeRange: row.timeRange || "",
      roi,
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
      if (direction === "in") grossDeposits += amount;
      if (direction === "out") withdrawals += amount;
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
    const startGapDays = detailStart && firstAt ? Math.max(0, (firstAt - detailStart) / DAY_MS) : 0;
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

    return {
      roi,
      mdd: curve.length >= 2 ? reconstructedMdd : null,
      netProfit,
      realizedPnl,
      grossDeposits,
      withdrawals,
      currentEquity: Number.isFinite(currentEquity) ? currentEquity : null,
      currentEquityFromEvents,
      firstEventTime: firstAt || null,
      lastEventTime: lastEventTime || null,
      closedTrades: positions.length,
      curvePoints: curve.length,
      complete,
      reliable,
      startGapDays,
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
    const mdd = num(firstDefined(worstWindowMdd, reconstructed.mdd, detail.mdd, detail.maxDrawdown, pageMetrics.mdd), null);
    const performanceSource = Number.isFinite(reconstructed.roi)
      ? "歷史現金流重建"
      : (primaryWindow ? `交易所 ${primaryWindow} 視窗` : "頁面/API fallback");
    const performanceQuality = reconstructed.reliable
      ? "完整"
      : (Number.isFinite(reconstructed.roi) ? "可重建但需看完整度" : "不可重建");
    return {
      name: String(firstDefined(detail.nickname, listItem.nickname, raw.pageTitle, "Unknown Binance Lead")),
      id: raw.id,
      exchange: "Binance",
      url: raw.url,
      days,
      roi,
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

  function binanceHoldHours(position) {
    const opened = num(firstDefined(position.opened, position.openTime, position.createTime), 0);
    const closed = num(firstDefined(position.closed, position.closeTime, position.updateTime), 0);
    if (!opened || !closed || closed < opened) return 0;
    return (closed - opened) / HOUR_MS;
  }

  function binancePriceMoveBps(position) {
    const cost = num(firstDefined(position.avgCost, position.entryPrice, position.openPrice), 0);
    const close = num(firstDefined(position.avgClosePrice, position.closePrice), 0);
    const side = String(firstDefined(position.positionSide, position.side, "")).toUpperCase();
    if (!cost || !close) return 0;
    const move = side === "SHORT" ? cost / close - 1 : close / cost - 1;
    return move * 10000;
  }

  function analyzeBinanceOrders(orders) {
    const sorted = [...orders].sort((a, b) => num(a.orderTime, 0) - num(b.orderTime, 0));
    const tracker = new Map();
    let openOrders = 0;
    let closeOrders = 0;
    let adverseAdds = 0;
    let maxLayers = 0;
    const initialNotionals = [];
    const addNotionals = [];
    const adverseStepBps = [];
    const symbols = new Map();
    const leverages = new Map();

    for (const order of sorted) {
      const symbol = String(order.symbol || "");
      if (symbol) symbols.set(symbol, (symbols.get(symbol) || 0) + 1);
      const leverage = String(firstDefined(order.leverage, order.leverageLevel, ""));
      if (leverage) leverages.set(leverage, (leverages.get(leverage) || 0) + 1);

      const positionSide = String(firstDefined(order.positionSide, "BOTH")).toUpperCase();
      const side = String(order.side || "").toUpperCase();
      const qty = Math.abs(num(firstDefined(order.executedQty, order.origQty, order.quantity), 0));
      const price = num(firstDefined(order.avgPrice, order.price), 0);
      const notional = Math.abs(num(firstDefined(order.cumQuote, order.quoteQty, order.notional), qty * price));
      const pnl = num(firstDefined(order.totalPnl, order.realizedProfit), 0);
      const key = `${symbol}:${positionSide}`;
      const state = tracker.get(key) || { qty: 0, lastPrice: 0, layers: 0 };

      const isOpen = (positionSide === "LONG" && side === "BUY")
        || (positionSide === "SHORT" && side === "SELL")
        || (positionSide === "BOTH" && Math.abs(pnl) <= 1e-8 && side);

      if (isOpen) {
        openOrders += 1;
        if (state.qty <= 1e-8) {
          initialNotionals.push(notional);
          state.layers = 1;
        } else {
          addNotionals.push(notional);
          state.layers += 1;
          const adverse = (positionSide === "LONG" && price < state.lastPrice)
            || (positionSide === "SHORT" && price > state.lastPrice);
          if (adverse) {
            adverseAdds += 1;
            if (state.lastPrice > 0 && price > 0) {
              const step = positionSide === "LONG"
                ? (state.lastPrice / price - 1) * 10000
                : (price / state.lastPrice - 1) * 10000;
              adverseStepBps.push(Math.abs(step));
            }
          }
        }
        state.qty += qty;
        if (price > 0) state.lastPrice = price;
        maxLayers = Math.max(maxLayers, state.layers);
      } else {
        closeOrders += 1;
        state.qty = Math.max(0, state.qty - qty);
        if (state.qty <= 1e-8) {
          state.qty = 0;
          state.layers = 0;
          state.lastPrice = 0;
        }
      }
      tracker.set(key, state);
    }

    const dominantSymbol = [...symbols.entries()].sort((a, b) => b[1] - a[1])[0];
    const dominantLeverage = [...leverages.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      openOrders,
      closeOrders,
      adverseAdds,
      adverseAddRate: safeDivide(adverseAdds, openOrders, 0),
      maxLayers,
      initialOrderMedian: median(initialNotionals),
      addOrderMedian: median(addNotionals),
      adverseStepMedianBps: median(adverseStepBps),
      dominantSymbol: dominantSymbol ? dominantSymbol[0] : "",
      dominantSymbolShare: dominantSymbol ? safeDivide(dominantSymbol[1], sorted.length, 0) : 0,
      dominantLeverage: dominantLeverage ? dominantLeverage[0] : "",
      sampleOrders: sorted.length
    };
  }

  function analyzeTransfers(transfers, losses, marginBalance) {
    const deposits = transfers.filter((item) => String(item.transType || item.type || "").includes("DEPOSIT"));
    const lossIntervals = losses
      .map((position) => ({
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
    return {
      depositCount: depositAmounts.length,
      depositTotal: depositAmounts.reduce((sum, value) => sum + value, 0),
      maxDeposit,
      lossPeriodDepositCount: lossPeriodDeposits.length,
      lossPeriodDepositTotal: lossPeriodAmount,
      maxDepositToMargin: safeDivide(maxDeposit, marginBalance, 0),
      lossPeriodDepositToMargin: safeDivide(lossPeriodAmount, marginBalance, 0),
      totalDepositToMargin: safeDivide(depositAmounts.reduce((sum, value) => sum + value, 0), marginBalance, 0)
    };
  }

  function analyzeLivePositions(livePositions, orderAnalysis, marginBalance) {
    const rows = Array.isArray(livePositions) ? livePositions : [];
    let openUnrealizedLoss = 0;
    let openUnrealizedProfit = 0;
    let openNotional = 0;
    const losingPositions = [];

    for (const position of rows) {
      const qty = num(firstDefined(position.positionAmount, position.pos, position.quantity, position.availPos), 0);
      const pnl = num(firstDefined(position.unrealizedProfit, position.pnl, position.upl), 0);
      const mark = num(firstDefined(position.markPrice, position.last, position.close), 0);
      let notional = Math.abs(num(firstDefined(position.notionalValue, position.notionalUsd, position.margin), 0));
      if (!notional && mark && qty) notional = Math.abs(qty * mark);
      if (Math.abs(qty) > 0 || notional > 0) {
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
      openCount: rows.length,
      losingOpenCount: losingPositions.length,
      openUnrealizedLoss,
      openUnrealizedProfit,
      openUnrealizedLossToMargin: safeDivide(openUnrealizedLoss, marginBalance, 0),
      openNotional,
      openNotionalToMargin: safeDivide(openNotional, marginBalance, 0),
      dominantOpenSymbols: rows.slice(0, 5).map((p) => String(firstDefined(p.symbol, p.instId, p.instIdCode, ""))).filter(Boolean),
      orderAnalysis
    };
  }

  function summarizeClosedPositions(positions, exchange) {
    const closed = Array.isArray(positions) ? positions : [];
    const getPnl = exchange === "OKX"
      ? (row) => num(row.pnl, 0)
      : binancePositionPnl;
    const getHold = exchange === "OKX"
      ? (row) => {
        const open = num(row.openTime, 0);
        const close = num(firstDefined(row.uTime, row.closeTime), 0);
        return open && close && close >= open ? (close - open) / HOUR_MS : 0;
      }
      : binanceHoldHours;

    const wins = [];
    const losses = [];
    const winHolds = [];
    const lossHolds = [];
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
        if (hold) winHolds.push(hold);
      } else if (pnl < 0) {
        losses.push(pnl);
        if (hold) lossHolds.push(hold);
      }
    }

    const dominantSymbol = [...symbols.entries()].sort((a, b) => b[1] - a[1])[0];
    const avgWin = safeDivide(wins.reduce((sum, value) => sum + value, 0), wins.length, 0);
    const avgLoss = safeDivide(losses.reduce((sum, value) => sum + value, 0), losses.length, 0);
    const winRate = safeDivide(wins.length, closed.length, 0);
    return {
      closedTrades: closed.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate,
      avgWin,
      avgLoss,
      payoffRatio: avgLoss < 0 ? avgWin / Math.abs(avgLoss) : null,
      expectancy: safeDivide(wins.reduce((sum, value) => sum + value, 0) + losses.reduce((sum, value) => sum + value, 0), closed.length, 0),
      avgWinHoldHours: safeDivide(winHolds.reduce((sum, value) => sum + value, 0), winHolds.length, 0),
      avgLossHoldHours: safeDivide(lossHolds.reduce((sum, value) => sum + value, 0), lossHolds.length, 0),
      maxLossHoldHours: lossHolds.length ? Math.max(...lossHolds) : 0,
      medianWinHoldHours: median(winHolds),
      medianLossHoldHours: median(lossHolds),
      lossHoldRatio: safeDivide(
        safeDivide(lossHolds.reduce((sum, value) => sum + value, 0), lossHolds.length, 0),
        Math.max(0.1, safeDivide(winHolds.reduce((sum, value) => sum + value, 0), winHolds.length, 0)),
        0
      ),
      dominantSymbol: dominantSymbol ? dominantSymbol[0] : "",
      dominantSymbolShare: dominantSymbol ? safeDivide(dominantSymbol[1], closed.length, 0) : 0,
      tpMedianBps: median(priceMoves.filter((value) => value > 0)),
      lossMoveP90Bps: percentile(priceMoves.filter((value) => value < 0).map(Math.abs), 90)
    };
  }

  function inferStrategy(summary, orders) {
    const labels = [];
    let family = "資料不足，暫不判定策略型態";
    const adverseRate = orders.adverseAddRate || 0;
    const highFrequency = orders.openOrders >= 200 || (summary.closedTrades >= 100 && summary.avgWinHoldHours < 3);
    const longLossHold = summary.avgLossHoldHours > Math.max(12, summary.avgWinHoldHours * 1.5);
    const poorPayoff = summary.payoffRatio !== null && summary.payoffRatio < 0.5;
    const strongPayoff = summary.payoffRatio !== null && summary.payoffRatio >= 1.5;

    if (adverseRate >= 0.35 && longLossHold) {
      family = "逆勢網格 / 類馬丁格爾";
      labels.push("逆勢加倉", "虧損持倉偏久");
    } else if (adverseRate >= 0.35 && strongPayoff && summary.avgLossHoldHours < 1) {
      family = "短線均值回歸 + 快速停損";
      labels.push("允許加倉", "虧損單快速結束");
    } else if (highFrequency && adverseRate < 0.1) {
      family = "批次拆單 / 短線 scalping";
      labels.push("高頻短線", "同價拆單");
    } else if (adverseRate >= 0.2) {
      family = "分層均值回歸";
      labels.push("分層加倉");
    } else if (summary.closedTrades >= 30 && summary.avgWinHoldHours > 24) {
      family = "低頻波段 / 持倉型";
      labels.push("持倉時間較長");
    }

    if (poorPayoff) labels.push("盈虧比偏弱");
    if (summary.winRate >= 0.95) labels.push("高勝率需驗證尾部風險");
    if (summary.dominantSymbolShare >= 0.5) labels.push("單一標的集中");
    return { family, labels: [...new Set(labels)] };
  }

  function buildVerdict(meta, summary, orders, transfers, live) {
    const evidence = [];
    const cautions = [];
    const positives = [];
    let level = "watch";
    let title = "觀察";

    const copierPnlToAum = safeDivide(meta.copierPnl, meta.aum, 0);
    const adverseRate = orders.adverseAddRate || 0;
    const poorPayoff = summary.payoffRatio !== null && summary.payoffRatio < 0.5;
    const destructiveMartingale = (
      adverseRate > 0.35
      && summary.avgLossHoldHours > 12
      && summary.lossHoldRatio > 1.5
    ) || (
      adverseRate > 0.50
      && poorPayoff
    ) || (
      adverseRate > 0.75
      && summary.winRate >= 0.98
      && summary.lossCount === 0
    );

    if (meta.days >= 30) positives.push(`交易天數約 ${meta.days.toFixed(0)} 天，已達最低觀察門檻。`);
    if (summary.closedTrades >= 50) positives.push(`已平倉樣本 ${summary.closedTrades} 筆，可初步判讀交易行為。`);
    if (summary.payoffRatio !== null && summary.payoffRatio >= 1) positives.push(`平均盈虧比 ${summary.payoffRatio.toFixed(2)}，不是典型贏小賠大。`);
    if (summary.avgLossHoldHours > 0 && summary.avgLossHoldHours < summary.avgWinHoldHours) positives.push("虧損單平均持倉短於獲利單，停損行為相對乾淨。");
    if (meta.days > 0 && meta.days < 30) cautions.push(`交易天數只有 ${meta.days.toFixed(1)} 天，還沒滿最低 30 天觀察門檻。`);
    if (!Number.isFinite(meta.roi)) cautions.push("全期間 ROI 目前無法可靠重建，不能只看頁面局部時間窗。");
    if (Number.isFinite(meta.roi) && !meta.allPeriodPerformance?.reliable) cautions.push("全期間 ROI 是用可取得資料重建，但歷史完整度或起始點仍需留意。");
    if (summary.closedTrades > 0 && summary.closedTrades < 30) cautions.push(`已平倉樣本只有 ${summary.closedTrades} 筆，單筆交易會嚴重影響結論。`);
    if (meta.mdd >= 30) cautions.push(`頁面/排行可見 MDD 約 ${formatPct(meta.mdd)}，新跟單者可能一開始就承受大回撤。`);
    if (summary.maxLossHoldHours >= 72) cautions.push(`歷史虧損單最長持倉 ${formatHours(summary.maxLossHoldHours)}，有死扛風險。`);
    if (poorPayoff) cautions.push(`平均盈虧比只有 ${summary.payoffRatio?.toFixed(2)}，代表平均虧損大於平均獲利。`);
    if (summary.winRate >= 0.98 && summary.lossCount <= 1 && summary.closedTrades >= 20) cautions.push("勝率接近 100% 且幾乎沒有已實現虧損，可能尚未被壓力行情測試。");
    if (orders.openOrders >= 300 && summary.avgWin > 0 && summary.avgWin <= 2) cautions.push("高頻微利型策略容易被跟單延遲、滑價、手續費吃掉。");
    if (adverseRate >= 0.35) cautions.push(`逆勢加倉率約 ${(adverseRate * 100).toFixed(0)}%，不利行情下會擴大同方向曝險。`);
    if (transfers.lossPeriodDepositCount > 0) cautions.push(`偵測到 ${transfers.lossPeriodDepositCount} 次虧損持倉期間資金轉入，跟單者未必能同步補保證金。`);
    if (live.openUnrealizedLossToMargin >= 0.05 || live.openUnrealizedLoss >= 5000) cautions.push(`目前持倉浮虧約 ${formatMoney(live.openUnrealizedLoss)}，約為帶單本金 ${(live.openUnrealizedLossToMargin * 100).toFixed(1)}%。`);
    if (copierPnlToAum <= -0.05 && meta.roi > 0) cautions.push(`帶單員帳面 ROI 為正，但跟單者 PnL/AUM 約 ${(copierPnlToAum * 100).toFixed(1)}%，可能有滑價、進場時點或倉位管理背離。`);
    if (meta.closeLeadCount >= 8) cautions.push(`歷史關閉項目 ${meta.closeLeadCount} 次，舊績效與現輪資料可能被切斷。`);

    if (transfers.lossPeriodDepositCount > 0) {
      level = "avoid";
      title = "不建議跟";
      evidence.push("虧損期補資金是跟單者最難複製的風險來源。");
    } else if (destructiveMartingale) {
      level = "avoid";
      title = "不建議跟";
      evidence.push("逆勢加倉、虧損持倉拖延或盈虧比失衡同時出現，類馬丁風險偏高。");
    } else if (live.openUnrealizedLossToMargin >= 0.20 || live.openUnrealizedLoss >= 50000) {
      level = "avoid";
      title = "暫不跟";
      evidence.push("目前有顯著浮虧倉位，新跟單者直接進場可能接下原本不屬於自己的風險。");
    } else if (meta.mdd >= 50) {
      level = "avoid";
      title = "高風險，不建議一般跟單";
      evidence.push("歷史回撤過大，除非只用極小攻擊倉且能承受連續虧損。");
    } else if (cautions.length >= 3 || meta.mdd >= 30 || adverseRate >= 0.35 || poorPayoff) {
      level = "risky";
      title = "高風險候補";
    } else if (meta.days >= 30 && summary.closedTrades >= 30) {
      level = "followable";
      title = "可小比例觀察";
    }

    return {
      level,
      title,
      positives,
      cautions,
      evidence
    };
  }

  function analyzeBinance(raw) {
    const pageMetrics = parseVisibleMetrics(raw.visibleText || "");
    const meta = extractBinanceMeta(raw, pageMetrics);
    const summary = summarizeClosedPositions(raw.positionHistory || [], "Binance");
    const orders = analyzeBinanceOrders(raw.orderHistory || []);
    const losses = (raw.positionHistory || []).filter((position) => binancePositionPnl(position) < 0);
    const transfers = analyzeTransfers(raw.transferHistory || [], losses, meta.marginBalance);
    const live = analyzeLivePositions(raw.livePositions || [], orders, meta.marginBalance);
    const strategy = inferStrategy(summary, orders);
    const verdict = buildVerdict(meta, summary, orders, transfers, live);
    return {
      platform: "Binance",
      generatedAt: new Date().toISOString(),
      meta,
      summary,
      orders,
      transfers,
      live,
      strategy,
      verdict,
      rawCounts: {
        positionHistory: (raw.positionHistory || []).length,
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
    return {
      name: String(firstDefined(candidate.nickName, candidate.nickname, raw.pageTitle, "Unknown OKX Lead")),
      id: raw.id,
      exchange: "OKX",
      url: raw.url,
      days: num(firstDefined(candidate.initialDay, pageMetrics.tradingDays), 0),
      roi: num(roi, 0),
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
      adverseStepMedianBps: 0,
      dominantSymbol: summary.dominantSymbol,
      dominantSymbolShare: summary.dominantSymbolShare,
      dominantLeverage: String(firstDefined(raw.candidate?.lever, "")),
      sampleOrders: 0
    };
    const transfers = {
      depositCount: 0,
      depositTotal: 0,
      maxDeposit: 0,
      lossPeriodDepositCount: 0,
      lossPeriodDepositTotal: 0,
      maxDepositToMargin: 0,
      lossPeriodDepositToMargin: 0,
      totalDepositToMargin: 0
    };
    const liveMargin = (raw.livePositions || []).reduce((sum, row) => sum + Math.abs(num(row.margin, 0)), 0);
    meta.marginBalance = liveMargin || meta.aum || 0;
    const live = analyzeLivePositions(raw.livePositions || [], orders, meta.marginBalance);
    const strategy = inferStrategy(summary, orders);
    const verdict = buildVerdict(meta, summary, orders, transfers, live);
    return {
      platform: "OKX",
      generatedAt: new Date().toISOString(),
      meta,
      summary,
      orders,
      transfers,
      live,
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
    formatPct,
    formatMoney,
    formatHours,
    num,
    int
  };
})(window);
