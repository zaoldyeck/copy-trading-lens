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

  // Which fills open, close or flip a position is decided in exactly one place,
  // CopyTradingLensPositions.replayPositions (src/positions.js), shared with the
  // open-position reconstruction. Never re-derive it here: one-way ("BOTH")
  // accounts flip through zero, and every hand-rolled copy of that rule so far
  // has dropped the flip.
  function buildEpisodes(orders) {
    const Positions = global.CopyTradingLensPositions;
    const byBook = new Map();
    for (const order of orders || []) {
      const key = Positions.bucketKeyOf(String(order.symbol || ""), order.positionSide);
      if (!byBook.has(key)) byBook.set(key, []);
      byBook.get(key).push(order);
    }
    const episodes = [];
    let orphanExits = 0;
    for (const [key, bookOrders] of byBook) {
      const symbol = key.slice(0, key.lastIndexOf("|"));
      const { positions, unmatchedFills } = Positions.replayPositions(key, bookOrders);
      orphanExits += unmatchedFills;
      for (const position of positions) {
        const fills = position.fills.map(({ order, entry, qty }) => {
          const price = toNumber(order.avgPrice);
          return {
            t: toNumber(order.orderTime),
            qty,
            price,
            notional: qty * price,
            type: String(order.type || "").toUpperCase(),
            // realised pnl belongs to the closing part of a flipping fill
            pnl: entry ? 0 : toNumber(order.totalPnl),
            entry
          };
        });
        if (!fills.some((fill) => fill.entry)) continue;
        episodes.push(finishEpisode({ symbol, direction: position.side, fills }, position.closed));
      }
    }
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
  // Rounds 1+2 (60 labelled traders): accuracy peaks for a minimum of 4-5
  // closed positions and for a window of 6-16 days.
  const MIN_CLOSED_EPISODES = 5;
  const MIN_SPAN_DAYS = 7;
  // Price-level tolerance, in steps: a random price lands within 0.1 of a
  // lattice step 20% of the time, so a majority on-lattice is far above chance.
  const LATTICE_TOLERANCE = 0.1;
  // A grid step at or below two maker fees (0.02% each on Binance USD-M base
  // tier) earns nothing per round trip, so smaller "steps" are not grid levels.
  const MIN_GRID_STEP_BPS = 4;
  // A grid levels must be traded again and again. Rounds 1-3: the grid
  // traders' passing books re-entered an exited level 27-93 times; books of
  // non-grid traders that looked evenly spaced re-entered 0-13 times, and two
  // of them passed with 1-2 re-entries on 5-9 entries — chance, not a grid.
  const MIN_GRID_REENTRIES = 15;
  const MIN_GRID_BOOKS = 1;
  // A trader is a grid trader when grid books carry real capital, not when one
  // symbol runs a small grid beside everything else. Rounds 1-4: the labelled
  // grid traders put 14-69% of their traded notional through grid books; a
  // maker scalper whose only grid book traded ~5 USDT lots put under 0.5%.
  // Below this the grid is reported as a secondary label. Set after round 4
  // was scored, so it has no holdout of its own yet.
  const MIN_GRID_NOTIONAL_SHARE = 0.05;
  // Lot rounding: a fixed-size grid's quantities (or notionals) stay within 5%.
  const LOT_TOLERANCE = 0.05;
  // Round-trip distance tolerance: on low-priced symbols one price tick is
  // ~10 bps, so a ~90 bps step rounds to +/-1 tick (~11%).
  const ROUND_TRIP_TOLERANCE = 0.15;
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
  // take-profit distance. Rounds 1-3 (90 labelled traders): accuracy is flat
  // (77 +/- 1) for any cut from 0.08 to 0.19 and falls off above 0.20, because
  // occasional averagers and discretionary traders overlap completely at
  // 0.06-0.14; 0.14 sits mid-plateau, and below it the share is shown as a
  // label instead of a family.
  const MIN_DEEP_ADD_SHARE = 0.14;
  // Share of closed positions that ended at a net loss. Rounds 1-3: traders
  // labelled as averaging without stops reach 0.08 at most, those with stops
  // start at 0.095 (one exception at 0.04); accuracy is flat from 0.06 to 0.12.
  const STOP_LOSS_SHARE = 0.09;
  // Positions held under a day on median are short-term; a day or more, swing.
  const SWING_HOLD_HOURS = 24;

  const THRESHOLDS = Object.freeze({
    MIN_CLOSED_EPISODES, MIN_SPAN_DAYS, MIN_GRID_BOOKS, MIN_GRID_NOTIONAL_SHARE, MIN_GRID_REENTRIES, MIN_MULTIPLIER, MIN_MULTIPLIER_EPISODE_SHARE,
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
  // levels, closes at grid levels, levels traded again. Tested on a book: every
  // fill on one symbol and side, because a grid that sells each lot as soon as
  // it rises goes flat between lots and never shows as one long position.
  // "Evenly spaced" is either a fixed price difference (arithmetic grid) or a
  // fixed percentage (geometric grid, which spreads wider as price rises).
  function gridShape(book) {
    const levels = [...new Set(book.entries.map((fill) => Number(fill.price.toPrecision(9))))].sort((a, b) => a - b);
    if (levels.length < 4) return null;
    const mid = levels[Math.floor(levels.length / 2)];
    const spacings = {
      arithmetic: (a, b) => (Math.abs(b - a) / mid) * 10000,
      geometric: (a, b) => Math.abs(Math.log(b / a)) * 10000
    };
    let best = null;
    for (const [kind, spacing] of Object.entries(spacings)) {
      const gaps = levels.slice(1).map((level, i) => spacing(levels[i], level));
      for (const candidate of gaps) {
        if (candidate < MIN_GRID_STEP_BPS) continue;
        const share = gaps.filter((gap) => Math.abs(gap / candidate - 1) <= LATTICE_TOLERANCE).length / gaps.length;
        if (!best || share > best.stepShare || (share === best.stepShare && candidate > best.step)) {
          best = { kind, spacing, step: candidate, stepShare: share };
        }
      }
    }
    if (!best) return null;
    const onLattice = (price) => {
      const steps = best.spacing(levels[0], price) / best.step;
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
    const lotShare = Math.max(modalShare(book.entries.map((f) => f.qty)), modalShare(book.entries.map((f) => f.notional)));
    const exitShare = book.exits.length ? book.exits.filter((f) => onLattice(f.price)).length / book.exits.length : 0;
    const exitsBefore = new Map();
    let exitsSoFar = 0;
    let reentries = 0;
    for (const fill of book.fills) {
      if (!fill.entry) {
        exitsSoFar += 1;
        continue;
      }
      const level = Number(fill.price.toPrecision(9));
      if (exitsBefore.has(level) && exitsBefore.get(level) < exitsSoFar) reentries += 1;
      exitsBefore.set(level, exitsSoFar);
    }
    return { kind: best.kind, step: best.step, stepShare: best.stepShare, lotShare, exitShare, reentries };
  }

  function books(episodes) {
    const bySide = new Map();
    for (const episode of episodes) {
      const key = `${episode.symbol}:${episode.direction}`;
      if (!bySide.has(key)) bySide.set(key, []);
      bySide.get(key).push(...episode.fills);
    }
    return [...bySide.entries()].map(([key, fills]) => {
      fills.sort((a, b) => a.t - b.t);
      return { key, fills, entries: fills.filter((f) => f.entry), exits: fills.filter((f) => !f.entry) };
    });
  }

  // Entries grouped by lot: a grid trades a fixed quantity (or a fixed
  // notional, which drifts in quantity as price moves), and may run more than
  // one lot on the same book over time.
  function lotClusters(entries) {
    const clusters = [];
    for (const key of ["qty", "notional"]) {
      let current = null;
      for (const fill of [...entries].sort((a, b) => a[key] - b[key])) {
        if (!current || fill[key] > current.base * (1 + LOT_TOLERANCE)) {
          current = { base: fill[key], fills: [] };
          clusters.push(current);
        }
        current.fills.push(fill);
      }
    }
    return clusters.map((cluster) => cluster.fills).filter((fills) => fills.length >= 4);
  }

  // Fixed lattice: one lot's entries sit on evenly spaced levels, exits close on
  // those levels, and exited levels are traded again.
  function latticeGrid(book, lot) {
    const lotFills = new Set(lot);
    const shape = gridShape({ fills: book.fills.filter((f) => !f.entry || lotFills.has(f)), entries: lot, exits: book.exits });
    return Boolean(shape) && shape.stepShare > 0.5 && shape.exitShare > 0.5 && shape.reentries >= MIN_GRID_REENTRIES_CURRENT.value;
  }

  // Moving lattice: each lot is closed a fixed step away from where it opened
  // and exited prices are traded again — the same definition on a lattice that
  // follows price (a grid re-centred as price trends).
  function roundTripGrid(book) {
    const long = book.key.endsWith(":LONG");
    const open = [];
    const steps = [];
    for (const fill of book.fills) {
      if (fill.entry) {
        open.push(fill);
        continue;
      }
      for (let i = open.length - 1; i >= 0; i -= 1) {
        if (Math.abs(open[i].qty / fill.qty - 1) > 0.01) continue;
        const entry = open.splice(i, 1)[0];
        const move = (fill.price / entry.price - 1) * 10000 * (long ? 1 : -1);
        if (move > 0) steps.push(move);
        break;
      }
    }
    if (steps.length < MIN_GRID_REENTRIES_CURRENT.value) return false;
    const near = (a, b) => Math.abs(a / b - 1) <= ROUND_TRIP_TOLERANCE;
    let step = null;
    let stepShare = 0;
    for (const candidate of steps) {
      if (candidate < MIN_GRID_STEP_BPS) continue;
      const share = steps.filter((value) => near(value, candidate)).length / steps.length;
      if (share > stepShare) {
        stepShare = share;
        step = candidate;
      }
    }
    if (!step || stepShare <= 0.5) return false;
    const bps = (a, b) => Math.abs(a / b - 1) * 10000;
    const exited = [];
    let reentries = 0;
    for (const fill of book.fills) {
      if (!fill.entry) {
        exited.push(fill);
      } else if (exited.some((exit) => Math.abs(exit.qty / fill.qty - 1) <= 0.01 && bps(exit.price, fill.price) <= step * ROUND_TRIP_TOLERANCE)) {
        reentries += 1;
      }
    }
    return reentries >= MIN_GRID_REENTRIES_CURRENT.value;
  }

  const MIN_GRID_REENTRIES_CURRENT = { value: MIN_GRID_REENTRIES };

  function isGridBook(book) {
    return roundTripGrid(book) || lotClusters(book.entries).some((lot) => latticeGrid(book, lot));
  }

  // A book whose positions mostly multiply their adds is a martingale's book:
  // its fixed take-profit and re-entries resemble a grid's round trips, but the
  // sizing is the martingale formula, not a fixed lot.
  function isMartingaleBook(bookEpisodes) {
    const added = bookEpisodes.filter((episode) => episode.entries.length > 1);
    return added.length > 0 && added.filter((episode) => multiplierRuns(episode).length).length / added.length > 0.5;
  }

  // Operator definition: each add against the position is a fixed multiple of
  // the one before. A run is the entries between two exits. Its adds are read
  // in order of depth, not fill time: a ladder placed in advance and swept in
  // one minute fills its deepest level first, yet each level
  // is still the previous one times the multiplier. Adds at or above the run's
  // opening price are not martingale layers and are left out. With three or
  // more layers the stake must grow by a constant ratio rather than a constant
  // amount — a linear ramp (29, 36, 42, 49 ...) is not a martingale. A base
  // order the same size as the first layer is the usual bot setup, so on runs
  // of five or more entries the first ratio alone may sit below the multiplier.
  function multiplierRuns(episode) {
    const found = [];
    for (const run of runsOf(episode.fills)) {
      if (run.length < 2) continue;
      const opening = run[0];
      const layers = [opening, ...run.slice(1)
        .filter((fill) => episode.against(fill.price) > episode.against(opening.price))
        .sort((a, b) => episode.against(a.price) - episode.against(b.price))];
      if (layers.length < 2) continue;
      const ratios = [];
      const steps = [];
      let valid = true;
      for (let i = 1; i < layers.length; i += 1) {
        const previous = layers[i - 1];
        const current = layers[i];
        const deeper = episode.against(current.price) > episode.against(previous.price);
        const ratio = current.notional / previous.notional;
        const baseOrder = i === 1 && layers.length >= 5;
        if (!deeper || (ratio < MIN_MULTIPLIER && !baseOrder)) {
          valid = false;
          break;
        }
        if (ratio >= MIN_MULTIPLIER) {
          ratios.push(ratio);
          steps.push(current.notional - previous.notional);
        }
      }
      if (!valid || !ratios.length) continue;
      if (ratios.length >= 2 && coefficientOfVariation(ratios.map(Math.log)) >= coefficientOfVariation(steps)) continue;
      found.push(ratios);
    }
    return found;
  }

  // How far price moved in the position's favour from its average entry to
  // its average exit. Measured from the average, not the first entry: an
  // averaging trader routinely takes profit below the first entry.
  function takeProfitBps(episode) {
    const exitQty = episode.exits.reduce((sum, fill) => sum + fill.qty, 0);
    const entryQty = episode.entries.reduce((sum, fill) => sum + fill.qty, 0);
    if (!exitQty || !entryQty) return null;
    const exitPrice = episode.exits.reduce((sum, fill) => sum + fill.price * fill.qty, 0) / exitQty;
    const entryPrice = episode.entries.reduce((sum, fill) => sum + fill.price * fill.qty, 0) / entryQty;
    const move = (exitPrice / entryPrice - 1) * 10000;
    return episode.direction === "LONG" ? move : -move;
  }

  function classify(orders, overrides = {}) {
    const {
      MIN_CLOSED_EPISODES, MIN_SPAN_DAYS, MIN_GRID_BOOKS, MIN_GRID_NOTIONAL_SHARE, MIN_GRID_REENTRIES, MIN_MULTIPLIER_EPISODE_SHARE,
      MAX_MULTIPLIER_SPREAD, MIN_DEEP_ADD_SHARE, STOP_LOSS_SHARE, SWING_HOLD_HOURS
    } = { ...THRESHOLDS, ...overrides };
    MIN_GRID_REENTRIES_CURRENT.value = MIN_GRID_REENTRIES;
    const { episodes, orphanExits } = buildEpisodes(orders);
    const closed = episodes.filter((episode) => episode.closed);
    const times = (orders || []).map((order) => toNumber(order.orderTime)).filter(Boolean);
    const spanDays = times.length ? (Math.max(...times) - Math.min(...times)) / DAY_MS : 0;
    const evidence = { episodes: episodes.length, closedEpisodes: closed.length, orphanExits, spanDays };
    // More exits of positions opened before the history than positions seen
    // whole: most of the trading visible in the window cannot be read.
    if (closed.length < MIN_CLOSED_EPISODES || spanDays < MIN_SPAN_DAYS || orphanExits > closed.length) {
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

    const episodesByBook = new Map();
    for (const episode of episodes) {
      const key = `${episode.symbol}:${episode.direction}`;
      if (!episodesByBook.has(key)) episodesByBook.set(key, []);
      episodesByBook.get(key).push(episode);
    }
    const gridBookKeys = books(episodes).filter((book) => !isMartingaleBook(episodesByBook.get(book.key)) && isGridBook(book)).map((book) => book.key);
    const gridBooks = gridBookKeys.length;
    const notionalOf = (list) => list.reduce((sum, episode) => sum + episode.entries.reduce((total, fill) => total + fill.notional, 0), 0);
    const totalNotional = notionalOf(episodes);
    const gridNotionalShare = totalNotional ? notionalOf(gridBookKeys.flatMap((key) => episodesByBook.get(key))) / totalNotional : 0;
    const grid = gridBooks >= MIN_GRID_BOOKS && gridNotionalShare >= MIN_GRID_NOTIONAL_SHARE;

    const holdHours = median(closed.map((episode) => (episode.end - episode.start) / HOUR_MS));
    Object.assign(evidence, {
      losingShare,
      takeProfitBps: takeProfit,
      deepAddShare,
      multiplierShare,
      multiplierMedian: median(multipliers),
      multiplierSpread,
      gridBooks,
      gridNotionalShare,
      holdHours
    });

    const secondary = [];
    let family;
    if (martingale && grid) {
      // Both formulas at once: the family is the one carrying more capital.
      const martingaleNotional = notionalOf(closed.filter((episode) => episode.entries.length > 1 && multiplierRuns(episode).length));
      const gridNotional = gridNotionalShare * totalNotional;
      family = gridNotional >= martingaleNotional ? "grid" : "martingale";
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
    if (!grid && gridBooks >= MIN_GRID_BOOKS) secondary.push("grid");
    if (losingShare === 0) secondary.push("neverRealisedLoss");
    return { family, secondary, evidence };
  }

  global.CopyTradingLensStyle = {
    buildEpisodes,
    runsOf,
    gridShape,
    books,
    lotClusters,
    isGridBook,
    multiplierRuns,
    classify,
    THRESHOLDS,
    median,
    HOUR_MS,
    DAY_MS
  };
})(window);
