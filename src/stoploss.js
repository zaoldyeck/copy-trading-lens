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
  // Objective: historical per-position log utility, mean(log(1 + pnl / equity at entry)), with pnl in the
  // lead's USDT and equity from the equity count-back (src/equity.js; a fixed-ratio copier inherits the lead's
  // proportions as a sizing approximation, not a chronological portfolio return). Without usable equity,
  // total price pnl is used and the result says so. Four declared model readings cover follow/no-follow after
  // a stop and conservative branching over unknown intrabar timing. The lowest reading determines each candidate's score.
  // Fees, funding, execution delay and slippage are unavailable counterfactuals, never implied to be zero in reality.
  //
  // Reproduce sample results with scripts/review-stoploss-optimum.mjs. Admission and execution assumptions
  // affect the optimum; never freeze a trader's prior result into a recommendation. A percentile is not an objective.

  const MINUTE_MS = 60000;
  const HOUR_MS = 3600000;
  // User-facing policy domain: integer ROE percentages, 1..95; null means disabled (the form's 0).
  const STOP_CANDIDATES = Array.from({ length: 95 }, (_, i) => i + 1);
  const BOOTSTRAP_RESAMPLES = 300;
  const BOOTSTRAP_SEED = 20261002;
  // A resampling alternative ties or beats the sample's optimum in at least this share of resamples.
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
    for (let i = firstAtOrAfter(minutes, openedMs - MINUTE_MS + 1); i < minutes.length && minutes[i][0] < closedMs; i += 1) {
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
  function pathExcursion({ fills, isShort, candles, closedMs, favorable = false }) {
    const direction = isShort ? -1 : 1;
    if (!fills.length || fills[0].sign !== direction) return null; // history begins mid-position
    let qty = 0;
    let entry = 0;
    let worst = 0;
    // A candle that opens at the very instant of a fill belongs to the entry after it, not before.
    const judge = (fromMs, toMs, lastInterval) => {
      for (const candle of candles) {
        if (lastInterval ? candle.time > toMs : candle.time >= toMs) break;
        if (candle.time + candle.step > fromMs) worst = Math.max(worst, adverseMove(favorable ? !isShort : isShort, entry, candle.high, candle.low));
      }
    };
    let last = fills[0].time;
    for (const fill of fills) {
      if (qty > 1e-12) {
        judge(last, fill.time);
        worst = Math.max(worst, adverseMove(favorable ? !isShort : isShort, entry, fill.price, fill.price));
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
          closed: replayed.closed,
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

  function fillsOfRow(replayed, symbol, side, openedMs, closedMs, position) {
    const matches = [];
    for (const candidate of replayed.get(symbol) || []) {
      if (candidate.side !== side || !candidate.closed || !candidate.fills.length) continue;
      const gap = Math.abs(candidate.fills[0].time - openedMs);
      if (gap > MATCH_SLACK_MS || Math.abs(candidate.fills.at(-1).time - closedMs) > MATCH_SLACK_MS) continue;
      let qty = 0; let peak = 0; let exited = 0;
      for (const fill of candidate.fills) {
        qty += fill.entry ? fill.qty : -fill.qty;
        peak = Math.max(peak, qty);
        if (!fill.entry) exited += fill.qty;
      }
      const sameQty = (a, b) => global.CopyTradingLensPositions.toScaledQty(a) === global.CopyTradingLensPositions.toScaledQty(b);
      if (position.maxOpenInterest != null && !sameQty(peak, position.maxOpenInterest)) continue;
      if (position.closedVolume != null && !sameQty(exited, position.closedVolume)) continue;
      if (candidate.fills.some((fill) => !(fill.price > 0) || !(fill.qty > 0))) continue;
      matches.push(candidate);
    }
    // Never assign the same approximate opening clock to an ambiguous position.
    return matches.length === 1 ? matches[0].fills : null;
  }

  function candlesCover(candles, opened, closed) {
    let through = opened;
    for (const candle of candles) {
      if (candle.time > through) return false;
      through = Math.max(through, candle.time + candle.step);
      if (through >= closed) return true;
    }
    return false;
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
      const rowFills = fillsOfRow(replayed, symbol, isShort ? "SHORT" : "LONG", opened, closed, position);

      let adverse = rowFills
        ? pathExcursion({ fills: rowFills.map((fill) => ({ ...fill, sign: fill.entry ? direction : -direction })), isShort, candles, closedMs: closed })
        : null;
      const entryPathUsed = adverse !== null;
      let favorable = rowFills
        ? pathExcursion({ fills: rowFills.map((fill) => ({ ...fill, sign: fill.entry ? direction : -direction })), isShort, candles, closedMs: closed, favorable: true })
        : null;
      if (!entryPathUsed) {
        // No replayable fills (older than the ~2 months Binance keeps): judge against the final average cost.
        adverse = avgClose > 0 ? adverseMove(isShort, avgCost, avgClose, avgClose) : 0;
        for (const candle of candles) adverse = Math.max(adverse, adverseMove(isShort, avgCost, candle.high, candle.low));
        favorable = avgClose > 0 ? adverseMove(!isShort, avgCost, avgClose, avgClose) : 0;
        for (const candle of candles) favorable = Math.max(favorable, adverseMove(!isShort, avgCost, candle.high, candle.low));
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
        mfeRoe: favorable * leverage,
        entryPathUsed,
        marksUsed: candles.length > 0,
        marksComplete: candlesCover(candles, opened, closed),
        opened,
        closed,
        // what the copier simulation replays: the position's own fills, the candle path, direction and leverage
        sim: rowFills ? { fills: rowFills, direction, leverage, candles, closed } : null
      });
    }
    return rows;
  }

  // A stop at `stop` (null: none) on one position as the copier would have lived it. The copier mirrors every
  // fill at ratio 1 (so USDT are the lead's); between fills its ROE (price move from ITS OWN average entry x
  // leverage) is judged against MARK candles. A trigger closes the whole copier at exactly -stop of ITS margin
  // then, under the disclosed exact-threshold assumption. `follow` is undocumented: false, the copier stays out
  // of that lead position until it is closed; true, the lead's later entries open it again. Funding and fees are
  // left out of both sides; the outcome is price pnl and the margin the position peaked at.
  const intervalCache = new WeakMap();

  function intervalsOf(sim) {
    if (intervalCache.has(sim)) return intervalCache.get(sim);
    const intervals = sim.fills.map((fill, i) => {
      const from = i === 0 ? fill.time : sim.fills[i - 1].time;
      const to = fill.time;
      if (to <= from) return [];
      return sim.candles.filter((candle) => candle.time < to && candle.time + candle.step > from)
        .map((candle) => ({ ...candle, definite: candle.time >= from && candle.time + candle.step <= to }));
    });
    intervalCache.set(sim, intervals);
    return intervals;
  }

  function simulateCopier(sim, stop, follow, optimisticTiming = false) {
    const { fills, direction, leverage } = sim;
    const intervals = intervalsOf(sim);
    let leadQty = 0n;
    // All histories which leave the same last restart have the same future quantity/entry. Keep only their
    // lowest (or highest) PnL: log utility is increasing in PnL, so this is an exact dominance reduction.
    // On a candle crossing a fill, allow either a stop or no stop. Fully contained candles force the trigger.
    // This relaxes OHLC chronology: the lower result is conservative, not a claimed realised tick path.
    let states = [{ qty: 0, entry: 0, pnl: 0, out: false, peakMargin: 0, triggers: 0, minTriggers: 0, maxTriggers: 0, restart: -1 }];
    const better = (a, b) => optimisticTiming ? a.pnl > b.pnl : a.pnl < b.pnl;
    for (let i = 0; i < fills.length; i += 1) {
      const fill = fills[i];
      const branched = [];
      for (const state of states) {
        if (stop === null || state.qty <= 0) { branched.push(state); continue; }
        const price = state.entry * (1 - direction * stop / (100 * leverage));
        const crossing = intervals[i].filter((candle) => direction > 0 ? candle.low <= price : candle.high >= price);
        if (!crossing.length) { branched.push(state); continue; }
        if (!crossing.some((candle) => candle.definite)) branched.push(state);
        branched.push({ ...state, pnl: state.pnl - stop / 100 * state.qty * state.entry / leverage,
          qty: 0, out: true, triggers: state.triggers + 1,
          minTriggers: state.minTriggers + 1, maxTriggers: state.maxTriggers + 1, restart: -1 });
      }
      const fillUnits = global.CopyTradingLensPositions.toScaledQty(fill.qty);
      if (fill.entry) leadQty += fillUnits;
      const merged = new Map();
      for (const prior of branched) {
        const state = { ...prior };
        if (fill.entry && !(state.out && !follow)) {
          if (state.qty <= 0) state.restart = i;
          state.entry = state.qty > 0 ? (state.qty * state.entry + fill.qty * fill.price) / (state.qty + fill.qty) : fill.price;
          state.qty += fill.qty;
          state.out = false;
          state.peakMargin = Math.max(state.peakMargin, state.qty * state.entry / leverage);
        } else if (!fill.entry && state.qty > 0) {
          // Close the same FRACTION as the lead; absolute lead units are wrong after a copier-only stop.
          const reduced = state.qty * (fillUnits >= leadQty ? 1 : Number(fillUnits) / Number(leadQty));
          state.pnl += (fill.price - state.entry) * direction * reduced;
          state.qty -= reduced;
        }
        const key = state.qty <= 0 ? (state.out ? "stopped" : "flat") : `held:${state.restart}`;
        const kept = merged.get(key);
        if (!kept) merged.set(key, state);
        else {
          const winner = better(state, kept) ? state : kept;
          winner.minTriggers = Math.min(state.minTriggers, kept.minTriggers);
          winner.maxTriggers = Math.max(state.maxTriggers, kept.maxTriggers);
          merged.set(key, winner);
        }
      }
      states = [...merged.values()];
      if (!fill.entry) leadQty = leadQty > fillUnits ? leadQty - fillUnits : 0n;
    }
    const result = states.reduce((best, state) => better(state, best) ? state : best);
    return { pnl: result.pnl, peakMargin: result.peakMargin, triggers: result.triggers,
      triggerPossible: states.some((state) => state.maxTriggers > 0),
      triggerCertain: states.every((state) => state.minTriggers > 0) };
  }

  // Seeded generator: the same positions always give the same stability figure.
  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  const READINGS = [
    { follow: false, optimisticTiming: false }, { follow: true, optimisticTiming: false },
    { follow: false, optimisticTiming: true }, { follow: true, optimisticTiming: true }
  ];

  function completeSimulation(sim) {
    if (!sim?.fills?.length || !sim.fills[0].entry || ![1, -1].includes(sim.direction) || !(sim.leverage > 0)) return false;
    let qty = 0n; let last = 0;
    for (const fill of sim.fills) {
      if (!(fill.price > 0) || !(fill.qty > 0) || !(fill.time >= last)) return false;
      const delta = global.CopyTradingLensPositions.toScaledQty(fill.qty);
      qty += fill.entry ? delta : -delta;
      if (qty < 0n) return false;
      last = fill.time;
    }
    return qty === 0n && candlesCover(sim.candles, sim.fills[0].time, last);
  }

  /**
   * Historical optimum and resampling sensitivity. Candidates are "no stop" (null) and every integer 1..95.
   * Only complete, reconciled fill paths with continuous mark coverage are admitted.
   * @param {object[]} rows positionExcursions rows
   * @param {{equityAt: function}|null} equity
   * @returns {object|null} null when fewer than 3 positions can be simulated
   */
  function selectStop(rows, equity) {
    const sims = rows.filter((row) => row.marksUsed && row.marksComplete !== false && completeSimulation(row.sim));
    if (sims.length < 3) return null;
    const candidates = [null, ...STOP_CANDIDATES];
    const none = sims.map((row) => simulateCopier(row.sim, null, true));
    // pnl[reading][candidate][position]
    const outcomes = READINGS.map(({ follow, optimisticTiming }) => candidates.map((stop) => sims.map((row, i) => (
      stop === null ? none[i] : simulateCopier(row.sim, stop, follow, optimisticTiming)
    ))));
    const pnl = outcomes.map((byCandidate) => byCandidate.map((byPosition) => byPosition.map((result) => result.pnl)));
    const estimates = equity && !equity.unpriced?.length && typeof equity.equityAt === "function"
      ? sims.map((row) => equity.equityAt(row.opened)) : null;
    // Do not invent account size from the FUTURE peak margin or turn missing/negative equity into positive equity.
    const accounts = estimates?.every((value) => Number.isFinite(value) && value > 0) ? estimates : null;
    const objective = accounts ? "growth" : "pnl";
    const terms = pnl.map((byCandidate) => byCandidate.map((byPosition) => byPosition.map((value, i) => (
      accounts ? (value <= -accounts[i] ? -Infinity : Math.log1p(value / accounts[i])) : value
    ))));
    const scores = terms.map((byCandidate) => byCandidate.map(mean));
    // a stop's standing is its worse reading; "no stop" is the same under both
    const score = candidates.map((_, c) => Math.min(...scores.map((byCandidate) => byCandidate[c])));
    // Ties go to the lower index: "no stop" over any stop, and among stops the tighter one, since equal cost buys more
    // protection (a stop that never triggers in the history is free insurance).
    const bestOf = (values) => values.reduce((best, value, i) => (value > values[best] + 1e-12 ? i : best), 0);
    const optimalIndex = bestOf(score);
    if (!Number.isFinite(score[optimalIndex])) return null;
    const bestStopIndex = 1 + bestOf(score.slice(1));
    if (!Number.isFinite(score[bestStopIndex])) return null;
    const ties = (a, b) => a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-12);
    const optimalIndices = candidates.map((_, c) => c).filter((c) => ties(score[c], score[optimalIndex]));

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
        if (combined[c] > combined[optimalIndex] || ties(combined[c], combined[optimalIndex])) beatsOptimum[c] += 1;
      }
    }
    const inBand = candidates.map((_, c) => optimalIndices.includes(c) || beatsOptimum[c] / BOOTSTRAP_RESAMPLES >= BAND_SHARE);
    const total = (readingIndex, c) => pnl[readingIndex][c].reduce((a, value) => a + value, 0);
    const curve = candidates.map((stop, c) => ({
      stop,
      score: score[c],
      pnlStayOut: total(0, c),
      pnlFollow: total(1, c),
      triggered: Math.max(...outcomes.map((byCandidate) => byCandidate[c].filter((result) => result.triggerPossible).length)),
      triggeredMin: Math.min(...outcomes.map((byCandidate) => byCandidate[c].filter((result) => result.triggerCertain).length)),
      pnlMin: Math.min(...READINGS.map((_, r) => total(r, c))),
      pnlMax: Math.max(...READINGS.map((_, r) => total(r, c)))
    }));
    const stable = candidates.filter((_, c) => inBand[c]);
    return {
      objective,
      scope: "historicalPriceUtility",
      candidateStep: 1,
      candidateMin: 1,
      candidateMax: 95,
      sizing: accounts
        ? { source: "leadEquity", medianShare: percentile(sims.map((_, i) => none[i].peakMargin / accounts[i]), 50), p90Share: percentile(sims.map((_, i) => none[i].peakMargin / accounts[i]), 90) }
        : { source: "none" },
      simulatedPositions: sims.length,
      optimal: candidates[optimalIndex],
      optima: optimalIndices.map((c) => candidates[c]),
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
      _outcomes: outcomes,
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
    const readingTotals = READINGS.map((_, r) => selection._pnl[r][c].reduce((a, value) => a + value, 0));
    const worse = readingTotals.indexOf(Math.min(...readingTotals));
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
      triggered: selection._outcomes[worse][c].filter((result) => result.triggers > 0).length,
      triggeredAny: Math.max(...selection._outcomes.map((byCandidate) => byCandidate[c].filter((result) => result.triggerPossible).length)),
      helped,
      helpedUsdt,
      hurt,
      hurtUsdt,
      pnlNone: selection._pnl[0][noneIndex].reduce((a, value) => a + value, 0),
      pnlStopWorse: readingTotals[worse],
      pnlStopBetter: Math.max(...readingTotals),
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
    const winIndices = selection._sims.map((_, i) => i).filter((i) => selection._none[i].pnl > 0);
    const c = selection._candidates.indexOf(recommendedRoe);
    const keptWins = Math.min(...selection._outcomes.map((byCandidate) => winIndices.filter((i) => !byCandidate[c][i].triggerPossible).length));
    const lossStats = stats(losses.map((row) => row.maeRoe));
    const marksCoverage = rows.filter((row) => row.marksComplete).length / rows.length;
    const tradeoff = tradeoffOf(selection, recommendedRoe);
    // the per-position scratch of the simulation stays out of the result
    const { _sims, _none, _pnl, _outcomes, _candidates, ...stopSelection } = selection;

    return {
      insufficientData: false,
      positionCount: rows.length,
      simulatedPositions: selection.simulatedPositions,
      dominantLeverage,
      recommendedRoe,
      recommendedPriceDrop: Number((recommendedRoe / dominantLeverage).toPrecision(4)),
      // the data cannot tell a stop from no stop: the optimum is "none", or "none" sits in the stable band
      stopOptional: selection.optimal === null,
      winRetentionRate: Number((winIndices.length ? (keptWins / winIndices.length) * 100 : 100).toFixed(1)),
      tradeoff,
      hasSevereBagHolding: lossStats.max >= 100 || losses.some((row) => row.roiPct <= -100),
      worstHistoricalRoeMae: Number(stats(rows.map((row) => row.maeRoe)).max.toFixed(1)),
      allStats: rounded(stats(rows.map((row) => row.maeRoe))),
      winStats: rounded(stats(wins.map((row) => row.maeRoe))),
      lossStats: rounded(lossStats),
      mfeStats: rounded(stats(rows.map((row) => row.mfeRoe))),
      marksCoverage,
      entryPathPositions: rows.filter((row) => row.entryPathUsed).length,
      stopSelection
    };
  }

  global.CopyTradingLensStopLoss = {
    analyzeStopLossRadar,
    positionExcursions,
    selectStop,
    simulateCopier,
    tradeoffOf,
    lifeCandles,
    lifeExtremes,
    STOP_CANDIDATES
  };
})(window);
