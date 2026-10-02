(function attachStopLoss(global) {
  "use strict";

  // Fixed-capital historical price ROI: aggregate price PnL / the SAME starting capital.
  // Counterfactual fees, funding, slippage, capital failures and liquidation are not reconstructed.
  // Current Binance documentation anchors TP/SL orders to entry when placed; adds/reductions do not
  // update those orders. Whole-position exact-threshold exits and MARK triggers remain declared model
  // assumptions. Both undocumented reentry behaviours and intrabar first-hit uncertainty are bounded.
  // MAE/MFE describe excursions; neither is an objective. Never average per-position ROE to rank money.

  const MINUTE_MS = 60000;
  const HOUR_MS = 3600000;
  // User-facing policy domain: integer ROE percentages, 1..95; null means disabled (the form's 0).
  const STOP_CANDIDATES = Array.from({ length: 95 }, (_, i) => i + 1);
  const TAKE_PROFIT_MAX = 2000; // Binance official Position Risk input: 0–2,000%; 0 disables.
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

  // Prefix extrema answer first-cross queries without rescanning the same candle history per candidate.
  const intervalCache = new WeakMap();
  function intervalsOf(sim) {
    if (intervalCache.has(sim)) return intervalCache.get(sim);
    const intervals = sim.fills.map((fill, i) => {
      const from = i === 0 ? fill.time : sim.fills[i - 1].time;
      const to = fill.time;
      const candles = to <= from ? [] : sim.candles.filter((c) => c.time < to && c.time + c.step > from);
      const prefixOf = (rows) => {
        const low = []; const high = [];
        rows.forEach((c, k) => {
          low.push(Math.min(k ? low[k - 1] : Infinity, c.low));
          high.push(Math.max(k ? high[k - 1] : -Infinity, c.high));
        });
        return { low, high, clocks: rows.map((c) => c.clock) };
      };
      const possible = prefixOf(candles.map((c) => ({ ...c, clock: Math.max(from, c.time) }))
        .sort((a, b) => a.clock - b.clock));
      const certain = prefixOf(candles.filter((c) => c.time >= from && c.time + c.step <= to)
        .map((c) => ({ ...c, clock: c.time + c.step })).sort((a, b) => a.clock - b.clock));
      return { possible, certain, fillUnits: global.CopyTradingLensPositions.toScaledQty(fill.qty) };
    });
    intervalCache.set(sim, intervals);
    return intervals;
  }
  function firstCross(prefix, price, below) {
    let lo = 0; let hi = prefix.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (below ? prefix[mid] <= price : prefix[mid] >= price) hi = mid; else lo = mid + 1;
    }
    return lo === prefix.length ? Infinity : lo;
  }

  function simulateCopierBranching(sim, stop, follow, optimisticTiming = false, takeProfit = null, executionModel = "static") {
    const { fills, direction, leverage } = sim;
    const intervals = intervalsOf(sim);
    let leadQty = 0n;
    let states = [{ qty: 0, entry: 0, anchor: 0, pnl: 0, out: false, peakMargin: 0, triggers: 0,
      minTriggers: 0, maxTriggers: 0, stopTriggers: 0, profitTriggers: 0, restart: -1 }];
    const better = (a, b) => optimisticTiming ? a.pnl > b.pnl : a.pnl < b.pnl;
    for (let i = 0; i < fills.length; i += 1) {
      const fill = fills[i]; const interval = intervals[i]; const branched = [];
      for (const state of states) {
        if ((stop === null && takeProfit === null) || state.qty <= 0) { branched.push(state); continue; }
        const anchor = executionModel === "dynamic" ? state.entry : state.anchor;
        const stopPrice = stop === null ? null : anchor * (1 - direction * stop / (100 * leverage));
        const profitPrice = takeProfit === null ? null : anchor * (1 + direction * takeProfit / (100 * leverage));
        const crossing = (price, below, definite) => {
          if (price === null || !(price > 0)) return Infinity;
          const group = interval[definite ? "certain" : "possible"];
          const index = firstCross(group[below ? "low" : "high"], price, below);
          return index < Infinity ? group.clocks[index] : Infinity;
        };
        const possibleStop = crossing(stopPrice, direction > 0, false);
        const certainStop = crossing(stopPrice, direction > 0, true);
        const possibleProfit = crossing(profitPrice, direction < 0, false);
        const certainProfit = crossing(profitPrice, direction < 0, true);
        // An earlier mandatory exit rules out a later exit of the other kind. Within a common OHLC bar,
        // either barrier can occur first. Boundary bars may have their extrema outside the held interval.
        if (certainStop === Infinity && certainProfit === Infinity) branched.push(state);
        const exit = (price, kind) => branched.push({ ...state,
          pnl: state.pnl + (price - state.entry) * direction * state.qty,
          qty: 0, out: true, triggers: state.triggers + 1,
          minTriggers: state.minTriggers + 1, maxTriggers: state.maxTriggers + 1,
          stopTriggers: state.stopTriggers + (kind === "stop" ? 1 : 0),
          profitTriggers: state.profitTriggers + (kind === "profit" ? 1 : 0), restart: -1 });
        if (possibleStop < Infinity && possibleStop < certainProfit) exit(stopPrice, "stop");
        if (possibleProfit < Infinity && possibleProfit < certainStop) exit(profitPrice, "profit");
      }
      const fillUnits = interval.fillUnits;
      if (fill.entry) leadQty += fillUnits;
      const reductionFraction = fill.entry ? 0 : fillUnits >= leadQty ? 1 : Number(fillUnits) / Number(leadQty);
      const merged = new Map();
      for (const prior of branched) {
        const state = { ...prior };
        if (fill.entry && !(state.out && !follow)) {
          if (state.qty <= 0) { state.restart = i; state.anchor = fill.price; }
          state.entry = state.qty > 0 ? (state.qty * state.entry + fill.qty * fill.price) / (state.qty + fill.qty) : fill.price;
          state.qty += fill.qty; state.out = false;
          state.peakMargin = Math.max(state.peakMargin, state.qty * state.entry / leverage);
        } else if (!fill.entry && state.qty > 0) {
          const reduced = state.qty * reductionFraction;
          state.pnl += (fill.price - state.entry) * direction * reduced; state.qty -= reduced;
        }
        // Restart index determines future quantity, average entry AND static anchor at a common fill clock.
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
      stopTriggers: result.stopTriggers, profitTriggers: result.profitTriggers,
      triggerPossible: states.some((state) => state.maxTriggers > 0),
      triggerCertain: states.every((state) => state.minTriggers > 0) };
  }

  // Static orders allow a faster exact DAG: each restart has a precompiled no-exit holding path.
  // An exit points to the next copied entry, so the graph is acyclic. Barrier-only first-hit records
  // are reusable across every paired threshold. This is the same interval relaxation as branching.
  const staticCache = new WeakMap();
  function compileStatic(sim) {
    if (staticCache.has(sim)) return staticCache.get(sim);
    const { fills, direction, leverage } = sim; const intervals = intervalsOf(sim);
    const fractions = []; let leadQty = 0n;
    fills.forEach((fill, i) => {
      const units = intervals[i].fillUnits;
      if (fill.entry) { leadQty += units; fractions.push(0); }
      else { fractions.push(units >= leadQty ? 1 : Number(units) / Number(leadQty)); leadQty = leadQty > units ? leadQty - units : 0n; }
    });
    const nextEntry = []; let next = -1;
    for (let i = fills.length - 1; i >= 0; i--) { if (fills[i].entry) next = i; nextEntry[i] = next; }
    const paths = new Map();
    fills.forEach((start, r) => {
      if (!start.entry) return;
      let qty = start.qty; let entry = start.price; let pnl = 0; let peakMargin = qty * entry / leverage;
      const slices = [];
      for (let i = r + 1; i < fills.length; i++) {
        const fill = fills[i];
        slices.push({ i, qty, entry, pnl, peakMargin });
        if (fill.entry) {
          entry = (qty * entry + fill.qty * fill.price) / (qty + fill.qty); qty += fill.qty;
          peakMargin = Math.max(peakMargin, qty * entry / leverage);
        } else {
          const reduced = qty * fractions[i]; pnl += (fill.price - entry) * direction * reduced; qty -= reduced;
        }
      }
      paths.set(r, { anchor: start.price, pnl, peakMargin, slices, stops: new Map(), profits: new Map() });
    });
    const compiled = { paths, nextEntry, intervals }; staticCache.set(sim, compiled); return compiled;
  }
  function staticBarrier(sim, compiled, r, level, profit) {
    if (level === null) return { price: null, events: [], mandatoryInterval: Infinity, mandatoryEnd: Infinity };
    const path = compiled.paths.get(r); const cache = profit ? path.profits : path.stops;
    if (cache.has(level)) return cache.get(level);
    const price = path.anchor * (1 + sim.direction * (profit ? level : -level) / (100 * sim.leverage));
    const events = []; let mandatoryInterval = Infinity; let mandatoryEnd = Infinity;
    if (price > 0) for (const slice of path.slices) {
      const interval = compiled.intervals[slice.i]; const below = profit ? sim.direction < 0 : sim.direction > 0;
      const clock = (group) => {
        const index = firstCross(group[below ? "low" : "high"], price, below);
        return index < Infinity ? group.clocks[index] : Infinity;
      };
      const possible = clock(interval.possible); const certain = clock(interval.certain);
      if (possible < Infinity) events.push({ ...slice, possible });
      if (certain < Infinity) { mandatoryInterval = slice.i; mandatoryEnd = certain; break; }
    }
    const result = { price, events, mandatoryInterval, mandatoryEnd };
    cache.set(level, result); return result;
  }
  function simulateCopierStatic(sim, stop, follow, optimisticTiming, takeProfit) {
    const compiled = compileStatic(sim); const memo = new Map();
    const visit = (r) => {
      if (memo.has(r)) return memo.get(r);
      const path = compiled.paths.get(r);
      const sl = staticBarrier(sim, compiled, r, stop, false); const tp = staticBarrier(sim, compiled, r, takeProfit, true);
      const limit = Math.min(sl.mandatoryInterval, tp.mandatoryInterval);
      let best = null; let minTriggers = Infinity; let maxTriggers = 0;
      const consider = (outcome) => {
        if (!best || (optimisticTiming ? outcome.pnl > best.pnl : outcome.pnl < best.pnl)) best = outcome;
        minTriggers = Math.min(minTriggers, outcome.minTriggers); maxTriggers = Math.max(maxTriggers, outcome.maxTriggers);
      };
      if (limit === Infinity) consider({ pnl: path.pnl, peakMargin: path.peakMargin, triggers: 0, stopTriggers: 0, profitTriggers: 0, minTriggers: 0, maxTriggers: 0 });
      for (const [kind, own, other] of [["stop", sl, tp], ["profit", tp, sl]]) {
        for (const event of own.events) {
          if (event.i > limit) break;
          if (event.i === other.mandatoryInterval && event.possible >= other.mandatoryEnd) continue;
          const next = follow ? compiled.nextEntry[event.i] : -1;
          const future = next >= 0 ? visit(next) : { pnl: 0, peakMargin: 0, triggers: 0, stopTriggers: 0, profitTriggers: 0, minTriggers: 0, maxTriggers: 0 };
          consider({ pnl: event.pnl + (own.price - event.entry) * sim.direction * event.qty + future.pnl,
            peakMargin: Math.max(event.peakMargin, future.peakMargin), triggers: 1 + future.triggers,
            stopTriggers: (kind === "stop" ? 1 : 0) + future.stopTriggers,
            profitTriggers: (kind === "profit" ? 1 : 0) + future.profitTriggers,
            minTriggers: 1 + future.minTriggers, maxTriggers: 1 + future.maxTriggers });
        }
      }
      const result = { ...best, minTriggers, maxTriggers };
      memo.set(r, result); return result;
    };
    const result = visit(0);
    return { pnl: result.pnl, peakMargin: result.peakMargin, triggers: result.triggers,
      stopTriggers: result.stopTriggers, profitTriggers: result.profitTriggers,
      triggerPossible: result.maxTriggers > 0, triggerCertain: result.minTriggers > 0 };
  }
  function simulateCopier(sim, stop, follow, optimisticTiming = false, takeProfit = null, executionModel = "static") {
    return executionModel === "static" ? simulateCopierStatic(sim, stop, follow, optimisticTiming, takeProfit)
      : simulateCopierBranching(sim, stop, follow, optimisticTiming, takeProfit, executionModel);
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
    if (!sim?.fills?.length || !sim.fills[0].entry || ![1, -1].includes(sim.direction) || !Number.isFinite(sim.leverage) || !(sim.leverage > 0)) return false;
    if (!sim.candles?.length || sim.candles.some((c) => ![c.time, c.step, c.low, c.high].every(Number.isFinite) || c.step <= 0 || c.low <= 0 || c.high < c.low)) return false;
    let qty = 0n; let last = 0;
    for (const fill of sim.fills) {
      if (![fill.price, fill.qty, fill.time].every(Number.isFinite) || !(fill.price > 0) || !(fill.qty > 0) || !(fill.time >= last)) return false;
      const delta = global.CopyTradingLensPositions.toScaledQty(fill.qty);
      if (delta <= 0n) return false;
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
    const objective = "pnl";
    const terms = pnl;
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
    const neverTriggered = curve.find((point) => point.stop !== null && point.triggered === 0);
    const historicalInitialAnchorMae = Math.max(0, ...sims.map((row) => {
      const firstEntry = row.sim.fills[0].price;
      const extreme = row.sim.candles.reduce((value, c) => row.sim.direction > 0 ? Math.min(value, c.low) : Math.max(value, c.high), row.sim.direction > 0 ? Infinity : -Infinity);
      return row.sim.leverage * 100 * (row.sim.direction > 0 ? 1 - extreme / firstEntry : extreme / firstEntry - 1);
    }));
    let historicalNeverTriggerRoe = neverTriggered?.stop ?? Math.floor(historicalInitialAnchorMae) + 1;
    if (!neverTriggered) {
      const hits = (level) => sims.some((row) => simulateCopier(row.sim, level, false).triggerPossible);
      // Verify the analytical integer boundary against replay; extreme/threshold arithmetic can differ by 1 ulp.
      while (hits(historicalNeverTriggerRoe)) historicalNeverTriggerRoe += 1;
      while (historicalNeverTriggerRoe > 1 && !hits(historicalNeverTriggerRoe - 1)) historicalNeverTriggerRoe -= 1;
    }
    return {
      objective,
      scope: "historicalPriceROI",
      executionModel: "static",
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
      insuranceStop: candidates[optimalIndex] === null && neverTriggered && ties(neverTriggered.score, score[bestStopIndex])
        ? neverTriggered.stop : candidates[bestStopIndex],
      neverTriggeredStop: neverTriggered?.stop ?? null,
      historicalNeverTriggerRoe,
      historicalInitialAnchorMae,
      neverTriggeredEquivalentToOptimal: !!neverTriggered && ties(neverTriggered.score, score[optimalIndex]),
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

  // Data-derived upper bounds across EVERY possible restart anchor. Values above a bound cannot
  // trigger in this history and are provably equivalent to disabled; they are still in the certified grid.
  function exitBounds(sim) {
    let low = Infinity; let high = -Infinity;
    for (const c of sim.candles) { low = Math.min(low, c.low); high = Math.max(high, c.high); }
    let stop = 0; let takeProfit = 0;
    for (const fill of sim.fills) if (fill.entry) {
      const adverse = sim.direction > 0 ? (1 - low / fill.price) : (high / fill.price - 1);
      const favorable = sim.direction > 0 ? (high / fill.price - 1) : (1 - low / fill.price);
      stop = Math.max(stop, adverse * 100 * sim.leverage);
      takeProfit = Math.max(takeProfit, favorable * 100 * sim.leverage);
    }
    // One extra integer above ceil protects the never-hit certificate against floating-point rounding.
    return { stop: Math.max(0, Math.ceil(stop) + 1), takeProfit: Math.max(0, Math.ceil(takeProfit) + 1) };
  }
  const pairKey = (pair) => `${pair.stop ?? 0}/${pair.takeProfit ?? 0}`;

  // One deterministic core for synchronous research and cooperative browser execution.
  // Coarse pass measures the surface; fine pass certifies every integer or a proven never-trigger class.
  function* exitSearch(rows, equity = null, options = {}) {
    const sims = rows.filter((row) => row.marksUsed && row.marksComplete !== false && completeSimulation(row.sim));
    if (sims.length < 3) return null;
    const stopMax = options.stopMax ?? 95; const takeProfitMax = options.takeProfitMax ?? TAKE_PROFIT_MAX;
    if (!Number.isInteger(stopMax) || stopMax < 1 || stopMax > 95 || !Number.isInteger(takeProfitMax) || takeProfitMax < 1 || takeProfitMax > TAKE_PROFIT_MAX) throw new RangeError("Unsupported exit grid");
    const executionModel = options.executionModel ?? "static";
    if (!["static", "dynamic"].includes(executionModel)) throw new RangeError("Unsupported execution model");
    const bounds = sims.map((row) => exitBounds(row.sim));
    const effectiveStopMax = Math.min(stopMax, Math.max(...bounds.map((b) => b.stop)));
    const effectiveProfitMax = Math.min(takeProfitMax, Math.max(...bounds.map((b) => b.takeProfit)));
    const width = effectiveProfitMax + 1;
    const count = (effectiveStopMax + 1) * width;
    const minima = new Float64Array(count); const maxima = new Float64Array(count);
    const triggered = new Uint32Array(count); const certain = new Uint32Array(count); const visited = new Uint8Array(count);
    const baseline = sims.map((row) => simulateCopier(row.sim, null, true));
    const baselinePnl = baseline.reduce((sum, r) => sum + r.pnl, 0);
    // Cache only each row's exit equivalence classes, with an explicit bound on memory. Prefix candle extrema
    // and canonical fills are compiled once. No raw history is rescanned for every grid cell.
    const caches = sims.map(() => new Map());
    const cacheLimit = 2048; // Resource bound, not a policy/risk parameter; eviction cannot change a score.
    let evaluations = 0; let simulations = 0;
    const evaluate = (stop, takeProfit) => {
      const index = stop * width + takeProfit;
      if (visited[index]) return;
      const totals = [0, 0, 0, 0]; let possibleCount = 0; let certainCount = 0;
      sims.forEach((row, i) => {
        const sl = stop > bounds[i].stop ? 0 : stop;
        const tp = takeProfit > bounds[i].takeProfit ? 0 : takeProfit;
        const key = sl * (takeProfitMax + 1) + tp;
        let values = caches[i].get(key);
        if (!values) {
          const outcomes = sl === 0 && tp === 0 ? READINGS.map(() => baseline[i]) : READINGS.map((r) => {
            simulations += 1;
            return simulateCopier(row.sim, sl || null, r.follow, r.optimisticTiming, tp || null, executionModel);
          });
          values = { pnl: outcomes.map((r) => r.pnl), possible: outcomes.some((r) => r.triggerPossible), certain: outcomes.every((r) => r.triggerCertain) };
          if (caches[i].size >= cacheLimit) caches[i].delete(caches[i].keys().next().value);
          caches[i].set(key, values);
        }
        values.pnl.forEach((pnl, r) => { totals[r] += pnl; });
        possibleCount += values.possible ? 1 : 0; certainCount += values.certain ? 1 : 0;
      });
      minima[index] = Math.min(...totals); maxima[index] = Math.max(...totals);
      triggered[index] = possibleCount; certain[index] = certainCount; visited[index] = 1; evaluations += 1;
    };
    // Coarse strides derive from domain size, followed by complete 1% refinement rather than unjustified
    // local-only pruning. No first-pass winner is treated as a certified optimum.
    const coarseStops = new Set([0, 1, effectiveStopMax]);
    const coarseProfits = new Set([0, 1, effectiveProfitMax]);
    const stopStride = Math.max(1, Math.ceil(Math.sqrt(effectiveStopMax)));
    const profitStride = Math.max(1, Math.ceil(Math.sqrt(effectiveProfitMax)));
    for (let n = stopStride; n < effectiveStopMax; n += stopStride) coarseStops.add(n);
    for (let n = profitStride; n < effectiveProfitMax; n += profitStride) coarseProfits.add(n);
    for (const stop of coarseStops) for (const tp of coarseProfits) { evaluate(stop, tp); yield { phase: "coarse", evaluations, count }; }
    for (let stop = 0; stop <= effectiveStopMax; stop += 1) for (let tp = 0; tp <= effectiveProfitMax; tp += 1) {
      evaluate(stop, tp); yield { phase: "fine", evaluations, count };
    }
    // Expand proven equivalence classes to the full supported domain, preserving every exact tied pair.
    const point = (stop, takeProfit) => {
      const index = (stop > effectiveStopMax ? 0 : stop) * width + (takeProfit > effectiveProfitMax ? 0 : takeProfit);
      return { stop: stop || null, takeProfit: takeProfit || null, score: minima[index], pnlMin: minima[index], pnlMax: maxima[index], triggered: triggered[index], triggeredMin: certain[index] };
    };
    let best = point(0, 0); const curve = options.includeCurve ? [] : null;
    let optima = [];
    const tolerance = 1e-8; // Numerical comparison in lead-account USDT; never a monetary utility weight.
    for (let stop = 0; stop <= stopMax; stop += 1) for (let tp = 0; tp <= takeProfitMax; tp += 1) {
      const p = point(stop, tp);
      if (curve) curve.push(p);
      if (p.score > best.score + tolerance) { best = p; optima = [{ stop: p.stop, takeProfit: p.takeProfit }]; }
      else if (Math.abs(p.score - best.score) <= tolerance) optima.push({ stop: p.stop, takeProfit: p.takeProfit });
    }
    const optimal = { stop: best.stop, takeProfit: best.takeProfit };
    const outcomes = READINGS.map((r) => sims.map((row) => simulateCopier(row.sim, optimal.stop, r.follow, r.optimisticTiming, optimal.takeProfit, executionModel)));
    const totals = outcomes.map((byRow) => byRow.reduce((sum, r) => sum + r.pnl, 0));
    const worse = totals.indexOf(Math.min(...totals));
    const deltas = outcomes[worse].map((r, i) => r.pnl - baseline[i].pnl);
    const capital = Number.isFinite(options.capital) && options.capital > 0 ? options.capital : null;
    const result = {
      objective: "priceROI", scope: "historicalPriceROI", executionModel, candidateStep: 1,
      stopMax, takeProfitMax, simulatedPositions: sims.length, optimal, optima,
      baselinePnl, optimalPnlMin: best.pnlMin, optimalPnlMax: best.pnlMax,
      deltaMin: best.pnlMin - baselinePnl, deltaMax: best.pnlMax - baselinePnl,
      capital, roiMin: capital ? best.pnlMin / capital * 100 : null, roiMax: capital ? best.pnlMax / capital * 100 : null,
      baselineRoi: capital ? baselinePnl / capital * 100 : null,
      profileStop: Array.from({ length: stopMax + 1 }, (_, stop) => point(stop, optimal.takeProfit || 0)),
      profileTakeProfit: Array.from({ length: takeProfitMax + 1 }, (_, tp) => point(optimal.stop || 0, tp)),
      tradeoff: { helped: deltas.filter((d) => d > tolerance).length, hurt: deltas.filter((d) => d < -tolerance).length,
        helpedUsdt: deltas.filter((d) => d > tolerance).reduce((a, b) => a + b, 0),
        hurtUsdt: deltas.filter((d) => d < -tolerance).reduce((a, b) => a + b, 0),
        triggeredAny: best.triggered, triggeredMin: best.triggeredMin },
      search: { method: "coarse_then_complete_integer_refinement_with_never_hit_equivalence", certified: true,
        fullDomain: (stopMax + 1) * (takeProfitMax + 1), distinctEvaluations: evaluations, simulationCalls: simulations,
        effectiveStopMax, effectiveProfitMax, cacheEntriesMaxPerPosition: cacheLimit }
    };
    if (curve) result.curve = curve;
    return result;
  }
  function evaluateExit(rows, pair, executionModel = "static") {
    const sims = rows.filter((row) => row.marksUsed && row.marksComplete !== false && completeSimulation(row.sim));
    if (!sims.length) return null;
    const baselinePnl = sims.reduce((sum, row) => sum + simulateCopier(row.sim, null, true).pnl, 0);
    const totals = READINGS.map((r) => sims.reduce((sum, row) => sum + simulateCopier(row.sim, pair.stop, r.follow, r.optimisticTiming, pair.takeProfit, executionModel).pnl, 0));
    return { pair, executionModel, positions: sims.length, baselinePnl,
      pnlMin: Math.min(...totals), pnlMax: Math.max(...totals),
      deltaMin: Math.min(...totals) - baselinePnl, deltaMax: Math.max(...totals) - baselinePnl };
  }
  function* holdoutSearch(rows, options = {}) {
    const chronological = rows.filter((row) => row.marksUsed && row.marksComplete !== false && completeSimulation(row.sim))
      .sort((a, b) => a.opened - b.opened || a.closed - b.closed);
    if (chronological.length < 6 || chronological.some((r) => !Number.isFinite(r.opened) || !Number.isFinite(r.closed))) return { insufficientData: true };
    const cutoff = chronological[Math.floor(chronological.length / 2)].opened;
    const train = chronological.filter((r) => r.opened < cutoff && r.closed < cutoff);
    const test = chronological.filter((r) => r.opened >= cutoff);
    const base = { cutoff: new Date(cutoff).toISOString(), trainPositions: train.length, testPositions: test.length,
      excludedStraddling: chronological.length - train.length - test.length, heldoutUsedForSelection: false };
    if (train.length < 3 || test.length < 3) return { ...base, insufficientData: true };
    const trainSearch = exitSearch(train, null, { ...options, includeCurve: false, capital: null });
    let step = trainSearch.next();
    while (!step.done) { yield { ...step.value, scope: "holdout" }; step = trainSearch.next(); }
    const chosen = step.value;
    return { ...base, insufficientData: !chosen, trainOptimal: chosen?.optimal || null,
      trainPricePnl: chosen?.optimalPnlMin ?? null, fixed: chosen ? evaluateExit(test, chosen.optimal, options.executionModel || "static") : null };
  }
  function chronologicalExitHoldout(rows, options = {}) {
    const search = holdoutSearch(rows, options);
    let step = search.next(); while (!step.done) step = search.next(); return step.value;
  }
  function* completeExitSearch(rows, equity, options) {
    const result = yield* exitSearch(rows, equity, options);
    if (result && options.withHoldout) {
      result.holdout = yield* holdoutSearch(rows, { ...options, onProgress: null });
    }
    return result;
  }
  function selectExit(rows, equity = null, options = {}) {
    const search = completeExitSearch(rows, equity, options);
    let step = search.next(); while (!step.done) step = search.next(); return step.value;
  }
  async function selectExitAsync(rows, equity = null, options = {}) {
    await options.waitUntilResumed?.();
    if (options.isCancelled?.()) throw new Error("Exit search superseded");
    const search = completeExitSearch(rows, equity, options);
    let clock = Date.now(); let step = search.next();
    while (!step.done) {
      if (options.isCancelled?.()) throw new Error("Exit search superseded");
      if (Date.now() - clock >= 8) {
        options.onProgress?.(step.value);
        await new Promise((resolve) => setTimeout(resolve, 0));
        await options.waitUntilResumed?.();
        clock = Date.now();
      }
      step = search.next();
    }
    return step.value;
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
  function analyzeStopLossRadar(positions, orders = [], positionMarks = null, equity = null, exitSelection = null) {
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
      stopSelection,
      exitSelection
    };
  }

  global.CopyTradingLensStopLoss = {
    analyzeStopLossRadar,
    selectExit,
    selectExitAsync,
    evaluateExit,
    chronologicalExitHoldout,
    exitBounds,
    TAKE_PROFIT_MAX,
    positionExcursions,
    selectStop,
    simulateCopier,
    tradeoffOf,
    lifeCandles,
    lifeExtremes,
    STOP_CANDIDATES
  };
})(window);
