(function attachEquity(global) {
  "use strict";

  // The account's equity at any moment inside the fetched fills, counted back
  // from today's margin balance (the exchange's own number, unrealised pnl
  // included) through everything that moved it since:
  //
  //   equity(t) = marginBalance
  //             - USDT paid in after t (plus USDT paid out)
  //             - price moves on every position held after t, marked to market
  //             - funding received after t
  //             + trading fees paid after t
  //
  // Each term is checked against the exchange. Position history's closingPnl is
  // the fills' totalPnl plus the funding the position settled, less fees:
  // across 16,027 cached rows whose whole life sits inside the fills, adding
  // funding (size held x settlement mark x rate) brings closingPnl - gross to
  // 1.8-5.0 bps of the notional traded (p10-p90), the maker/taker fee levels,
  // where leaving it out scatters rows that settled heavy funding from -99 to
  // +101 bps (tools/research/probe-closing-pnl-funding.mjs, 2026-09-14).
  // Binance's funding amount is position value at the mark price x rate
  // (FAQ "Introduction to Binance Futures Funding Rates"). Fees are not in any
  // fetched row, so each trader's fee rate is read off those same rows.
  //
  // Against the exchange's own totals (tools/research/probe-equity-countback.mjs,
  // 2026-09-14, 436 cached traders): Binance's 30D pnl is matched within 5% for
  // 189 of 372 (the count-back this replaced: 64), its 7D pnl for 165 of 420
  // (57), and equity before the first fill equals the opening investment within
  // 5% for 44 of 99 (7). On portfolio 5108371059752839168 the cumulative pnl
  // follows its ROI chart to 603 USDT on average over 58 days. The tails left
  // are not explained yet.
  //
  // Prices between fills come from hourly mark-price candles, interpolated
  // inside the hour. Positions with no fill inside the history are not seen,
  // and a hedge book's size before its first fetched fill is the smallest it
  // can have been (src/positions.js sizeAfterEachFill).

  function num(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function lastIndexAtOrBefore(sorted, time, timeOf) {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (timeOf(sorted[mid]) <= time) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  // Mark price at a moment from hourly candles [openTime, open, closeTime, close],
  // linear inside the candle; past the last candle, its close.
  function markReader(candles) {
    const rows = [...(candles || [])].sort((a, b) => a[0] - b[0]);
    return (time) => {
      if (!rows.length) return null;
      const i = lastIndexAtOrBefore(rows, time, (row) => row[0]);
      if (i < 0) return rows[0][1];
      const [openTime, open, closeTime, close] = rows[i];
      if (time >= closeTime) return close;
      return open + (close - open) * ((time - openTime) / (closeTime - openTime));
    };
  }

  const signOf = (side) => (side === "SHORT" ? -1 : 1);

  // Binance quantities carry at most 8 decimals (src/positions.js toScaledQty).
  const sameQty = (a, b) => Math.round(num(a, NaN) * 1e8) === Math.round(num(b, NaN) * 1e8);

  // One book's path as points in time, each with the price then and the signed
  // size held from then: every fill, plus two points no fill marks. A size a
  // stretch held before its first fetched fill starts at its row's opening
  // (or before the history, when no row dates it), priced at the mark then;
  // a stretch whose fills do not bring it to zero by its row's close goes flat
  // there, at the mark then.
  function bookPath(stretches, markAt) {
    const points = [];
    let sizeBefore = 0;
    stretches.forEach((stretch, index) => {
      const first = stretch.steps[0];
      const sign = signOf(first.side);
      if (stretch.shortfall > 0) {
        if (stretch.heldFrom > 0 && stretch.heldFrom < first.time) {
          points.push({ time: stretch.heldFrom, price: markAt(stretch.heldFrom) ?? first.price, size: stretch.shortfall * sign, fill: null });
        } else if (index === 0) {
          sizeBefore = stretch.shortfall * sign;
        }
      }
      for (const step of stretch.steps) points.push({ time: step.time, price: step.price, size: step.qty * signOf(step.side), fill: step });
      const last = points[points.length - 1];
      if (stretch.until > 0 && last.size !== 0) {
        // The row closed: whatever the fills left open (a closing fill Binance
        // omitted) is gone at its close.
        if (stretch.until === last.time) last.size = 0;
        else points.push({ time: stretch.until, price: markAt(stretch.until) ?? last.price, size: 0, fill: null });
      }
    });
    return { points, sizeBefore };
  }

  function sizeAt(path, time) {
    const i = lastIndexAtOrBefore(path.points, time, (point) => point.time);
    return i < 0 ? path.sizeBefore : path.points[i].size;
  }

  // Fee rate as a share of notional traded, from the trader's own rows whose
  // whole life is inside the fills: gross + funding - closingPnl over notional.
  function feeRateOf(stretchesByBook, positionHistory, fundingReceivedBetween) {
    let fees = 0;
    let traded = 0;
    let rows = 0;
    for (const row of positionHistory || []) {
      const closed = num(row.closed, 0);
      if (!(closed > 0)) continue;
      const side = String(row.side || "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
      const symbol = String(row.symbol || "");
      const key = stretchesByBook.has(`${symbol}|NET`) ? `${symbol}|NET` : `${symbol}|${side}`;
      // Starting flat, ending at the row's close, and adding up to the row's own
      // peak and closed volume: every fill of the position. Order history
      // omits fills (a 1,000 SPCXUSDT long shows one 475.74 close), and a
      // position missing some reads their pnl as a fee.
      const stretch = (stretchesByBook.get(key) || []).find((item) => item.until === closed && item.shortfall === 0 && !item.openedByFlip);
      if (!stretch) continue;
      const peak = Math.max(...stretch.steps.map((step) => step.qty));
      const closedQty = stretch.steps.reduce((sum, step, i) => {
        const before = i > 0 ? stretch.steps[i - 1].qty : 0;
        return step.qty < before ? sum + (before - step.qty) : sum;
      }, 0);
      if (!sameQty(peak, row.maxOpenInterest) || !sameQty(closedQty, row.closedVolume)) continue;
      const gross = stretch.steps.reduce((sum, step) => sum + step.pnl, 0);
      const notional = stretch.steps.reduce((sum, step) => sum + step.fillQty * step.price, 0);
      const funding = fundingReceivedBetween(key, stretch, stretch.steps[0].time, closed);
      if (funding === null || !(notional > 0)) continue;
      fees += gross + funding - num(row.closingPnl, 0);
      traded += notional;
      rows += 1;
    }
    return { rate: traded > 0 ? Math.max(0, fees / traded) : null, rows };
  }

  /**
   * @param {{orders: object[], positionHistory: object[], flows: {time: number, amount: number}[],
   *   marginBalance: number, market: {nowMs: number, symbols: Record<string, {funding: number[][], marks: number[][]}>}}} input
   *   flows: USDT into the account positive, out negative
   * @returns {null | {equityAt: (time: number) => number, paths: Map<string, object>, stretchesByBook: Map<string, object[]>, feeRate: number|null, feeRows: number, unpriced: string[]}}
   */
  function equityCountBack({ orders, positionHistory, flows, marginBalance, market }) {
    const P = global.CopyTradingLensPositions;
    if (!(marginBalance > 0) || !market || !(market.nowMs > 0)) return null;
    const nowMs = market.nowMs;

    const fillsByBook = new Map();
    for (const order of orders || []) {
      if (!(P.fillTimeOf(order) > 0)) continue;
      const key = P.bucketKeyOf(String(order.symbol || ""), order.positionSide);
      if (!fillsByBook.has(key)) fillsByBook.set(key, []);
      fillsByBook.get(key).push(order);
    }
    const stretchesByBook = new Map();
    const paths = new Map();
    const unpriced = new Set();
    for (const [key, fills] of fillsByBook) {
      const stretches = P.sizeAfterEachFill(key, fills, positionHistory);
      stretchesByBook.set(key, stretches);
      const symbol = key.slice(0, key.lastIndexOf("|"));
      const history = market.symbols?.[symbol];
      if (!history || !history.marks?.length) unpriced.add(symbol);
      const markAt = markReader(history?.marks);
      const { points, sizeBefore } = bookPath(stretches, markAt);
      paths.set(key, { key, symbol, points, sizeBefore, steps: stretches.flatMap((stretch) => stretch.steps), markAt, funding: [...(history?.funding || [])].sort((a, b) => a[0] - b[0]) });
    }

    // A position still open on the exchange whose book has no fill in the
    // history was held, untouched, the whole time: its size is what it opened
    // less what it closed, at least maxOpenInterest - closedVolume (a re-add
    // after a partial close before the history would make it larger).
    // Portfolio 4395375800392267008 held four such rows through a 30-day window
    // in which Binance reports 131K pnl and its 10 fills show none.
    for (const row of positionHistory || []) {
      if (num(row.closed, 0) > 0) continue;
      const symbol = String(row.symbol || "");
      const side = String(row.side || "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
      const key = `${symbol}|${side}`;
      if (!symbol || paths.has(key) || paths.has(`${symbol}|NET`)) continue;
      const size = (num(row.maxOpenInterest, 0) - num(row.closedVolume, 0)) * signOf(side);
      if (!size) continue;
      const history = market.symbols?.[symbol];
      if (!history || !history.marks?.length) unpriced.add(symbol);
      const markAt = markReader(history?.marks);
      const opened = num(row.opened, 0);
      const points = opened > 0 ? [{ time: opened, price: markAt(opened) ?? num(row.avgCost, 0), size, fill: null }] : [];
      paths.set(key, { key, symbol, points, sizeBefore: opened > 0 ? 0 : size, steps: [], markAt, funding: [...(history?.funding || [])].sort((a, b) => a[0] - b[0]) });
    }

    const fundingReceived = (path, from, until, sizeOf) => {
      let total = 0;
      for (const [time, rate, mark] of path.funding) {
        if (time <= from || time > until) continue;
        total += -sizeOf(time) * mark * rate;
      }
      return total;
    };
    const fee = feeRateOf(stretchesByBook, positionHistory, (key, stretch, from, until) => {
      const path = paths.get(key);
      if (!path || !market.symbols?.[path.symbol]) return null;
      const points = stretch.steps.map((step) => ({ time: step.time, size: step.qty * signOf(step.side) }));
      return fundingReceived(path, from, until, (time) => sizeAt({ points, sizeBefore: 0 }, time));
    });

    // Everything after a moment, as suffix sums over time-sorted events:
    // mark-to-market between consecutive fills of a book (the last one to the
    // mark now), funding settled on the size held, fees on notional traded.
    const events = [];
    for (const path of paths.values()) {
      const nowMark = path.markAt(nowMs);
      path.points.forEach((point, i) => {
        const nextPrice = i + 1 < path.points.length ? path.points[i + 1].price : (nowMark ?? point.price);
        events.push({ time: point.time, move: point.size * (nextPrice - point.price), fee: point.fill ? point.fill.fillQty * point.fill.price : 0, funding: 0 });
      });
      for (const [time, rate, mark] of path.funding) {
        if (time > nowMs) continue;
        const size = sizeAt(path, time);
        if (size) events.push({ time, move: 0, fee: 0, funding: -size * mark * rate });
      }
    }
    for (const flow of flows || []) events.push({ time: flow.time, move: 0, fee: 0, funding: 0, flow: flow.amount });
    events.sort((a, b) => a.time - b.time);
    const suffix = new Array(events.length + 1).fill(null).map(() => ({ move: 0, fee: 0, funding: 0, flow: 0 }));
    for (let i = events.length - 1; i >= 0; i -= 1) {
      suffix[i] = {
        move: suffix[i + 1].move + events[i].move,
        fee: suffix[i + 1].fee + events[i].fee,
        funding: suffix[i + 1].funding + events[i].funding,
        flow: suffix[i + 1].flow + (events[i].flow || 0)
      };
    }
    const feeRate = fee.rate;

    // Held at `time` (after any fill at that instant): the move from the mark
    // then to that book's next fill price, or to the mark now.
    const heldMove = (time) => {
      let total = 0;
      for (const path of paths.values()) {
        const i = lastIndexAtOrBefore(path.points, time, (point) => point.time);
        const size = i < 0 ? path.sizeBefore : path.points[i].size;
        if (!size) continue;
        const markThen = i >= 0 && path.points[i].time === time ? path.points[i].price : path.markAt(time);
        const next = i + 1 < path.points.length ? path.points[i + 1].price : path.markAt(nowMs);
        if (markThen === null || next === null) continue;
        total += size * (next - markThen);
      }
      return total;
    };

    const equityAt = (time) => {
      const after = suffix[lastIndexAtOrBefore(events, time, (event) => event.time) + 1];
      return marginBalance - after.flow - heldMove(time) - after.move - after.funding + (feeRate ?? 0) * after.fee;
    };

    return { equityAt, paths, stretchesByBook, feeRate, feeRows: fee.rows, unpriced: [...unpriced] };
  }

  global.CopyTradingLensEquity = { equityCountBack, markReader };
})(typeof window !== "undefined" ? window : globalThis);
