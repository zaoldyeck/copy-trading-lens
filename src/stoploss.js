(function attachStopLoss(global) {
  "use strict";

  // Stop-loss radar: which stop level, if any, would have served a copier of this trader best.
  //
  // Binance's position stop-loss closes a copied position once its return on margin (ROE) falls to -L%
  // (AGENTS.md invariant 2). Which L is best is a well-posed optimisation once an objective is fixed; this module
  // fixes one and solves it on the trader's own history.
  //
  // The backtest is a SIMULATION OF THE COPIER, not an adjustment of each lead position to "-L% of its margin":
  // the copier mirrors the lead's fills, its stop fires on the position as it was at that moment (a small early
  // margin when the lead is still scaling in), and what happens to the lead's later fills depends on a Binance
  // behaviour its FAQ does not document (whether a stopped copier keeps following the lead's adds). Both readings
  // are simulated and a stop must hold up under the worse one. Treating each position as one unit overstated the
  // cost of every stop for traders who add to positions (tools/research/stoploss-copier-sim.mjs, 2026-10-02:
  // 玄冥二老 has adds in 91 of 138 replayable positions).
  //
  // Objective: expected log growth of the copier's equity, mean(log(1 + pnl / equity at entry)), with pnl in the
  // lead's USDT and equity from the equity count-back (src/equity.js; a fixed-ratio copier inherits the lead's
  // proportions). Without it the risk-neutral limit, total pnl, is used and the result says so. A stop only counts
  // as better than none when it is better under BOTH readings.
  //
  // Evidence (reports/stoploss-review-three-2026-10-02.txt): on 玄冥二老, 星辰社区-海 and 熬鹰资本 no stop level beat
  // "no stop" under either reading; the old rule of thumb (winners' 95th-percentile drawdown) maximised nothing.

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
   * @returns {{symbol: string, side: string, leverage: number, closingPnl: number, roiPct: number, maeRoe: number,
   *   entryPathUsed: boolean, marksUsed: boolean, opened: number, closed: number, sim: object|null}[]}
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
        maeRoe: adverse * leverage,
        entryPathUsed,
        marksUsed: candles.length > 0,
        opened,
        closed,
        // what the copier simulation replays: the position's own fills, the candle path, direction and leverage
        sim: rowFills ? { fills: rowFills, direction, leverage, candles } : null
      });
    }
    return rows;
  }

  // A stop at `stop` (null: none) on one position as the copier would have lived it. The copier mirrors every
  // fill at ratio 1 (so USDT are the lead's); between fills its ROE (price move from ITS OWN average entry x
  // leverage) is judged against every candle, and the first candle that reaches -stop closes the whole copier
  // position at exactly -stop of ITS margin then. `follow` is the undocumented part: false, the copier stays out
  // of that lead position until it is closed; true, the lead's later entries open it again. Funding and fees are
  // left out of both sides; the outcome is price pnl and the margin the position peaked at.
  function simulateCopier(sim, stop, follow) {
    const { fills, direction, leverage, candles } = sim;
    let qty = 0;
    let entry = 0;
    let pnl = 0;
    let out = false;
    let peakMargin = 0;
    const judge = (fromMs, toMs, lastInterval) => {
      if (stop === null || qty <= 1e-12) return;
      for (const candle of candles) {
        if (lastInterval ? candle.time > toMs : candle.time >= toMs) break;
        if (candle.time + candle.step <= fromMs) continue;
        const adverse = ((direction > 0 ? entry - candle.low : candle.high - entry) / entry) * 100 * leverage;
        if (adverse >= stop) {
          pnl += (-stop / 100) * ((qty * entry) / leverage);
          qty = 0;
          out = true;
          return;
        }
      }
    };
    let last = fills[0].time;
    for (const fill of fills) {
      judge(last, fill.time, false);
      last = fill.time;
      if (fill.entry) {
        if (out && !follow) continue;
        entry = qty > 0 ? (qty * entry + fill.qty * fill.price) / (qty + fill.qty) : fill.price;
        qty += fill.qty;
        out = false;
        peakMargin = Math.max(peakMargin, (qty * entry) / leverage);
      } else if (qty > 0) {
        const reduced = Math.min(qty, fill.qty);
        pnl += (fill.price - entry) * direction * reduced;
        qty -= reduced;
      }
    }
    judge(last, last + HOUR_MS, true);
    return { pnl, peakMargin };
  }

  // Seeded generator: the same positions always give the same stability figure.
  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  const READINGS = [false, true]; // follow: the copier stays out | follows the lead's later entries

  /**
   * Best stop level, with how stable that answer is. Candidates are "no stop" (null) and 10..95 step 5, Binance's
   * 0-95% field. Only positions whose fills can be replayed are simulated (Binance keeps ~2 months of fills).
   * @param {object[]} rows positionExcursions rows
   * @param {{equityAt: function}|null} equity
   * @returns {object|null} null when fewer than 3 positions can be simulated
   */
  function selectStop(rows, equity) {
    const sims = rows.filter((row) => row.sim && row.marksUsed);
    if (sims.length < 3) return null;
    const candidates = [null, ...STOP_CANDIDATES];
    const none = sims.map((row) => simulateCopier(row.sim, null, true));
    // pnl[reading][candidate][position]
    const pnl = READINGS.map((follow) => candidates.map((stop, c) => sims.map((row, i) => {
      if (stop === null || row.maeRoe < stop) return none[i].pnl; // its path never reaches the stop
      return simulateCopier(row.sim, stop, follow).pnl;
    })));
    const accounts = equity && typeof equity.equityAt === "function"
      ? sims.map((row, i) => Math.max(equity.equityAt(row.opened) || 0, none[i].peakMargin, 1e-9))
      : null;
    const objective = accounts ? "growth" : "pnl";
    const terms = pnl.map((byCandidate) => byCandidate.map((byPosition) => byPosition.map((value, i) => (
      accounts ? Math.log(Math.max(GROWTH_FLOOR, 1 + value / accounts[i])) : value
    ))));
    const scores = terms.map((byCandidate) => byCandidate.map(mean));
    // a stop's standing is its worse reading; "no stop" is the same under both
    const score = candidates.map((_, c) => Math.min(...scores.map((byCandidate) => byCandidate[c])));
    // Ties go to the lower index: "no stop" over any stop, and among stops the tighter one, since equal cost buys more
    // protection (a stop that never triggers in the history is free insurance).
    const bestOf = (values) => values.reduce((best, value, i) => (value > values[best] + 1e-12 ? i : best), 0);
    const optimalIndex = bestOf(score);
    const bestStopIndex = 1 + bestOf(score.slice(1));

    const random = seededRandom(BOOTSTRAP_SEED);
    const beatsOptimum = new Array(candidates.length).fill(0);
    let sameOptimum = 0;
    for (let b = 0; b < BOOTSTRAP_RESAMPLES; b += 1) {
      const sums = terms.map(() => new Array(candidates.length).fill(0));
      for (let k = 0; k < sims.length; k += 1) {
        const pick = Math.floor(random() * sims.length);
        for (let r = 0; r < sums.length; r += 1) for (let c = 0; c < candidates.length; c += 1) sums[r][c] += terms[r][c][pick];
      }
      const combined = candidates.map((_, c) => Math.min(...sums.map((bySymbol) => bySymbol[c])));
      if (bestOf(combined) === optimalIndex) sameOptimum += 1;
      for (let c = 0; c < candidates.length; c += 1) {
        if (combined[c] > combined[optimalIndex]) beatsOptimum[c] += 1;
      }
    }
    const inBand = candidates.map((_, c) => c === optimalIndex || beatsOptimum[c] / BOOTSTRAP_RESAMPLES >= BAND_SHARE);
    const total = (readingIndex, c) => pnl[readingIndex][c].reduce((a, value) => a + value, 0);
    const curve = candidates.map((stop, c) => ({
      stop,
      score: score[c],
      pnlStayOut: total(0, c),
      pnlFollow: total(1, c),
      triggered: stop === null ? 0 : sims.filter((row) => row.maeRoe >= stop).length
    }));
    const stable = candidates.filter((_, c) => inBand[c]);
    return {
      objective,
      sizing: accounts
        ? { source: "leadEquity", medianShare: percentile(sims.map((_, i) => none[i].peakMargin / accounts[i]), 50), p90Share: percentile(sims.map((_, i) => none[i].peakMargin / accounts[i]), 90) }
        : { source: "none" },
      simulatedPositions: sims.length,
      optimal: candidates[optimalIndex],
      // when "no stop" is not beaten, the stop worth buying as insurance is the one that costs least
      insuranceStop: candidates[bestStopIndex],
      costOfInsurance: score[optimalIndex] - score[bestStopIndex],
      bandIncludesNone: inBand[0],
      band: stable.filter((stop) => stop !== null),
      bootstrapAgreement: sameOptimum / BOOTSTRAP_RESAMPLES,
      curve,
      // kept for tradeoffOf: the per-position money of the shown stop under each reading
      _sims: sims,
      _none: none,
      _pnl: pnl,
      _candidates: candidates
    };
  }

  // What the shown stop would have done to the copier on this trader's own history, in money (the lead's USDT) and
  // in positions: how many it would have triggered on, how many of those it helped and by how much, how many it
  // hurt and by how much. Counted under the reading that is worse for the stop; the other reading's total is kept so
  // the card can show the range.
  function tradeoffOf(selection, stop) {
    const c = selection._candidates.indexOf(stop);
    const noneIndex = 0;
    const readingTotals = [0, 1].map((r) => selection._pnl[r][c].reduce((a, value) => a + value, 0));
    const worse = readingTotals[0] <= readingTotals[1] ? 0 : 1;
    let helped = 0;
    let hurt = 0;
    let helpedUsdt = 0;
    let hurtUsdt = 0;
    selection._sims.forEach((row, i) => {
      const delta = selection._pnl[worse][c][i] - selection._pnl[worse][noneIndex][i];
      if (Math.abs(delta) < 1e-9) return;
      if (delta > 0) { helped += 1; helpedUsdt += delta; } else { hurt += 1; hurtUsdt += delta; }
    });
    const returns = selection._sims.map((row, i) => (selection._none[i].peakMargin > 0 ? (selection._none[i].pnl / selection._none[i].peakMargin) * 100 : 0));
    let worstIndex = 0;
    returns.forEach((value, i) => { if (value < returns[worstIndex]) worstIndex = i; });
    const worstRow = selection._sims[worstIndex];
    return {
      stop,
      positions: selection._sims.length,
      triggered: selection._sims.filter((row) => row.maeRoe >= stop).length,
      helped,
      helpedUsdt,
      hurt,
      hurtUsdt,
      pnlNone: selection._pnl[0][noneIndex].reduce((a, value) => a + value, 0),
      pnlStopWorse: readingTotals[worse],
      pnlStopBetter: readingTotals[1 - worse],
      worstLoss: { symbol: worstRow.symbol, leverage: worstRow.leverage, returnPct: returns[worstIndex], maeRoe: worstRow.maeRoe }
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
  function emptyRadar(positionCount = 0) {
    return {
      insufficientData: true,
      positionCount,
      simulatedPositions: 0,
      dominantLeverage: null,
      recommendedRoe: null,
      recommendedPriceDrop: null,
      stopOptional: false,
      winRetentionRate: null,
      tradeoff: null,
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
   * @param {object[]} orders    order-history fills (the copier simulation replays them)
   * @param {object|null} positionMarks providers.js fetchBinancePositionMarks result
   * @param {{equityAt: function}|null} equity equity count-back for the account size at entry
   */
  function analyzeStopLossRadar(positions, orders = [], positionMarks = null, equity = null) {
    const rows = positionExcursions(positions, orders, positionMarks);
    const selection = rows.length >= 3 ? selectStop(rows, equity) : null;
    if (!selection) return emptyRadar(rows.length);

    const wins = rows.filter((row) => row.closingPnl > 0);
    const losses = rows.filter((row) => row.closingPnl < 0);
    const recommendedRoe = selection.optimal === null ? selection.insuranceStop : selection.optimal;
    const dominantLeverage = Math.round(percentile(rows.map((row) => row.leverage), 50)) || 5;
    const simulatedWins = selection._sims.filter((row, i) => selection._none[i].pnl > 0);
    const keptWins = simulatedWins.filter((row) => row.maeRoe < recommendedRoe).length;
    const lossStats = stats(losses.map((row) => row.maeRoe));
    const marksCoverage = rows.filter((row) => row.marksUsed).length / rows.length;
    const tradeoff = tradeoffOf(selection, recommendedRoe);
    // the per-position scratch of the simulation stays out of the result
    const { _sims, _none, _pnl, _candidates, ...stopSelection } = selection;

    return {
      insufficientData: false,
      positionCount: rows.length,
      simulatedPositions: selection.simulatedPositions,
      dominantLeverage,
      recommendedRoe,
      recommendedPriceDrop: Number((recommendedRoe / dominantLeverage).toFixed(1)),
      // the data cannot tell a stop from no stop: the optimum is "none", or "none" sits in the stable band
      stopOptional: selection.optimal === null || selection.bandIncludesNone,
      winRetentionRate: Number((simulatedWins.length ? (keptWins / simulatedWins.length) * 100 : 100).toFixed(1)),
      tradeoff,
      hasSevereBagHolding: lossStats.max >= 100 || losses.some((row) => row.roiPct <= -100),
      worstHistoricalRoeMae: Number(lossStats.max.toFixed(1)),
      allStats: rounded(stats(rows.map((row) => row.maeRoe))),
      winStats: rounded(stats(wins.map((row) => row.maeRoe))),
      lossStats: rounded(lossStats),
      marksCoverage,
      entryPathPositions: rows.filter((row) => row.entryPathUsed).length,
      stopSelection
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
