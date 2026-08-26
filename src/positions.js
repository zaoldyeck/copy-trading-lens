(function attachPositions(global) {
  "use strict";

  // Reconstruct a Binance lead trader's CURRENT open positions from the two
  // endpoints that stay readable when the portfolio sets `positionShow: false`
  // ("this trader has set their current positions to private"):
  //
  //   lead-portfolio/position-history  — one row per position, including rows
  //     the exchange has NOT finished closing (`closed: null`,
  //     `status: "Partially Closed"`). Those rows leak entry price, leverage,
  //     open time and realized-so-far for a live position even while private.
  //   lead-portfolio/order-history     — every fill. Netting the fills that
  //     happened after the bucket was last provably flat rebuilds the exact
  //     current size, average entry, and the full add/reduce ladder.
  //
  // Measured on 2026-08-26 against 30 PUBLIC portfolios (positionShow: true),
  // whose `lead-data/positions` rows are the ground truth this reconstruction
  // never sees. All 227 open positions were
  // found with no false positives; fill netting reproduced size within 0.1% on
  // 224 of them and average entry within 1% on all 227. That run scored the
  // netting-only version; the reconciliation below was added afterwards to
  // close the size gap on the outliers it exposed, and has not been re-scored
  // over the full 30-portfolio set — only over the 12 positions of the
  // portfolio the gap was diagnosed on, where it is exact.
  //
  // The position-history row's `maxOpenInterest - closedVolume` did NOT: it
  // understates any position that was scaled back INTO after a partial close,
  // because maxOpenInterest is a peak, not a cumulative open volume (measured
  // wrong on 4 of 8 positions on one portfolio). So fills are the size
  // authority and the row is the metadata authority.
  //
  // But the fill history is not complete either — order-history was observed
  // omitting an opening fill outright. The row's aggregates catch exactly that,
  // so the two sources are reconciled against each other rather than one being
  // trusted blindly; see reconcileAgainstPositionRow.

  // Binance reports futures quantities to at most 8 decimals (LOT_SIZE
  // stepSize floor across UM symbols). Netting in integer units of 1e-8
  // makes "is this bucket flat?" an exact question instead of a threshold
  // one — there is no dust epsilon to justify because there is no rounding.
  const HOUR_MS = 3600000;

  function toScaledQty(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return 0n;
    return BigInt(Math.round(amount * 1e8));
  }

  function fromScaledQty(scaled) {
    return Number(scaled) / 1e8;
  }

  function absBig(value) {
    return value < 0n ? -value : value;
  }

  function num(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeSide(side) {
    const text = String(side || "").toUpperCase();
    if (text === "LONG" || text === "SHORT" || text === "BOTH") return text;
    return "";
  }

  // Binance runs a portfolio in one of two position modes and the two
  // endpoints disagree about how to name them: order-history reports
  // `positionSide: "BOTH"` in one-way mode but `"LONG"/"SHORT"` in hedge
  // mode, while position-history and lead-data/positions always report a
  // direction. Bucketing on the raw field silently splits a one-way symbol
  // into a key nothing else uses — the single biggest source of "position not
  // found" in the 2026-08-26 hold-out run before this normalization existed.
  function bucketKeyOf(symbol, positionSide) {
    const side = normalizeSide(positionSide);
    return side === "LONG" || side === "SHORT" ? `${symbol}|${side}` : `${symbol}|NET`;
  }

  function isOneWayBucket(key) {
    return key.endsWith("|NET");
  }

  function symbolOfKey(key) {
    return key.slice(0, key.lastIndexOf("|"));
  }

  function positionHistorySide(row) {
    const side = String(row?.side || "").toUpperCase();
    return side === "SHORT" ? "SHORT" : "LONG";
  }

  function positionClosedMs(row) {
    return num(row?.closed, 0);
  }

  /**
   * Latest instant at which each bucket was provably flat, i.e. the close time
   * of the newest fully-closed position on that symbol/side. Fills after this
   * instant, and only those, belong to whatever is open now.
   *
   * A one-way symbol is flat when its newest closed row closed, regardless of
   * that row's direction, because one-way mode cannot hold both directions.
   */
  function flatAnchors(positionHistory, oneWaySymbols) {
    const anchors = new Map();
    for (const row of positionHistory || []) {
      const closed = positionClosedMs(row);
      if (!closed) continue;
      const symbol = String(row.symbol || "");
      if (!symbol) continue;
      const key = oneWaySymbols.has(symbol)
        ? `${symbol}|NET`
        : `${symbol}|${positionHistorySide(row)}`;
      anchors.set(key, Math.max(anchors.get(key) || 0, closed));
    }
    return anchors;
  }

  function signedFillDelta(order, key) {
    const executed = toScaledQty(order.executedQty);
    if (executed === 0n) return 0n;
    if (isOneWayBucket(key)) {
      return order.side === "BUY" ? executed : -executed;
    }
    const long = key.endsWith("|LONG");
    if (long) return order.side === "BUY" ? executed : -executed;
    return order.side === "SELL" ? -executed : executed;
  }

  /**
   * Replay one bucket's fills into a live position.
   *
   * Cost basis follows Binance's own entry-price semantics: adds raise the
   * weighted average, reduces take cost out proportionally (they do NOT move
   * the entry price), and a fill large enough to flip direction restarts the
   * basis at the flipped remainder's price.
   */
  function replayFills(key, fills) {
    let signedQty = 0n;
    let costBasis = 0;
    let realizedFromExchange = 0;
    let peakQty = 0n;
    let closedQty = 0n;
    let openedAt = 0;
    let lastFillAt = 0;
    let addCount = 0;
    let reduceCount = 0;
    const events = [];

    for (const fill of fills) {
      const delta = signedFillDelta(fill, key);
      if (delta === 0n) continue;
      const price = num(fill.avgPrice, 0);
      const time = num(fill.orderUpdateTime, num(fill.orderTime, 0));
      const opening = signedQty === 0n || (delta > 0n) === (signedQty > 0n);

      if (opening) {
        if (signedQty === 0n) {
          openedAt = time;
          costBasis = 0;
          peakQty = 0n;
          closedQty = 0n;
        } else {
          addCount += 1;
        }
        costBasis += fromScaledQty(absBig(delta)) * price;
        signedQty += delta;
        events.push({ time, kind: "open", qty: fromScaledQty(absBig(delta)), price, pnl: 0, orderType: fill.type });
      } else {
        const reduce = absBig(delta) < absBig(signedQty) ? absBig(delta) : absBig(signedQty);
        const priorQty = absBig(signedQty);
        const avgEntry = priorQty > 0n ? costBasis / fromScaledQty(priorQty) : 0;
        costBasis -= avgEntry * fromScaledQty(reduce);
        closedQty += reduce;
        reduceCount += 1;
        const direction = signedQty > 0n ? 1 : -1;
        const fillPnl = num(fill.totalPnl, (price - avgEntry) * fromScaledQty(reduce) * direction);
        realizedFromExchange += num(fill.totalPnl, 0);
        events.push({ time, kind: "close", qty: fromScaledQty(reduce), price, pnl: fillPnl, orderType: fill.type });
        signedQty += delta;
        if (signedQty !== 0n && (signedQty > 0n) !== (direction > 0)) {
          // Flipped through zero: the leftover is a brand-new position.
          costBasis = fromScaledQty(absBig(signedQty)) * price;
          openedAt = time;
          peakQty = 0n;
          closedQty = 0n;
          addCount = 0;
          reduceCount = 0;
        } else if (signedQty === 0n) {
          costBasis = 0;
        }
      }
      if (absBig(signedQty) > peakQty) peakQty = absBig(signedQty);
      lastFillAt = time;
    }

    if (signedQty === 0n) return null;
    const qty = fromScaledQty(absBig(signedQty));
    return {
      side: signedQty > 0n ? "LONG" : "SHORT",
      qty,
      entryPrice: qty > 0 ? costBasis / qty : 0,
      peakQty: fromScaledQty(peakQty),
      closedQty: fromScaledQty(closedQty),
      realizedPnl: realizedFromExchange,
      openedAt,
      lastFillAt,
      addCount,
      reduceCount,
      fillCount: events.length,
      events
    };
  }

  /**
   * Leverage is the one field fill netting cannot recover — an order carries no
   * leverage. Prefer the still-open position-history row, then the most recent
   * closed position on the same symbol (traders keep a per-symbol leverage far
   * more often than they change it), and say which one was used so the UI never
   * presents an inference as a reading.
   */
  function leverageFor(symbol, side, openRow, positionHistory) {
    if (openRow && num(openRow.leverage, 0) > 0) {
      return { leverage: num(openRow.leverage, 0), source: "position" };
    }
    let best = null;
    for (const row of positionHistory || []) {
      if (String(row.symbol) !== symbol) continue;
      if (positionHistorySide(row) !== side) continue;
      const closed = positionClosedMs(row);
      if (!closed) continue;
      if (!best || closed > best.closed) best = { closed, leverage: num(row.leverage, 0) };
    }
    if (best && best.leverage > 0) return { leverage: best.leverage, source: "inferredFromSameSymbol" };
    return { leverage: 0, source: "unknown" };
  }

  function openPositionRows(positionHistory) {
    const byKey = new Map();
    for (const row of positionHistory || []) {
      if (positionClosedMs(row)) continue;
      const key = `${row.symbol}|${positionHistorySide(row)}`;
      const previous = byKey.get(key);
      if (!previous || num(row.opened, 0) > num(previous.opened, 0)) byKey.set(key, row);
    }
    return byKey;
  }

  /**
   * @param {object} raw  the provider payload for one Binance lead portfolio
   * @returns {{positions: object[], coverage: object}}
   */
  function reconstructBinanceOpenPositions(raw) {
    const positionHistory = Array.isArray(raw?.positionHistory) ? raw.positionHistory : [];
    const orderHistory = Array.isArray(raw?.orderHistory) ? raw.orderHistory : [];
    const orderStatus = raw?.historyStatus?.orderHistory || {};
    const positionStatus = raw?.historyStatus?.positionHistory || {};

    const oneWaySymbols = new Set();
    for (const order of orderHistory) {
      if (normalizeSide(order.positionSide) === "BOTH") oneWaySymbols.add(String(order.symbol));
    }

    const anchors = flatAnchors(positionHistory, oneWaySymbols);

    const buckets = new Map();
    let oldestOrderMs = Number.POSITIVE_INFINITY;
    for (const order of orderHistory) {
      const time = num(order.orderUpdateTime, num(order.orderTime, 0));
      if (time > 0 && time < oldestOrderMs) oldestOrderMs = time;
      const key = bucketKeyOf(String(order.symbol), order.positionSide);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(order);
    }
    if (!Number.isFinite(oldestOrderMs)) oldestOrderMs = 0;

    const openRows = openPositionRows(positionHistory);
    const positions = [];
    const seen = new Set();

    for (const [key, fills] of buckets) {
      fills.sort((a, b) => num(a.orderUpdateTime, 0) - num(b.orderUpdateTime, 0));
      const anchor = anchors.get(key) || 0;
      const afterFlat = fills.filter((fill) => num(fill.orderUpdateTime, 0) > anchor);
      if (!afterFlat.length) continue;
      const replayed = replayFills(key, afterFlat);
      if (!replayed) continue;

      const symbol = symbolOfKey(key);
      const openRow = openRows.get(`${symbol}|${replayed.side}`) || null;
      const leverage = leverageFor(symbol, replayed.side, openRow, positionHistory);
      // The fills only reconstruct the position if they reach back past the
      // last flat point. When order history is depth-capped, its oldest row can
      // start AFTER the anchor, in which case the opening fills are missing and
      // the netted size is a floor, not the size.
      const fillsReachAnchor = anchor > 0
        ? oldestOrderMs <= anchor
        : orderStatus.complete !== false;
      const reconciliation = reconcileAgainstPositionRow(replayed, openRow);
      if (reconciliation.correction) {
        replayed.qty += reconciliation.correction;
        replayed.peakQty = Math.max(replayed.peakQty, reconciliation.exchangePeakQty);
      }

      positions.push(buildPosition({
        symbol,
        side: replayed.side,
        replayed,
        openRow,
        leverage,
        confidence: reconciliation.correction
          ? "reconciled"
          : (fillsReachAnchor ? "exact" : "partialFills"),
        qtySource: reconciliation.correction ? "orderNettingReconciled" : "orderNetting",
        reconciliation,
        oneWay: isOneWayBucket(key)
      }));
      seen.add(`${symbol}|${replayed.side}`);
    }

    // A position whose opening fills fell outside the fetched order history
    // still shows up as an unclosed position-history row. Its size can only be
    // estimated (peak minus closed), which understates any scale-back-in — but
    // reporting an understated position beats reporting none at all, as long as
    // the row says so.
    for (const [key, row] of openRows) {
      if (seen.has(key)) continue;
      const [symbol, side] = [symbolOfKey(key), key.slice(key.lastIndexOf("|") + 1)];
      const remaining = num(row.maxOpenInterest, 0) - num(row.closedVolume, 0);
      if (!(remaining > 0)) continue;
      const leverage = leverageFor(symbol, side, row, positionHistory);
      positions.push(buildPosition({
        symbol,
        side,
        replayed: {
          side,
          qty: remaining,
          entryPrice: num(row.avgCost, 0),
          peakQty: num(row.maxOpenInterest, 0),
          closedQty: num(row.closedVolume, 0),
          realizedPnl: num(row.closingPnl, 0),
          openedAt: num(row.opened, 0),
          lastFillAt: num(row.updateTime, 0),
          addCount: 0,
          reduceCount: num(row.closedVolume, 0) > 0 ? 1 : 0,
          fillCount: 0,
          events: []
        },
        openRow: row,
        leverage,
        confidence: "estimated",
        qtySource: "positionHistoryRemainder",
        oneWay: oneWaySymbols.has(symbol)
      }));
    }

    positions.sort((a, b) => b.openedAt - a.openedAt);

    return {
      positions,
      coverage: {
        orderHistoryComplete: orderStatus.complete !== false,
        orderHistoryFetched: num(orderStatus.fetched, orderHistory.length),
        orderHistoryTotal: num(orderStatus.total, orderHistory.length),
        positionHistoryComplete: positionStatus.complete !== false,
        oldestOrderMs,
        oneWayMode: oneWaySymbols.size > 0,
        exactCount: positions.filter((p) => p.confidence === "exact").length,
        estimatedCount: positions.filter((p) => p.confidence === "estimated").length,
        reconciledCount: positions.filter((p) => p.confidence === "reconciled").length,
        partialFillsCount: positions.filter((p) => p.confidence === "partialFills").length
      }
    };
  }

  /**
   * Cross-check the netted fills against the exchange's own aggregates for the
   * same position, and repair the size when they disagree.
   *
   * Measured 2026-08-26 on portfolio 5156305122364875520: order-history omitted
   * one 40-unit opening fill on SPCXUSDT, so netting reported 400 against a real
   * 440. The omission is invisible in the fills themselves — but position-history
   * independently reports `maxOpenInterest` (the position's peak size) and
   * `closedVolume` (everything closed out of it), and the netted peak came up
   * exactly 40 short of that peak while the netted closed volume matched.
   *
   * Since every unit of CLOSING volume is accounted for, opening volume that the
   * peak proves existed but the fills never showed must still be open — so it is
   * added back. Across the 8 positions on that portfolio this repair was exact
   * where fills were short and a no-op everywhere else.
   *
   * Residual limitation: `maxOpenInterest` is a maximum, not a sum, so an opening
   * fill omitted AFTER the peak leaves no trace here. That is why a repaired
   * position keeps a `reconciled` confidence rather than claiming to be exact.
   */
  function reconcileAgainstPositionRow(replayed, openRow) {
    if (!openRow) return { checked: false, correction: 0 };
    const exchangePeakQty = num(openRow.maxOpenInterest, 0);
    const exchangeClosedQty = num(openRow.closedVolume, 0);
    if (!(exchangePeakQty > 0)) return { checked: false, correction: 0 };

    const missingOpenVolume = Math.max(0, exchangePeakQty - replayed.peakQty);
    const missingCloseVolume = Math.max(0, exchangeClosedQty - replayed.closedQty);
    const correction = missingOpenVolume - missingCloseVolume;
    return {
      checked: true,
      exchangePeakQty,
      exchangeClosedQty,
      nettedPeakQty: replayed.peakQty,
      nettedClosedQty: replayed.closedQty,
      missingOpenVolume,
      missingCloseVolume,
      correction: Number.isFinite(correction) && correction !== 0 ? correction : 0
    };
  }

  function buildPosition({ symbol, side, replayed, openRow, leverage, confidence, qtySource, reconciliation, oneWay }) {
    const direction = side === "SHORT" ? -1 : 1;
    const qty = replayed.qty;
    const entryPrice = replayed.entryPrice;
    const entryNotional = qty * entryPrice;
    const peakQty = Math.max(replayed.peakQty, qty);
    const closedQty = replayed.closedQty;
    return {
      symbol,
      side,
      direction,
      oneWayMode: Boolean(oneWay),
      qty,
      entryPrice,
      entryNotional,
      leverage: leverage.leverage,
      leverageSource: leverage.source,
      // Initial margin the position consumed at entry. Binance charges margin
      // on entry notional / leverage; mark-to-market moves land in unrealized
      // PnL, not in this number.
      initialMargin: leverage.leverage > 0 ? entryNotional / leverage.leverage : null,
      openedAt: replayed.openedAt,
      lastFillAt: replayed.lastFillAt,
      // Filled in by enrichWithMarks, which is where "now" is known.
      ageHours: null,
      peakQty,
      closedQty,
      closedRatio: peakQty > 0 ? closedQty / peakQty : 0,
      partiallyClosed: closedQty > 0,
      addCount: replayed.addCount,
      reduceCount: replayed.reduceCount,
      fillCount: replayed.fillCount,
      realizedPnl: replayed.realizedPnl,
      marginMode: openRow ? String(openRow.isolated || "") : "",
      exchangeStatus: openRow ? String(openRow.status || "") : "",
      positionId: openRow ? String(openRow.positionId || "") : "",
      confidence,
      qtySource,
      reconciliation: reconciliation || { checked: false, correction: 0 },
      events: replayed.events,
      // Filled in by enrichWithMarks once mark prices are known.
      markPrice: null,
      notional: null,
      unrealizedPnl: null,
      roi: null,
      pnlPercentOnNotional: null
    };
  }

  /**
   * Attach mark-price-derived numbers. Binance values open futures positions on
   * MARK price, not last trade price — using last price would put this panel on
   * a different caliber than the exchange's own PnL and liquidation engine.
   *
   * @param {object[]} positions
   * @param {Record<string, number>} markBySymbol
   * @param {{nowMs: number, marginBalance?: number}} context
   */
  function enrichWithMarks(positions, markBySymbol, context = {}) {
    const nowMs = num(context.nowMs, 0);
    const marginBalance = num(context.marginBalance, 0);
    return (positions || []).map((position) => {
      const mark = num(markBySymbol?.[position.symbol], 0);
      const enriched = { ...position };
      enriched.ageHours = position.openedAt && nowMs > position.openedAt
        ? (nowMs - position.openedAt) / HOUR_MS
        : null;
      if (!mark) return enriched;
      enriched.markPrice = mark;
      enriched.notional = position.qty * mark;
      enriched.unrealizedPnl = (mark - position.entryPrice) * position.qty * position.direction;
      enriched.pnlPercentOnNotional = position.entryPrice > 0
        ? ((mark - position.entryPrice) / position.entryPrice) * position.direction
        : null;
      enriched.roi = position.initialMargin > 0 ? enriched.unrealizedPnl / position.initialMargin : null;
      enriched.notionalToMarginBalance = marginBalance > 0 ? enriched.notional / marginBalance : null;
      enriched.unrealizedToMarginBalance = marginBalance > 0 ? enriched.unrealizedPnl / marginBalance : null;
      return enriched;
    });
  }

  function summarizePortfolio(positions, marginBalance) {
    const rows = Array.isArray(positions) ? positions : [];
    let grossNotional = 0;
    let longNotional = 0;
    let shortNotional = 0;
    let unrealized = 0;
    let realizedOnOpen = 0;
    let marginUsed = 0;
    let priced = 0;
    for (const position of rows) {
      const notional = num(position.notional, 0);
      grossNotional += notional;
      if (position.direction > 0) longNotional += notional; else shortNotional += notional;
      unrealized += num(position.unrealizedPnl, 0);
      realizedOnOpen += num(position.realizedPnl, 0);
      marginUsed += num(position.initialMargin, 0);
      if (position.markPrice) priced += 1;
    }
    const balance = num(marginBalance, 0);
    return {
      openCount: rows.length,
      pricedCount: priced,
      grossNotional,
      longNotional,
      shortNotional,
      netNotional: longNotional - shortNotional,
      grossLeverage: balance > 0 ? grossNotional / balance : null,
      unrealizedPnl: unrealized,
      unrealizedToMarginBalance: balance > 0 ? unrealized / balance : null,
      realizedOnOpenPositions: realizedOnOpen,
      marginUsed,
      marginUsedToBalance: balance > 0 ? marginUsed / balance : null,
      longShortRatio: shortNotional > 0 ? longNotional / shortNotional : null,
      concentration: grossNotional > 0
        ? Math.max(0, ...rows.map((p) => num(p.notional, 0) / grossNotional))
        : 0
    };
  }

  global.CopyTradingLensPositions = {
    reconstructBinanceOpenPositions,
    reconcileAgainstPositionRow,
    enrichWithMarks,
    summarizePortfolio,
    // exported for tests
    replayFills,
    bucketKeyOf
  };
})(typeof window !== "undefined" ? window : globalThis);
