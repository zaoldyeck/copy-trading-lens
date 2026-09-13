(function attachStyle(global) {
  "use strict";

  // Trading style is read from position episodes: one position on one symbol
  // and side, from flat to flat, rebuilt from the order history. Every
  // measurement below is taken per episode first, so a trader's style is what
  // their positions do, not an average that mixes symbols, sides and years.

  const HOUR_MS = 60 * 60 * 1000;
  const DAY_MS = 24 * HOUR_MS;

  function toNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // Hedge-mode rows carry LONG/SHORT, so an order opens when it buys a long or
  // sells a short. One-way (BOTH) rows carry no side: the position's side is
  // the sign of the running net quantity, and an order opens when it grows it.
  function buildEpisodes(orders) {
    const sorted = [...(orders || [])].sort((a, b) => toNumber(a.orderTime) - toNumber(b.orderTime));
    const open = new Map();
    const episodes = [];
    let orphanExits = 0;
    for (const order of sorted) {
      const qty = Math.abs(toNumber(order.executedQty));
      const price = toNumber(order.avgPrice);
      if (!qty || !price) continue;
      const positionSide = String(order.positionSide || "BOTH").toUpperCase();
      const buy = String(order.side || "").toUpperCase() === "BUY";
      const key = `${order.symbol}:${positionSide}`;
      let episode = open.get(key);
      let opening;
      let direction;
      if (positionSide === "LONG" || positionSide === "SHORT") {
        direction = positionSide;
        opening = (positionSide === "LONG") === buy;
      } else if (!episode || Math.abs(episode.net) < 1e-12) {
        direction = buy ? "LONG" : "SHORT";
        opening = true;
      } else {
        direction = episode.direction;
        opening = (direction === "LONG") === buy;
      }
      const fill = {
        t: toNumber(order.orderTime),
        qty,
        price,
        notional: qty * price,
        type: String(order.type || "").toUpperCase(),
        pnl: toNumber(order.totalPnl)
      };
      if (opening) {
        if (!episode) {
          episode = { symbol: String(order.symbol || ""), direction, fills: [], net: 0, peak: 0 };
          open.set(key, episode);
        }
        episode.fills.push({ ...fill, entry: true });
        episode.net += qty;
        episode.peak = Math.max(episode.peak, episode.net);
      } else if (!episode) {
        orphanExits += 1;
      } else {
        episode.fills.push({ ...fill, entry: false });
        episode.net -= qty;
        if (episode.net <= episode.peak * 1e-6) {
          episodes.push(finishEpisode(episode, true));
          open.delete(key);
        }
      }
    }
    for (const episode of open.values()) episodes.push(finishEpisode(episode, false));
    return { episodes: episodes.sort((a, b) => a.start - b.start), orphanExits };
  }

  function finishEpisode(episode, closed) {
    const entries = episode.fills.filter((fill) => fill.entry);
    const exits = episode.fills.filter((fill) => !fill.entry);
    const first = entries[0];
    const sign = episode.direction === "LONG" ? -1 : 1;
    return {
      symbol: episode.symbol,
      direction: episode.direction,
      closed,
      fills: episode.fills,
      entries,
      exits,
      start: first.t,
      end: (exits.at(-1) || entries.at(-1)).t,
      pnl: exits.reduce((sum, fill) => sum + fill.pnl, 0),
      // bps from the first entry, positive when the price moved against the position
      against: (price) => ((price / first.price) - 1) * 10000 * sign
    };
  }

  // Consecutive entries with no exit between them form a run: the sequence a
  // martingale multiplies through before it takes profit and starts over.
  function runsOf(items) {
    const runs = [];
    let run = [];
    for (const item of items) {
      if (item.entry) {
        run.push(item);
      } else if (run.length) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length) runs.push(run);
    return runs;
  }

  // ---- Every constant below was set against lead traders labelled by hand
  // from their fills, and checked on traders held out from that tuning.

  // Fewer closed positions or a shorter window than this cannot show a style.
  // Round 1: every trader labelled "insufficient" had <= 4 closed episodes or a
  // 5-day window; the smallest judgeable trader had 10 episodes / 18 days.
  const MIN_CLOSED_EPISODES = 8;
  const MIN_SPAN_DAYS = 7;
  // Price-level tolerance, in steps: a random price lands within 0.1 of a
  // lattice step 20% of the time, so a majority on-lattice is far above chance.
  const LATTICE_TOLERANCE = 0.1;
  // A grid step at or below two maker fees (0.02% each on Binance USD-M base
  // tier) earns nothing per round trip, so smaller "steps" are not grid levels.
  const MIN_GRID_STEP_BPS = 4;
  // Two grid-shaped positions: round 1 had 11 for the grid trader and 0 for
  // all 28 others, so any count from 1 to 11 classifies round 1 identically.
  const MIN_GRID_EPISODES = 2;
  // A martingale add grows the stake; constant-notional ladders sit at x1.00
  // within lot rounding (round 1: 1.00 +/- 0.02).
  const MIN_MULTIPLIER = 1.05;
  // Share of positions with adds whose adds follow a fixed multiplier, and how
  // tightly the multipliers cluster around each symbol's own ratio (q75/q25).
  // Round 1: martingale traders 0.81 and 0.93 with spread 1.00-1.01; highest
  // non-martingale 0.56 (a scalper that doubles on its rare adds), then 0.20;
  // scattered escalators spread 1.14-1.46.
  const MIN_MULTIPLIER_EPISODE_SHARE = 0.7;
  const MAX_MULTIPLIER_SPREAD = 1.1;
  // Share of closed positions that added deeper than the trader's own median
  // take-profit distance. Round 1: averaging traders 0.19-0.43, traders who do
  // not average 0.00-0.16 (one exception at 0.28).
  const MIN_DEEP_ADD_SHARE = 0.18;
  // Among traders who average in, the share of losing closed positions has a
  // gap at 0.10 across the cache (0.08: 4 traders, 0.10: 1, 0.12: 5).
  const STOP_LOSS_SHARE = 0.1;
  // Positions held under a day on median are short-term; a day or more, swing.
  const SWING_HOLD_HOURS = 24;

  const THRESHOLDS = Object.freeze({
    MIN_CLOSED_EPISODES, MIN_SPAN_DAYS, MIN_GRID_EPISODES, MIN_MULTIPLIER, MIN_MULTIPLIER_EPISODE_SHARE,
    MAX_MULTIPLIER_SPREAD, MIN_DEEP_ADD_SHARE, STOP_LOSS_SHARE, SWING_HOLD_HOURS
  });

  function quantile(values, p) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
  }

  function coefficientOfVariation(values) {
    if (values.length < 2) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (!mean) return Infinity;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance) / Math.abs(mean);
  }

  // Operator definition (2026-09-13): fixed size per level, evenly spaced
  // levels, closes at grid levels, levels traded again. Tested on one position.
  function gridShape(episode) {
    const levels = [...new Set(episode.entries.map((fill) => Number(fill.price.toPrecision(9))))].sort((a, b) => a - b);
    if (levels.length < 4) return null;
    const mid = levels[Math.floor(levels.length / 2)];
    const bps = (a, b) => (Math.abs(a - b) / mid) * 10000;
    const gaps = levels.slice(1).map((level, i) => bps(level, levels[i]));
    const near = (a, b) => Math.abs(a / b - 1) <= LATTICE_TOLERANCE;
    let step = null;
    let stepShare = 0;
    for (const candidate of gaps) {
      if (candidate < MIN_GRID_STEP_BPS) continue;
      const share = gaps.filter((gap) => near(gap, candidate)).length / gaps.length;
      if (share > stepShare || (share === stepShare && candidate > step)) {
        stepShare = share;
        step = candidate;
      }
    }
    if (!step) return null;
    const onLattice = (price) => {
      const steps = bps(price, levels[0]) / step;
      return Math.abs(steps - Math.round(steps)) <= LATTICE_TOLERANCE;
    };
    const modalShare = (values) => {
      const clusters = [];
      for (const value of values) {
        const cluster = clusters.find((c) => Math.abs(value / c.value - 1) <= 0.05);
        if (cluster) cluster.count += 1; else clusters.push({ value, count: 1 });
      }
      return Math.max(...clusters.map((c) => c.count)) / values.length;
    };
    const lotShare = Math.max(modalShare(episode.entries.map((f) => f.qty)), modalShare(episode.entries.map((f) => f.notional)));
    const exitShare = episode.exits.length ? episode.exits.filter((f) => onLattice(f.price)).length / episode.exits.length : 0;
    const exitsBefore = new Map();
    let exitsSoFar = 0;
    let reentries = 0;
    for (const fill of episode.fills) {
      if (!fill.entry) {
        exitsSoFar += 1;
        continue;
      }
      const level = Number(fill.price.toPrecision(9));
      if (exitsBefore.has(level) && exitsBefore.get(level) < exitsSoFar) reentries += 1;
      exitsBefore.set(level, exitsSoFar);
    }
    return { step, stepShare, lotShare, exitShare, reentries };
  }

  function isGridEpisode(episode) {
    const shape = gridShape(episode);
    return Boolean(shape) && shape.stepShare > 0.5 && shape.lotShare > 0.5 && shape.exitShare > 0.5 && shape.reentries > 0;
  }

  // Operator definition: each add against the position is a fixed multiple of
  // the one before. A run is the entries between two exits. With three or more
  // entries the stake must grow by a constant ratio rather than a constant
  // amount — a linear ramp (29, 36, 42, 49 ...) is not a martingale.
  function multiplierRuns(episode) {
    const long = episode.direction === "LONG";
    const found = [];
    for (const run of runsOf(episode.fills)) {
      if (run.length < 2) continue;
      const ratios = [];
      const steps = [];
      let valid = true;
      for (let i = 1; i < run.length; i += 1) {
        const previous = run[i - 1];
        const current = run[i];
        const against = long ? current.price < previous.price : current.price > previous.price;
        const ratio = current.notional / previous.notional;
        if (!against || ratio < MIN_MULTIPLIER) {
          valid = false;
          break;
        }
        ratios.push(ratio);
        steps.push(current.notional - previous.notional);
      }
      if (!valid) continue;
      if (ratios.length >= 2 && coefficientOfVariation(ratios.map(Math.log)) >= coefficientOfVariation(steps)) continue;
      found.push(ratios);
    }
    return found;
  }

  function takeProfitBps(episode) {
    const qty = episode.exits.reduce((sum, fill) => sum + fill.qty, 0);
    if (!qty) return null;
    const exitPrice = episode.exits.reduce((sum, fill) => sum + fill.price * fill.qty, 0) / qty;
    return -episode.against(exitPrice);
  }

  function classify(orders, overrides = {}) {
    const {
      MIN_CLOSED_EPISODES, MIN_SPAN_DAYS, MIN_GRID_EPISODES, MIN_MULTIPLIER_EPISODE_SHARE,
      MAX_MULTIPLIER_SPREAD, MIN_DEEP_ADD_SHARE, STOP_LOSS_SHARE, SWING_HOLD_HOURS
    } = { ...THRESHOLDS, ...overrides };
    const { episodes } = buildEpisodes(orders);
    const closed = episodes.filter((episode) => episode.closed);
    const times = (orders || []).map((order) => toNumber(order.orderTime)).filter(Boolean);
    const spanDays = times.length ? (Math.max(...times) - Math.min(...times)) / DAY_MS : 0;
    const evidence = { episodes: episodes.length, closedEpisodes: closed.length, spanDays };
    if (closed.length < MIN_CLOSED_EPISODES || spanDays < MIN_SPAN_DAYS) {
      return { family: "insufficient", secondary: [], evidence };
    }

    const losingShare = closed.filter((episode) => episode.pnl < 0).length / closed.length;
    const takeProfit = median(closed.filter((episode) => episode.pnl > 0).map(takeProfitBps).filter((value) => value > 0));
    const deepAddShare = takeProfit === null ? 0 : closed.filter((episode) => (
      episode.entries.slice(1).some((fill) => episode.against(fill.price) > takeProfit)
    )).length / closed.length;

    // A martingale template multiplies by its own fixed ratio, which can differ
    // per symbol (x1.45 on one, x2 on another), so the spread is measured
    // around each symbol's median multiplier.
    const addedEpisodes = closed.filter((episode) => episode.entries.length > 1);
    const withMultiplier = addedEpisodes.map((episode) => ({ symbol: episode.symbol, runs: multiplierRuns(episode) })).filter((row) => row.runs.length);
    const multiplierShare = addedEpisodes.length ? withMultiplier.length / addedEpisodes.length : 0;
    const bySymbol = new Map();
    for (const row of withMultiplier) {
      if (!bySymbol.has(row.symbol)) bySymbol.set(row.symbol, []);
      bySymbol.get(row.symbol).push(...row.runs.flat().map(Math.log));
    }
    const residuals = [...bySymbol.values()].flatMap((logs) => {
      const centre = median(logs);
      return logs.map((value) => value - centre);
    });
    const multiplierSpread = residuals.length ? Math.exp(quantile(residuals, 0.75) - quantile(residuals, 0.25)) : null;
    const multipliers = withMultiplier.flatMap((row) => row.runs.flat());
    const martingale = multiplierShare >= MIN_MULTIPLIER_EPISODE_SHARE && multiplierSpread !== null && multiplierSpread <= MAX_MULTIPLIER_SPREAD;

    const gridEpisodes = episodes.filter(isGridEpisode).length;
    const grid = gridEpisodes >= MIN_GRID_EPISODES;

    const holdHours = median(closed.map((episode) => (episode.end - episode.start) / HOUR_MS));
    Object.assign(evidence, {
      losingShare,
      takeProfitBps: takeProfit,
      deepAddShare,
      multiplierShare,
      multiplierMedian: median(multipliers),
      multiplierSpread,
      gridEpisodes,
      holdHours
    });

    const secondary = [];
    let family;
    if (martingale && grid) {
      family = gridEpisodes >= withMultiplier.length ? "grid" : "martingale";
      secondary.push(family === "grid" ? "martingale" : "grid");
    } else if (martingale) {
      family = "martingale";
    } else if (grid) {
      family = "grid";
    } else if (deepAddShare >= MIN_DEEP_ADD_SHARE) {
      family = losingShare < STOP_LOSS_SHARE ? "dcaNoStop" : "dcaWithStop";
    } else {
      family = holdHours < SWING_HOLD_HOURS ? "shortTerm" : "swing";
    }
    if (losingShare === 0) secondary.push("neverRealisedLoss");
    return { family, secondary, evidence };
  }

  global.CopyTradingLensStyle = {
    buildEpisodes,
    runsOf,
    gridShape,
    isGridEpisode,
    multiplierRuns,
    classify,
    THRESHOLDS,
    median,
    HOUR_MS,
    DAY_MS
  };
})(window);
