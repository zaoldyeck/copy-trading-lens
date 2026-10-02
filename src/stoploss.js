(function attachStopLoss(global) {
  "use strict";

  // Stop-loss radar: which stop level, if any, would have served a copier of this trader best.
  //
  // Binance's position stop-loss closes a copied position once its return on margin (ROE) falls
  // to -L% (AGENTS.md invariant 2). A stop at L therefore turns every position whose adverse ROE
  // reached L into a -L% outcome and leaves the rest at their realised ROI. It costs the winners
  // that dipped past L before recovering and saves the losers that kept going; which L is best is
  // a well-posed optimisation once an objective is fixed. This module fixes it and solves it on the
  // trader's own closed positions, instead of the old rule of thumb (winners' 95th-percentile
  // drawdown, rounded to 5, clamped to 30-85), which maximised nothing.
  //
  // Objective: expected log growth of the copier's equity. A position that commits a share f of
  // equity as margin moves equity by f x outcome, so the quantity that compounds is
  // E[log(1 + f x outcome)]. f is the lead's own margin share of equity at entry (a fixed-ratio
  // copier inherits it), read from the equity count-back (src/equity.js). Without it the
  // risk-neutral limit f -> 0, the mean outcome, is used and the result says so.
  //
  // Evidence behind the design (reports/stoploss-review-three-2026-10-02.txt, 玄冥二老,
  // 星辰社区-海, 熬鹰资本, in-sample on the true path): the shipped rule's stop cost 6.1 / 3.1 / 2.3
  // ROE points per position against no stop, and the growth-optimal answer was "no stop" or 95.

  const MINUTE_MS = 60000;
  const HOUR_MS = 3600000;
  const STOP_CANDIDATES = [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
  // 1 + f x outcome cannot fall below 1% of equity inside the log: a wipe-out is a large, finite penalty.
  const GROWTH_FLOOR = 0.01;
  const BOOTSTRAP_RESAMPLES = 300;
  const BOOTSTRAP_SEED = 20261002;
  // A candidate belongs to the stable band when it beats the sample's optimum in at least this share of resamples.
  const BAND_SHARE = 0.1;

  function num(value, fallback = 0) {
    if (value === null || value === undefined || value === "") return fallback;
    const parsed = Number(String(value).replace(/,/g, "").replace("%", ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function firstDefined(...values) {
    for (const value of values) {
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  }

  function percentile(values, p) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  }

  function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function firstAtOrAfter(rows, time) {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid][0] < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The candles that describe one position's own life, as [openTime, high, low] rows from
   * providers.js fetchBinancePositionMarks: minute candles that overlap [opened, closed] (the two
   * edge minutes may reach up to a minute outside it) and hourly candles that lie fully inside it.
   * An hourly candle only partly inside would lend the position the rest of its hour.
   */
  function lifeCandles(marks, openedMs, closedMs) {
    const candles = [];
    const minutes = marks?.minutes || [];
    const hours = marks?.hours || [];
    for (let i = firstAtOrAfter(minutes, openedMs - MINUTE_MS + 1); i < minutes.length && minutes[i][0] <= closedMs; i += 1) {
      candles.push({ time: minutes[i][0], step: MINUTE_MS, high: minutes[i][1], low: minutes[i][2] });
    }
    for (let i = firstAtOrAfter(hours, openedMs); i < hours.length && hours[i][0] + HOUR_MS <= closedMs; i += 1) {
      candles.push({ time: hours[i][0], step: HOUR_MS, high: hours[i][1], low: hours[i][2] });
    }
    return candles.sort((a, b) => a.time - b.time);
  }

  function lifeExtremes(marks, openedMs, closedMs) {
    const candles = lifeCandles(marks, openedMs, closedMs);
    if (!candles.length) return null;
    return { high: Math.max(...candles.map((c) => c.high)), low: Math.min(...candles.map((c) => c.low)) };
  }

  // Adverse price move in % of the entry: down for a long, up for a short, never negative.
  function adverseMove(isShort, entry, high, low) {
    return Math.max(0, ((isShort ? high - entry : entry - low) / entry) * 100);
  }

  /**
   * Worst adverse ROE (price move x leverage) of a position against the entry that held at each moment:
   * adds move the average entry, reductions do not. Every candle overlapping an interval is judged
   * against that interval's entry, and each fill's own price against the entry before it.
   * @returns {number|null} null when the fills do not begin with an opening fill (history starts mid-position)
   */
  function pathExcursion({ fills, isShort, candles, closedMs }) {
    const direction = isShort ? -1 : 1;
    if (!fills.length || fills[0].sign !== direction) return null; // history begins mid-position
    let qty = 0;
    let entry = 0;
    let worst = 0;
    // A candle that opens at the very instant of a fill belongs to the entry after it, not before.
    const judge = (fromMs, toMs, lastInterval) => {
      for (const candle of candles) {
        if (lastInterval ? candle.time > toMs : candle.time >= toMs) break;
        if (candle.time + candle.step > fromMs) worst = Math.max(worst, adverseMove(isShort, entry, candle.high, candle.low));
      }
    };
    let last = fills[0].time;
    for (const fill of fills) {
      if (qty > 1e-12) {
        judge(last, fill.time);
        worst = Math.max(worst, adverseMove(isShort, entry, fill.price, fill.price));
      }
      if (fill.sign === direction) {
        entry = (qty * entry + fill.qty * fill.price) / (qty + fill.qty);
        qty += fill.qty;
      } else {
        qty = Math.max(0, qty - fill.qty);
      }
      last = fill.time;
    }
    if (qty > 1e-12) judge(last, closedMs, true);
    return worst;
  }

  // Fills become positions in one place, src/positions.js (hedge books, one-way flips that split a fill into the
  // part that closes and the part that opens). Each replayed position carries its fills tagged entry or exit with
  // their exact quantities; a row of position history is matched to the replayed position of its side whose first
  // fill lands within seconds of the row's open (a row can open ~6 s before its own first fill's clock: the
  // 2026-09 CLUSDT row in src/analysis.js biggestBetOf).
  const MATCH_SLACK_MS = 15000;

  function replayedPositions(orders) {
    const P = global.CopyTradingLensPositions;
    const bySymbol = new Map();
    const books = new Map();
    for (const order of orders || []) {
      if (!(P.fillTimeOf(order) > 0)) continue;
      const key = P.bucketKeyOf(String(order.symbol || ""), order.positionSide);
      if (!books.has(key)) books.set(key, []);
      books.get(key).push(order);
    }
    for (const [key, fills] of books) {
      const symbol = P.symbolOfKey(key);
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, []);
      for (const replayed of P.replayPositions(key, fills).positions) {
        bySymbol.get(symbol).push({
          side: replayed.side,
          fills: replayed.fills.map((fill) => ({
            time: P.fillTimeOf(fill.order),
            price: num(firstDefined(fill.order.avgPrice, fill.order.fillPx, fill.order.price)),
            qty: fill.qty,
            entry: fill.entry
          }))
        });
      }
    }
    return bySymbol;
  }

  function fillsOfRow(replayed, symbol, side, openedMs) {
    let best = null;
    for (const candidate of replayed.get(symbol) || []) {
      if (candidate.side !== side || !candidate.fills.length) continue;
      const gap = Math.abs(candidate.fills[0].time - openedMs);
      if (gap <= MATCH_SLACK_MS && (!best || gap < best.gap)) best = { gap, fills: candidate.fills };
    }
    return best ? best.fills : null;
  }

  /**
   * One row per CLOSED position: its realised ROI and the deepest adverse ROE it went through.
   * Open rows have no outcome yet and are left to the caller (analyzeStopLossRadar sets them apart).
   *
   * @param {object[]} positions position-history rows
   * @param {object[]} orders    order-history fills (the entry path needs them; only ~2 months exist)
   * @param {{symbols: Record<string, {minutes: number[][], hours: number[][]}>, failed: object[]}|null} positionMarks
   * @returns {{symbol: string, side: string, leverage: number, closingPnl: number, roiPct: number, margin: number,
   *   maeRoe: number, entryPathUsed: boolean, marksUsed: boolean, opened: number, closed: number}[]}
   */
  function positionExcursions(positions, orders, positionMarks) {
    const replayed = replayedPositions(orders);
    const rows = [];
    for (const position of positions || []) {
      const avgCost = num(position.avgCost);
      const closed = num(firstDefined(position.closed, position.uTime, position.closeTime));
      const opened = num(firstDefined(position.opened, position.openTime));
      if (!(avgCost > 0) || !(opened > 0) || !(closed >= opened)) continue;
      const symbol = String(firstDefined(position.symbol, position.instId, ""));
      const leverage = Math.max(1, num(firstDefined(position.leverage, position.lever), 1));
      const isShort = String(position.side || "LONG").toUpperCase().includes("SHORT");
      const closingPnl = num(firstDefined(position.closingPnl, position.pnl));
      const roi = num(position.roi);
      const avgClose = num(position.avgClosePrice);
      const candles = lifeCandles(positionMarks?.symbols?.[symbol], opened, closed);
      const direction = isShort ? -1 : 1;
      const rowFills = fillsOfRow(replayed, symbol, isShort ? "SHORT" : "LONG", opened);

      let adverse = rowFills
        ? pathExcursion({ fills: rowFills.map((fill) => ({ ...fill, sign: fill.entry ? direction : -direction })), isShort, candles, closedMs: closed })
        : null;
      const entryPathUsed = adverse !== null;
      if (!entryPathUsed) {
        // No replayable fills (older than the ~2 months Binance keeps): judge against the final average cost.
        adverse = avgClose > 0 ? adverseMove(isShort, avgCost, avgClose, avgClose) : 0;
        for (const candle of candles) adverse = Math.max(adverse, adverseMove(isShort, avgCost, candle.high, candle.low));
      }
      // `roi` is a fraction of initial margin at any magnitude ("1.2" = +120%); see
      // scripts/test-stop-loss-radar.mjs for the corpus check behind this. Binance's closingPnl, and so roi,
      // is the trade pnl PLUS funding, less fees (src/equity.js), while the stop acts on price-only ROE: prices
      // give the drawdown, roi the outcome. A short held through extreme negative funding can finish negative
      // while its price moved its way (TAIKOUSDT 2026-07-02: +70 USDT on price, -169 funding, -91 reported).
      // That is a correct row, not an error.
      rows.push({
        symbol,
        side: isShort ? "SHORT" : "LONG",
        leverage,
        closingPnl,
        roiPct: roi * 100,
        margin: roi !== 0 ? Math.abs(closingPnl / roi) : (num(position.maxOpenInterest) * avgCost) / leverage,
        maeRoe: adverse * leverage,
        entryPathUsed,
        marksUsed: candles.length > 0,
        opened,
        closed
      });
    }
    return rows;
  }

  // The lead's own share of equity committed as margin at entry, 0..1; null without an equity count-back.
  function marginShares(rows, equity) {
    if (!equity || typeof equity.equityAt !== "function") return null;
    return rows.map((row) => {
      const account = equity.equityAt(row.opened);
      return row.margin > 0 ? row.margin / Math.max(Number.isFinite(account) ? account : 0, row.margin) : 0;
    });
  }

  const outcomeAt = (row, stop) => (stop !== null && row.maeRoe >= stop ? -stop : row.roiPct);

  // Seeded generator: the same positions always give the same stability figure.
  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  /**
   * Best stop level by expected log growth (or, without sizing, by mean outcome), with how stable
   * that answer is. Candidates are "no stop" (null) and 10..95 step 5, Binance's 0-95% field.
   * @param {object[]} rows positionExcursions rows
   * @param {{equityAt: function}|null} equity
   */
  function selectStop(rows, equity) {
    const shares = marginShares(rows, equity);
    const objective = shares ? "growth" : "meanRoe";
    const candidates = [null, ...STOP_CANDIDATES];
    const terms = candidates.map((stop) => rows.map((row, i) => {
      const outcome = outcomeAt(row, stop);
      return shares ? Math.log(Math.max(GROWTH_FLOOR, 1 + (shares[i] * outcome) / 100)) : outcome;
    }));
    const score = terms.map(mean);
    // ties go to the looser stop: it is the one that gives up less
    const bestOf = (values) => values.reduce((best, value, i) => (value > values[best] + 1e-12 ? i : best), 0);
    const optimalIndex = bestOf(score);
    const bestStopIndex = 1 + bestOf(score.slice(1));

    const random = seededRandom(BOOTSTRAP_SEED);
    const wins = new Array(candidates.length).fill(0);
    let sameOptimum = 0;
    for (let b = 0; b < BOOTSTRAP_RESAMPLES; b += 1) {
      const sums = new Array(candidates.length).fill(0);
      for (let k = 0; k < rows.length; k += 1) {
        const pick = Math.floor(random() * rows.length);
        for (let c = 0; c < candidates.length; c += 1) sums[c] += terms[c][pick];
      }
      if (bestOf(sums) === optimalIndex) sameOptimum += 1;
      for (let c = 0; c < candidates.length; c += 1) if (sums[c] > sums[optimalIndex]) wins[c] += 1;
    }
    const inBand = candidates.map((_, c) => c === optimalIndex || wins[c] / BOOTSTRAP_RESAMPLES >= BAND_SHARE);

    const curve = candidates.map((stop, c) => ({
      stop,
      score: score[c],
      meanRoe: mean(rows.map((row) => outcomeAt(row, stop))),
      killedWins: stop === null ? 0 : rows.filter((row) => row.closingPnl > 0 && row.maeRoe >= stop).length,
      stoppedLosses: stop === null ? 0 : rows.filter((row) => row.closingPnl < 0 && row.maeRoe >= stop).length,
      worstOutcome: Math.min(...rows.map((row) => outcomeAt(row, stop)))
    }));
    const stable = candidates.filter((_, c) => inBand[c]);
    return {
      objective,
      sizing: shares
        ? { source: "leadEquity", medianShare: percentile(shares, 50), p90Share: percentile(shares, 90) }
        : { source: "none" },
      optimal: candidates[optimalIndex],
      bestStop: candidates[bestStopIndex],
      costOfBestStop: score[optimalIndex] - score[bestStopIndex],
      bandIncludesNone: inBand[0],
      band: stable.filter((stop) => stop !== null),
      bootstrapAgreement: sameOptimum / BOOTSTRAP_RESAMPLES,
      curve
    };
  }

  const stats = (values) => ({
    median: percentile(values, 50),
    p50: percentile(values, 50),
    p75: percentile(values, 75),
    p90: percentile(values, 90),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : 0
  });
  const rounded = (s) => Object.fromEntries(Object.entries(s).map(([key, value]) => [key, Number(value.toFixed(1))]));

  // Nothing in it may pass for a result: the UI shows an explanation, never these numbers.
  function emptyRadar() {
    return {
      insufficientData: true,
      positionCount: 0,
      dominantLeverage: null,
      recommendedRoe: null,
      recommendedPriceDrop: null,
      stopOptional: false,
      winRetentionRate: null,
      killedWinsCount: null,
      stoppedLossesCount: null,
      hasSevereBagHolding: false,
      worstHistoricalRoeMae: null,
      allStats: null,
      winStats: null,
      lossStats: null,
      marksCoverage: 0,
      entryPathPositions: 0,
      stopSelection: null
    };
  }

  /**
   * @param {object[]} positions position-history rows (open rows are set aside)
   * @param {object[]} orders    order-history fills
   * @param {object|null} positionMarks providers.js fetchBinancePositionMarks result
   * @param {{equityAt: function}|null} equity equity count-back for the margin share at entry
   */
  function analyzeStopLossRadar(positions, orders = [], positionMarks = null, equity = null) {
    const rows = positionExcursions(positions, orders, positionMarks);
    if (rows.length < 3) return emptyRadar();

    const wins = rows.filter((row) => row.closingPnl > 0);
    const losses = rows.filter((row) => row.closingPnl < 0);
    const selection = selectStop(rows, equity);
    const recommendedRoe = selection.optimal === null ? selection.bestStop : selection.optimal;
    const dominantLeverage = Math.round(percentile(rows.map((row) => row.leverage), 50)) || 5;
    const killedWins = wins.filter((row) => row.maeRoe >= recommendedRoe).length;
    const lossStats = stats(losses.map((row) => row.maeRoe));
    const marksCoverage = rows.filter((row) => row.marksUsed).length / rows.length;

    return {
      insufficientData: false,
      positionCount: rows.length,
      dominantLeverage,
      recommendedRoe,
      recommendedPriceDrop: Number((recommendedRoe / dominantLeverage).toFixed(1)),
      // the data cannot tell a stop from no stop: the optimum is "none", or "none" sits in the stable band
      stopOptional: selection.optimal === null || selection.bandIncludesNone,
      winRetentionRate: Number((wins.length ? ((wins.length - killedWins) / wins.length) * 100 : 100).toFixed(1)),
      killedWinsCount: killedWins,
      stoppedLossesCount: losses.filter((row) => row.maeRoe >= recommendedRoe).length,
      hasSevereBagHolding: lossStats.max >= 100 || losses.some((row) => row.roiPct <= -100),
      worstHistoricalRoeMae: Number(lossStats.max.toFixed(1)),
      allStats: rounded(stats(rows.map((row) => row.maeRoe))),
      winStats: rounded(stats(wins.map((row) => row.maeRoe))),
      lossStats: rounded(lossStats),
      marksCoverage,
      entryPathPositions: rows.filter((row) => row.entryPathUsed).length,
      stopSelection: selection
    };
  }

  global.CopyTradingLensStopLoss = {
    analyzeStopLossRadar,
    positionExcursions,
    selectStop,
    lifeCandles,
    lifeExtremes,
    STOP_CANDIDATES
  };
})(window);
