(function attachProviders(global) {
  "use strict";

  const BINANCE_BASE = "https://www.binance.com";
  const OKX_BASE = "https://www.okx.com";
  const PAGE_SIZE = 100;
  const LIST_PAGE_SIZE = 30;
  const BINANCE_TIME_RANGES = ["7D", "30D", "90D", "180D", "365D"];

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForResume(waitUntilResumed) {
    if (typeof waitUntilResumed === "function") await waitUntilResumed();
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  async function fetchJson(url, options = {}) {
    const { waitUntilResumed, ...requestOptions } = options;
    await waitForResume(waitUntilResumed);
    const headers = {
      "accept": "application/json, text/plain, */*",
      "content-type": "application/json",
      "clienttype": "web",
      "lang": document.documentElement.lang || "zh-TC",
      ...options.headers
    };

    let response;
    try {
      // Everything this extension reads is public (friendly lead data, futures
      // market data, OKX ecotrade/public), so requests are anonymous: no cookies
      // and no csrftoken. The user's exchange session guards real funds, and a
      // burst of automated requests carrying it, or an authenticated call missing
      // the page's own device headers, is exactly what an exchange risk engine
      // flags. Guarded by scripts/test-request-identity.mjs.
      response = await fetch(url, {
        cache: "no-store",
        ...requestOptions,
        credentials: "omit",
        headers
      });
    } catch (error) {
      // fetch() only rejects when no HTTP response arrived at all (network, CORS, abort).
      throw fetchFailure(`Network failure for ${url}: ${error instanceof Error ? error.message : String(error)}`, { retriable: true });
    }
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {
      throw fetchFailure(`Non-JSON response from ${url}: HTTP ${response.status}`, {
        status: response.status,
        retriable: isRetriableHttpStatus(response.status)
      });
    }
    if (!response.ok) {
      const code = json?.code ?? null;
      throw fetchFailure(`HTTP ${response.status} from ${url}: ${code ?? json?.msg ?? ""}`, {
        status: response.status,
        code,
        retriable: isRetriableHttpStatus(response.status) || RETRIABLE_BINANCE_CODES.has(String(code))
      });
    }
    return json;
  }

  // Binance application codes that mean "ask again later", both seen on the copy-trade
  // endpoints: 11012005 系統目前忙碌中 (system busy) and 90801003 請求次數過多 (too many
  // requests; 2026-09-13 it failed order-history for two traders in one session, and the
  // analysis then read "no orders" as "no martingale" and still recommended copying).
  const RETRIABLE_BINANCE_CODES = new Set(["11012005", "90801003"]);

  // 408 timeout, 418/429 rate-limit bans, and any 5xx are the server's refusals to answer
  // now, not answers.
  function isRetriableHttpStatus(status) {
    return status === 408 || status === 418 || status === 429 || status >= 500;
  }

  function fetchFailure(message, { status = null, code = null, retriable = false } = {}) {
    const error = new Error(message);
    error.status = status;
    error.code = code;
    error.retriable = retriable;
    return error;
  }

  function isRetriable(error) {
    return Boolean(error && error.retriable);
  }

  // Every read keeps asking until the exchange actually answers. An analysis built on a
  // history abandoned mid-read reports missing risk as absent risk, so a refusal the server
  // tells us is temporary is never allowed to end a read; only a real answer (data, or a
  // non-retriable error) does.
  async function untilAnswered(fn, waitUntilResumed) {
    let lastRetryError = "";
    for (let attempt = 1; ; attempt += 1) {
      await waitForResume(waitUntilResumed);
      try {
        return { value: await fn(), retries: attempt - 1, lastRetryError };
      } catch (error) {
        if (!isRetriable(error)) throw error;
        lastRetryError = error.message;
        await waitForResume(waitUntilResumed);
        await sleep(retryDelayMs(attempt));
      }
    }
  }

  function requireBinanceOk(path, response) {
    if (response?.code && response.code !== "000000") throw binanceCodeError(path, response);
    return response;
  }

  async function safeFetch(label, fn) {
    try {
      const data = await fn();
      return { label, ok: true, data };
    } catch (error) {
      return { label, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function postBinance(path, payload, waitUntilResumed) {
    const { value } = await untilAnswered(async () => requireBinanceOk(path, await fetchJson(`${BINANCE_BASE}${path}`, {
      method: "POST",
      body: JSON.stringify(payload),
      waitUntilResumed
    })), waitUntilResumed);
    return value;
  }

  async function getBinance(path, waitUntilResumed) {
    const { value } = await untilAnswered(async () => requireBinanceOk(path, await fetchJson(`${BINANCE_BASE}${path}`, {
      method: "GET",
      waitUntilResumed
    })), waitUntilResumed);
    return value;
  }

  function binanceDataList(response) {
    if (Array.isArray(response?.data)) return response.data;
    return asArray(response?.data?.list);
  }

  function binanceCodeError(path, response) {
    const code = response?.code || "UNKNOWN";
    const message = response?.message || response?.msg || "Unknown Binance response";
    return fetchFailure(`Binance ${path} returned code ${code}: ${message}`, {
      code: String(code),
      retriable: RETRIABLE_BINANCE_CODES.has(String(code))
    });
  }

  function retryDelayMs(attempt) {
    const base = Math.min(15000, 500 * (2 ** Math.min(attempt - 1, 5)));
    return base + Math.floor(Math.random() * 250);
  }

  async function fetchBinancePagedPage(path, portfolioId, pageNumber, pageSize, waitUntilResumed) {
    const { value, retries, lastRetryError } = await untilAnswered(async () => requireBinanceOk(path,
      await fetchJson(`${BINANCE_BASE}${path}`, {
        method: "POST",
        body: JSON.stringify({ portfolioId, pageNumber, pageSize }),
        waitUntilResumed
      })), waitUntilResumed);
    return { response: value, retries, lastRetryError };
  }

  // Binance's paged history endpoints report a `total` count but silently hard-cap
  // how deep they'll actually paginate (observed: order-history stops returning any
  // rows past page 61/pageSize 100 = 6100 records, regardless of a much larger
  // stated `total`). A short page below that depth is usually a transient blip, but
  // past the cap it repeats forever — treating every short page as transient spins
  // the loop indefinitely. MAX_PREMATURE_RETRIES bounds the transient case (same
  // small-bounded-retry convention as fetchBinancePagedPage's own backoff) before
  // accepting the depth cap and reporting the fetch as incomplete instead of hanging.
  const MAX_PREMATURE_RETRIES = 3;

  function rowIdentity(row) {
    return JSON.stringify(row);
  }

  // These endpoints are offset-paginated over a NEWEST-FIRST list that the trader
  // keeps writing to while we read it. Every fill that lands mid-pagination pushes
  // the whole list down one index, so the next fixed offset window starts one row
  // earlier than it should and re-serves rows we already hold. Blindly appending
  // therefore inflates the row count with duplicates, the `rows.length >= total`
  // stop condition fires early, and the OLDEST rows are silently never fetched.
  //
  // Measured 2026-08-26 on portfolio 5156305122364875520: 1796 rows fetched, 2 of
  // them duplicates, and the position rebuilt from those fills came out 40 units
  // short of what the exchange reported as open. The shift only ever duplicates —
  // it cannot invent or reorder rows — so trimming the overlap between the tail we
  // already hold and the head of each new page restores the exact sequence.
  //
  // Overlap is matched by position, not by a global key set: two genuinely
  // distinct fills can be byte-identical (same millisecond, size and price on a
  // grid strategy), and a global de-duplication would delete one of them.
  function overlapLength(tailRows, headRows) {
    // Identities are computed once per row rather than inside the comparison
    // loop: a naive version re-serializes the same rows O(pageSize) times, which
    // on a 61-page order history is hundreds of thousands of redundant
    // JSON.stringify calls on the extension's critical path.
    const tail = tailRows.map(rowIdentity);
    const head = headRows.map(rowIdentity);
    const maxOverlap = Math.min(tail.length, head.length);
    for (let length = maxOverlap; length > 0; length -= 1) {
      let matches = true;
      for (let offset = 0; offset < length; offset += 1) {
        if (tail[tail.length - length + offset] !== head[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) return length;
    }
    return 0;
  }

  // Measured 2026-10-02 (reports/order-history-pacing-2026-10-02.txt, local): every new order-history page answers
  // code 11012005 "system busy" twice before it answers, and bursts of those trip 90801003. Spacing the pages 120 / 500 /
  // 1000 ms, fixed 150 / 800 ms retries and three pages in parallel all took 54-69 s for 12 pages (the existing backoff:
  // 65 s), so the throughput is bounded server-side and faster polling only adds requests. The loading bar is the answer.
  async function fetchBinancePagedDetailed(path, portfolioId, onProgress, waitUntilResumed) {
    const rows = [];
    let total = null;
    let totalAtPreviousPage = null;
    let pages = 0;
    let retryCount = 0;
    let lastRetryError = "";
    let prematureRetries = 0;
    let depthLimited = false;
    let duplicateRows = 0;
    for (let pageNumber = 1; ; pageNumber += 1) {
      const page = await fetchBinancePagedPage(path, portfolioId, pageNumber, PAGE_SIZE, waitUntilResumed);
      const response = page.response;
      retryCount += page.retries;
      if (page.lastRetryError) lastRetryError = page.lastRetryError;
      const pageRows = binanceDataList(response);
      const responseTotal = response?.data?.total !== undefined && response?.data?.total !== null
        ? Number(response.data.total)
        : null;
      if (Number.isFinite(responseTotal)) total = responseTotal;

      const prematureShortPage = Number.isFinite(total)
        && pageNumber * PAGE_SIZE < total
        && pageRows.length < PAGE_SIZE;
      if (prematureShortPage) {
        prematureRetries += 1;
        if (prematureRetries <= MAX_PREMATURE_RETRIES) {
          lastRetryError = `Binance ${path} page ${pageNumber} returned short data before total was reached`;
          await waitForResume(waitUntilResumed);
          await sleep(retryDelayMs(prematureRetries));
          pageNumber -= 1;
          continue;
        }
        lastRetryError = `Binance ${path} stopped returning data at page ${pageNumber} (fetched ${rows.length} of reported total ${total}) — API depth limit, not a transient error`;
        depthLimited = true;
        pages = pageNumber - 1;
        break;
      }
      prematureRetries = 0;

      pages = pageNumber;
      // A page can only re-serve rows the list gained since the previous page, and at
      // most that many. Without this bound, genuinely identical fills (a scalper's
      // split orders share second, price and size) that straddle a page boundary on
      // an idle account are trimmed as drift. Measured 2026-09-13: 5 of 5,374 real
      // fills dropped from a copy portfolio whose summary never moved during the read.
      const growth = Number.isFinite(total) && Number.isFinite(totalAtPreviousPage)
        ? Math.max(total - totalAtPreviousPage, 0)
        : 0;
      totalAtPreviousPage = total;
      const overlap = Math.min(overlapLength(rows.slice(-PAGE_SIZE), pageRows), growth);
      // Reported after each page rather than at the end: these histories take
      // tens of seconds to walk, and a reader staring at a blank positions tab
      // has no way to tell "still reading" from "broken".
      duplicateRows += overlap;
      const freshRows = overlap ? pageRows.slice(overlap) : pageRows;
      rows.push(...freshRows);
      if (typeof onProgress === "function") {
        onProgress({ fetched: rows.length, total: Number.isFinite(total) ? total : null, pages });
      }
      // An entirely overlapping page means the list shifted by a full page or the
      // endpoint is repeating itself; either way there is nothing further to read.
      if (pageRows.length && !freshRows.length) break;
      // A short page that the premature check above did NOT flag is the real end
      // of the list. This has to end the loop regardless of `total`, because the
      // rows prepended during the read inflate `total` beyond anything this pass
      // can ever collect — `rows.length >= total` alone would spin forever on any
      // account that traded while we were reading it.
      if (pageRows.length < PAGE_SIZE) break;
      if (Number.isFinite(total) && rows.length >= total) break;
      await waitForResume(waitUntilResumed);
      await sleep(120);
    }
    return {
      rows,
      total: Number.isFinite(total) ? total : rows.length,
      fetched: rows.length,
      pages,
      complete: !depthLimited,
      // Non-zero means the trader wrote to this history while we were reading it.
      // The overlap trim already repaired the sequence; this is kept so callers can
      // see that the read raced a live account rather than sat on a static list.
      duplicateRows,
      retryCount,
      lastRetryError
    };
  }

  async function fetchBinanceListPage(timeRange, pageNumber, nickname = "", extraParams = {}, waitUntilResumed) {
    const response = await postBinance("/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list", {
      pageNumber,
      pageSize: LIST_PAGE_SIZE,
      timeRange,
      dataType: "ROI",
      favoriteOnly: false,
      hideFull: false,
      nickname,
      order: "DESC",
      userAsset: 0,
      ...extraParams
    }, waitUntilResumed);
    return {
      total: Number(response?.data?.total ?? 0),
      rows: asArray(response?.data?.list)
    };
  }

  async function fetchBinanceListItem(portfolioId, timeRange = "30D", nickname = "", waitUntilResumed, options = {}) {
    if (options.isSettingPage) return null;
    if (nickname) {
      const filtered = await fetchBinanceListPage(timeRange, 1, nickname, {}, waitUntilResumed);
      const found = filtered.rows.find((row) => String(row.leadPortfolioId) === String(portfolioId));
      if (found) return { item: found, source: "nickname", searchedPages: 1, total: filtered.total };
    }

    const maxPages = 3;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await fetchBinanceListPage(timeRange, pageNumber, "", {}, waitUntilResumed);
      const rows = page.rows;
      const found = rows.find((row) => String(row.leadPortfolioId) === String(portfolioId));
      if (found) return { item: found, source: "scan", searchedPages: pageNumber, total: page.total };
      if (rows.length < LIST_PAGE_SIZE) break;
      await waitForResume(waitUntilResumed);
      await sleep(120);
    }
    return null;
  }

  async function fetchBinancePerformanceWindows(portfolioId, detail, waitUntilResumed, options = {}) {
    if (options.isSettingPage) {
      return { windows: {}, endpointResults: {} };
    }
    const nickname = String(detail?.nickname || detail?.nicknameTranslate || "").trim();
    const endpointResults = {};
    const windows = {};

    await Promise.all(BINANCE_TIME_RANGES.map(async (timeRange) => {
      const result = await safeFetch(`performance:${timeRange}`, () =>
        fetchBinanceListItem(portfolioId, timeRange, nickname, waitUntilResumed, options)
      );
      endpointResults[`performance:${timeRange}`] = result;
      if (result.ok && result.data?.item) {
        windows[timeRange] = {
          ...result.data.item,
          timeRange,
          lookupSource: result.data.source,
          searchedPages: result.data.searchedPages,
          total: result.data.total
        };
      }
    }));

    return { windows, endpointResults };
  }

  async function fetchBinanceLead(context, options = {}) {
    let portfolioId = context.id;
    const isSettingPage = context.pageType === "copy-setting";
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const onProgressive = typeof options.onProgressive === "function" ? options.onProgressive : null;
    const waitUntilResumed = typeof options.waitUntilResumed === "function" ? options.waitUntilResumed : null;
    const progressFor = (label) => (onProgress
      ? (event) => onProgress({ label, ...event })
      : undefined);
    const visibleText = document.body?.innerText || "";
    const pageTitle = document.title;
    const endpointResults = {};

    // Ensure portfolioId uses cached lead trader ID if resolved
    if (isSettingPage && context.mode === "edit" && context.copyPortfolioId) {
      if (copyPortfolioToLeadMap.has(context.copyPortfolioId)) {
        portfolioId = copyPortfolioToLeadMap.get(context.copyPortfolioId);
        context.id = portfolioId;
      }
    }

    const detailResult = await safeFetch("detail", () =>
      getBinance(`/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${encodeURIComponent(portfolioId)}`, waitUntilResumed)
    );
    endpointResults.detail = detailResult;

    const detailData = detailResult.ok ? (detailResult.data?.data || {}) : {};

    // What every progressive event carries: the read so far. Each piece lands in `view` as its
    // fetch finishes, and an event is a snapshot of the whole view, so a slow piece finishing
    // late can never overwrite a faster one with its old, emptier state.
    const view = {
      detail: detailData,
      performanceWindows: {},
      listItem: {},
      livePositions: [],
      positionHistory: [],
      orderHistory: [],
      transferHistory: [],
      positionMarks: null,
      marketHistory: null,
      historyStatus: {},
      // Which pieces of the read have landed, set by the fetch that lands them. The UI draws a value only when the
      // pieces it is computed from are loaded, and a loading placeholder otherwise; a read that never reports
      // `loaded` (a cached snapshot) counts as complete.
      loaded: { detail: true, positions: false, marks: false, orders: false, market: false }
    };
    const rawNow = () => ({
      id: portfolioId,
      url: location.href,
      pageTitle,
      visibleText,
      ...view,
      historyStatus: { ...view.historyStatus },
      loaded: { ...view.loaded },
      endpointResults: { ...endpointResults }
    });
    const emit = (stage) => onProgressive?.({ stage, raw: rawNow() });

    // Progressive update Stage 1: detail metadata ready (~150ms)
    emit("detail");

    // Guard: pause check directly after detail (preserves test-fetch-pause.mjs invariant)
    await waitForResume(waitUntilResumed);

    // Concurrently fetch livePositions & positionHistory first (~300ms)
    const [live, positionHistory] = await Promise.all([
      safeFetch("livePositions", () =>
        getBinance(`/bapi/futures/v1/friendly/future/copy-trade/lead-data/positions?portfolioId=${encodeURIComponent(portfolioId)}`, waitUntilResumed)
      ),
      safeFetch("positionHistory", () =>
        fetchBinancePagedDetailed("/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/position-history", portfolioId, progressFor("positionHistory"), waitUntilResumed)
      )
    ]);
    endpointResults.livePositions = live;
    endpointResults.positionHistory = positionHistory;
    const positionData = positionHistory.ok ? positionHistory.data : {};
    const positionRows = positionHistory.ok ? asArray(positionData.rows) : [];
    const liveRows = live.ok ? binanceDataList(live.data) : [];
    const nowMs = Date.now();

    Object.assign(view, { livePositions: liveRows, positionHistory: positionRows });
    view.loaded.positions = true;
    view.historyStatus.positionHistory = historyStatusOf(positionHistory, positionData);
    // Progressive update Stage 2: positions ready. The stop-loss radar already has a first
    // reading from fills and close prices; its mark-candle refinement lands as "marks" below.
    emit("positions");

    // Mark candles for every position's own life, every symbol, read while the long order and
    // transfer histories below are still paging. Lands as its own event.
    const marksRead = fetchBinancePositionMarks(positionRows, { waitUntilResumed, onProgress: progressFor("marks") }).then((positionMarks) => {
      view.positionMarks = positionMarks;
      view.loaded.marks = true;
      endpointResults.positionMarks = {
        label: "positionMarks",
        ok: positionMarks.failed.length === 0,
        data: { symbols: Object.keys(positionMarks.symbols).length },
        ...(positionMarks.failed.length ? { error: `${positionMarks.failed.length} symbols failed: ${positionMarks.failed.map((entry) => entry.symbol).join(", ")}` } : {})
      };
      emit("marks");
      return positionMarks;
    });

    // Concurrently fetch performance windows, orderHistory, and transferHistory
    const [performance, orderHistory, transferHistory] = await Promise.all([
      fetchBinancePerformanceWindows(portfolioId, detailData, waitUntilResumed, { isSettingPage }),
      safeFetch("orderHistory", () =>
        fetchBinancePagedDetailed("/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history", portfolioId, progressFor("orderHistory"), waitUntilResumed)
      ),
      safeFetch("transferHistory", () =>
        fetchBinancePagedDetailed("/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/transfer-history", portfolioId, progressFor("transferHistory"), waitUntilResumed)
      )
    ]);
    Object.assign(endpointResults, performance.endpointResults);
    endpointResults.orderHistory = orderHistory;
    endpointResults.transferHistory = transferHistory;

    const orderData = orderHistory.ok ? orderHistory.data : {};
    const transferData = transferHistory.ok ? transferHistory.data : {};
    const orderRows = asArray(orderData.rows);

    Object.assign(view, {
      performanceWindows: performance.windows,
      listItem: performance.windows["30D"] || performance.windows["365D"] || {},
      orderHistory: orderRows,
      transferHistory: asArray(transferData.rows)
    });
    view.historyStatus.orderHistory = historyStatusOf(orderHistory, orderData);
    view.historyStatus.transferHistory = historyStatusOf(transferHistory, transferData);
    view.loaded.orders = true;
    // Progressive update Stage 3: orders & performance windows ready
    emit("orders");

    await marksRead;

    // Funding and mark prices for EVERY symbol the fills and positions touched, from the oldest
    // fill/position to now: what the account earned or paid between a fill and today beyond the
    // fills themselves (src/equity.js). No cap on the symbol count: a trader of 50 symbols is read
    // in full; fetchBinanceMarketHistory reads a few symbols at a time so a long list waits on
    // 429 backoff instead of flooding it.
    const fillTimes = orderRows.map(global.CopyTradingLensPositions.fillTimeOf).filter((time) => time > 0);
    const positionTimes = positionRows.map((row) => Number(row.opened || row.openTime)).filter((time) => time > 0);
    const allTimes = [...fillTimes, ...positionTimes];
    const touchedSymbols = [...new Set([...positionRows, ...orderRows].map((row) => row.symbol).filter(Boolean))];
    const startMs = allTimes.length ? Math.min(...allTimes) : nowMs;
    view.marketHistory = (touchedSymbols.length && startMs < nowMs)
      ? { nowMs, ...(await fetchBinanceMarketHistory(touchedSymbols, startMs, nowMs, { waitUntilResumed, onProgress: progressFor("market") })) }
      : { nowMs, startMs: nowMs, endMs: nowMs, symbols: {}, failed: [] };
    view.loaded.market = true;

    return rawNow();
  }

  function historyStatusOf(result, data) {
    return result.ok
      ? {
        total: data.total,
        fetched: data.fetched,
        pages: data.pages,
        complete: data.complete,
        duplicateRows: data.duplicateRows,
        retryCount: data.retryCount,
        lastRetryError: data.lastRetryError
      }
      : { total: 0, fetched: 0, pages: 0, complete: false, error: result.error };
  }

  // Binance values open futures positions on MARK price (fapi premiumIndex),
  // not on last trade price: unrealized PnL, ROI and liquidation all key off
  // the mark. Pricing a reconstructed position on last-traded price would put
  // this panel on a different caliber than the number the exchange itself
  // shows the trader. www.binance.com proxies /fapi/*, so this stays inside
  // the host permissions the extension already holds.
  //
  // /fapi/v1/premiumIndex costs request weight 1 when a symbol is given and 10
  // when it is not (and then returns every symbol). So the cheapest call shape
  // is per-symbol up to 10 symbols and one all-symbols call beyond that — the
  // crossover is the documented weight, not a tuning choice.
  const PREMIUM_INDEX_ALL_WEIGHT = 10;

  async function fetchBinanceMarkPrices(symbols, options = {}) {
    const waitUntilResumed = typeof options.waitUntilResumed === "function" ? options.waitUntilResumed : null;
    const wanted = Array.from(new Set(asArray(symbols).map((value) => String(value)).filter(Boolean)));
    if (!wanted.length) return { marks: {}, missing: [], fetchedAtMs: Date.now(), source: "none" };

    const marks = {};
    let source = "";
    if (wanted.length > PREMIUM_INDEX_ALL_WEIGHT) {
      const all = await safeFetch("mark:all", () =>
        untilAnswered(() => fetchJson(`${BINANCE_BASE}/fapi/v1/premiumIndex`, {
          method: "GET",
          waitUntilResumed
        }), waitUntilResumed).then((answer) => answer.value)
      );
      source = "premiumIndex:all";
      if (all.ok) {
        const wantedSet = new Set(wanted);
        for (const row of asArray(all.data)) {
          if (!wantedSet.has(String(row.symbol))) continue;
          const price = Number(row.markPrice);
          if (Number.isFinite(price) && price > 0) marks[String(row.symbol)] = price;
        }
      }
    } else {
      source = "premiumIndex:perSymbol";
      const results = await Promise.all(wanted.map((symbol) =>
        safeFetch(`mark:${symbol}`, () =>
          untilAnswered(() => fetchJson(`${BINANCE_BASE}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`, {
            method: "GET",
            waitUntilResumed
          }), waitUntilResumed).then((answer) => answer.value)
        )
      ));
      results.forEach((result, index) => {
        const price = Number(result.ok ? result.data?.markPrice : NaN);
        if (Number.isFinite(price) && price > 0) marks[wanted[index]] = price;
      });
    }

    const missing = wanted.filter((symbol) => !(symbol in marks));
    return { marks, missing, fetchedAtMs: Date.now(), source };
  }

  // What the account went through between a fill and now, beyond the fills
  // themselves: the funding every held position paid or received, and the mark
  // price that valued everything else held at that fill. Both are public
  // market data behind www.binance.com's /fapi proxy.
  //
  // GET /fapi/v1/fundingRate returns at most 1000 rows per call and each row
  // carries the markPrice it settled on; GET /fapi/v1/markPriceKlines returns
  // at most 1500 candles (USDⓈ-M Futures API, Market Data, 2026-09-14). Pages
  // walk forward from startTime until a short page.
  const FUNDING_PAGE_LIMIT = 1000;
  const KLINE_PAGE_LIMIT = 1500;
  const HOUR_MS = 3600000;

  async function fapiPages(pathFor, timeOf, limit, startMs, endMs, waitUntilResumed) {
    const rows = [];
    let cursor = startMs;
    for (;;) {
      const { value } = await untilAnswered(() => fetchJson(`${BINANCE_BASE}${pathFor(cursor)}`, {
        method: "GET",
        waitUntilResumed
      }), waitUntilResumed);
      const page = asArray(value);
      rows.push(...page);
      if (page.length < limit) break;
      const next = timeOf(page[page.length - 1]) + 1;
      if (!(next > cursor) || next > endMs) break;
      cursor = next;
    }
    return rows;
  }

  async function fetchBinanceSymbolHistory(symbol, startMs, endMs, options = {}) {
    const waitUntilResumed = typeof options.waitUntilResumed === "function" ? options.waitUntilResumed : null;
    const encoded = encodeURIComponent(symbol);
    const [funding, klines] = await Promise.all([
      fapiPages((from) => `/fapi/v1/fundingRate?symbol=${encoded}&startTime=${from}&endTime=${endMs}&limit=${FUNDING_PAGE_LIMIT}`, (row) => Number(row.fundingTime), FUNDING_PAGE_LIMIT, startMs, endMs, waitUntilResumed),
      // Hourly: the candle opening at or before startMs is included so every
      // moment in the range sits inside a candle.
      fapiPages((from) => `/fapi/v1/markPriceKlines?symbol=${encoded}&interval=1h&startTime=${from}&endTime=${endMs}&limit=${KLINE_PAGE_LIMIT}`, (row) => Number(row[0]), KLINE_PAGE_LIMIT, Math.floor(startMs / HOUR_MS) * HOUR_MS, endMs, waitUntilResumed)
    ]);
    return {
      funding: funding.map((row) => [Number(row.fundingTime), Number(row.fundingRate), Number(row.markPrice)])
        .filter(([time, rate, mark]) => time > 0 && Number.isFinite(rate) && mark > 0),
      marks: klines.map((row) => [Number(row[0]), Number(row[1]), Number(row[6]), Number(row[4]), Number(row[2]), Number(row[3])])
        .filter(([openTime, open, closeTime, close]) => openTime > 0 && open > 0 && closeTime > openTime && close > 0)
    };
  }

  // Funding shares a 500-per-5-minutes limit per IP with /fapi/v1/fundingInfo;
  // symbols are read a few at a time so a trader of hundreds of symbols waits
  // on 429 backoff instead of flooding it.
  const MARKET_HISTORY_CONCURRENCY = 4;

  // Mark-price candles for every position's own life, for every symbol the positions touched.
  //
  // The stop-loss radar needs each position's deepest adverse move while it was open, which no
  // position or order row carries. Binance values positions on MARK price, so the series is
  // /fapi/v1/markPriceKlines. Hourly candles with whole-candle overlap, what this used to read,
  // are wrong for the traders it was built for: 玄冥二老 and 星辰社区-海 hold a median 1 minute
  // (p90 11 and 45), so a position inherited its whole hour's extremes, and the radar was off by
  // more than 10 ROE points in 31% / 23% of positions (reports/stoploss-review-three-2026-10-02.txt).
  // A position is therefore read at the resolution of its own life:
  //   held up to 6 h   1-minute candles over [opened, closed];
  //   held longer      1-minute candles for the first and last partial hours, hourly candles
  //                    for the whole hours between (an hour's high/low is exact over that hour).
  // Windows of one symbol that overlap or sit within 5 minutes of each other share one request.
  // A page asks for exactly the candles it needs (limit < 100 weighs 1, < 500 weighs 2, < 1000
  // weighs 5, 1000+ weighs 10 of the 2400/min IP budget). Measured on the three traders reviewed
  // 2026-10-02 (482 positions, one window each): weight stayed under 600 in total.
  const MARK_CANDLES_CONCURRENCY = 6;
  const MINUTE_MS = 60000;
  const MINUTE_ONLY_MAX_MS = 6 * HOUR_MS;
  const MINUTE_WINDOW_GAP_MS = 5 * MINUTE_MS;
  const HOUR_WINDOW_GAP_MS = HOUR_MS;

  function mergeWindows(windows, gapMs) {
    const merged = [];
    for (const [from, to] of [...windows].sort((x, y) => x[0] - y[0])) {
      const last = merged[merged.length - 1];
      if (last && from - last[1] <= gapMs) last[1] = Math.max(last[1], to);
      else merged.push([from, to]);
    }
    return merged;
  }

  /**
   * Candle-open-time windows (inclusive) to read per symbol. Rows are position-history rows; an open row
   * (no close time) has no outcome for the radar to judge and is not planned.
   * @returns {Map<string, {minutes: number[][], hours: number[][]}>}
   */
  function planMarkWindows(rows) {
    const plan = new Map();
    for (const row of asArray(rows)) {
      const symbol = String(row?.symbol || "");
      const opened = Number(row?.opened || row?.openTime);
      const closedAt = Number(row?.closed);
      if (!symbol || !(opened > 0) || !(closedAt >= opened)) continue;
      const first = Math.floor(opened / MINUTE_MS) * MINUTE_MS;
      const last = Math.floor(closedAt / MINUTE_MS) * MINUTE_MS;
      const windows = plan.get(symbol) || { minutes: [], hours: [] };
      plan.set(symbol, windows);
      if (closedAt - opened <= MINUTE_ONLY_MAX_MS) {
        windows.minutes.push([first, last]);
        continue;
      }
      const headEnd = Math.ceil(opened / HOUR_MS) * HOUR_MS;
      const tailStart = Math.floor(closedAt / HOUR_MS) * HOUR_MS;
      if (headEnd > first) windows.minutes.push([first, headEnd - MINUTE_MS]);
      windows.minutes.push([Math.max(first, tailStart), last]);
      if (tailStart - headEnd >= HOUR_MS) windows.hours.push([headEnd, tailStart - HOUR_MS]);
    }
    for (const windows of plan.values()) {
      windows.minutes = mergeWindows(windows.minutes, MINUTE_WINDOW_GAP_MS);
      windows.hours = mergeWindows(windows.hours, HOUR_WINDOW_GAP_MS);
    }
    return plan;
  }

  // [openTime, high, low] of every candle opening in [fromMs, toMs].
  async function markKlineRows(symbol, interval, stepMs, fromMs, toMs, waitUntilResumed) {
    const rows = [];
    let cursor = fromMs;
    while (cursor <= toMs) {
      const limit = Math.min(KLINE_PAGE_LIMIT, Math.floor((toMs - cursor) / stepMs) + 1);
      const { value } = await untilAnswered(() => fetchJson(
        `${BINANCE_BASE}/fapi/v1/markPriceKlines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${cursor}&endTime=${toMs}&limit=${limit}`,
        { method: "GET", waitUntilResumed }
      ), waitUntilResumed);
      const page = asArray(value);
      // A successful HTTP response can still be an empty, truncated or gapped history. Never publish it as
      // complete market coverage: every requested candle must be present at its semantic time key.
      if (page.length !== limit) throw new Error(`Incomplete MARK candles for ${symbol} ${interval}: expected ${limit}, received ${page.length}`);
      for (let i = 0; i < page.length; i += 1) {
        const [time, high, low] = [Number(page[i][0]), Number(page[i][2]), Number(page[i][3])];
        if (time !== cursor + i * stepMs || !(high >= low && low > 0)) {
          throw new Error(`Invalid or gapped MARK candles for ${symbol} ${interval} at ${cursor + i * stepMs}`);
        }
        rows.push([time, high, low]);
      }
      cursor += limit * stepMs;
    }
    return rows;
  }

  /**
   * @param {{waitUntilResumed?: function, onProgress?: function}} options onProgress({done, total}) after each window
   * @returns {Promise<{symbols: Record<string, {minutes: number[][], hours: number[][]}>, failed: {symbol: string, error: string}[]}>}
   *   symbols[s].minutes / .hours: [openTime, high, low] sorted by time; stoploss.js lifeCandles() reads them.
   */
  async function fetchBinancePositionMarks(rows, options = {}) {
    const waitUntilResumed = typeof options.waitUntilResumed === "function" ? options.waitUntilResumed : null;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const symbols = {};
    const failedBySymbol = new Map();
    const jobs = [];
    for (const [symbol, windows] of planMarkWindows(rows)) {
      symbols[symbol] = { minutes: [], hours: [] };
      for (const [from, to] of windows.minutes) jobs.push({ symbol, kind: "minutes", interval: "1m", stepMs: MINUTE_MS, from, to });
      for (const [from, to] of windows.hours) jobs.push({ symbol, kind: "hours", interval: "1h", stepMs: HOUR_MS, from, to });
    }
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next];
        next += 1;
        if (!failedBySymbol.has(job.symbol)) {
          try {
            symbols[job.symbol][job.kind].push(...await markKlineRows(job.symbol, job.interval, job.stepMs, job.from, job.to, waitUntilResumed));
          } catch (error) {
            failedBySymbol.set(job.symbol, error?.message || String(error));
          }
        }
        done += 1;
        onProgress?.({ done, total: jobs.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(MARK_CANDLES_CONCURRENCY, jobs.length) }, worker));
    for (const symbol of failedBySymbol.keys()) delete symbols[symbol];
    for (const data of Object.values(symbols)) {
      data.minutes.sort((x, y) => x[0] - y[0]);
      data.hours.sort((x, y) => x[0] - y[0]);
    }
    return { symbols, failed: [...failedBySymbol].map(([symbol, error]) => ({ symbol, error })) };
  }

  async function fetchBinanceMarketHistory(symbols, startMs, endMs, options = {}) {
    const waitUntilResumed = typeof options.waitUntilResumed === "function" ? options.waitUntilResumed : null;
    const wanted = Array.from(new Set(asArray(symbols).map(String).filter(Boolean)));
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const bySymbol = {};
    const failed = [];
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < wanted.length) {
        const symbol = wanted[next];
        next += 1;
        const result = await safeFetch(`market:${symbol}`, () => fetchBinanceSymbolHistory(symbol, startMs, endMs, { waitUntilResumed }));
        if (result.ok) bySymbol[symbol] = result.data;
        else failed.push({ symbol, error: result.error });
        done += 1;
        onProgress?.({ done, total: wanted.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(MARKET_HISTORY_CONCURRENCY, wanted.length) }, worker));
    return { startMs, endMs, symbols: bySymbol, failed };
  }

  // OKX v5: code "0" is success; 50011 is its rate-limit refusal (docs: Error Code → REST API).
  // Any other non-zero code is an answer that carries no data and must surface as a failure,
  // not as an empty history.
  const RETRIABLE_OKX_CODES = new Set(["50011"]);

  function requireOkxOk(pathWithQuery, response) {
    const code = response?.code;
    if (code === undefined || code === null || String(code) === "0") return response;
    throw fetchFailure(`OKX ${pathWithQuery} returned code ${code}: ${response?.msg || ""}`, {
      code: String(code),
      retriable: RETRIABLE_OKX_CODES.has(String(code))
    });
  }

  async function okxGet(pathWithQuery, waitUntilResumed) {
    const { value } = await untilAnswered(async () =>
      requireOkxOk(pathWithQuery, await fetchJson(`${OKX_BASE}${pathWithQuery}`, {
        method: "GET",
        waitUntilResumed
      })), waitUntilResumed);
    return value;
  }

  async function findOkxCandidate(uniqueName, waitUntilResumed) {
    const rankTypes = ["yieldRatio", "pnl", "followPnl", "aum", "winRatio"];
    for (const rankType of rankTypes) {
      for (let start = 1; start <= 181; start += 20) {
        const response = await okxGet(`/priapi/v5/ecotrade/public/follow-rank?size=20&type=${rankType}&start=${start}`, waitUntilResumed);
        const ranks = asArray(response?.data?.[0]?.ranks);
        const found = ranks.find((row) => String(row.uniqueName) === String(uniqueName));
        if (found) return found;
        if (ranks.length < 20) break;
        await waitForResume(waitUntilResumed);
        await sleep(100);
      }
    }
    return null;
  }

  async function fetchOkxLead(context, options = {}) {
    const waitUntilResumed = typeof options.waitUntilResumed === "function" ? options.waitUntilResumed : null;
    const uniqueName = context.id;
    const visibleText = document.body?.innerText || "";
    const pageTitle = document.title;

    const [candidate, positionHistory, livePositions] = await Promise.all([
      safeFetch("candidate", () => findOkxCandidate(uniqueName, waitUntilResumed)),
      safeFetch("positionHistory", () =>
        okxGet(`/priapi/v5/ecotrade/public/position-history?uniqueName=${encodeURIComponent(uniqueName)}&limit=100`, waitUntilResumed)
      ),
      safeFetch("livePositions", () =>
        okxGet(`/priapi/v5/ecotrade/public/trader/position-detail?uniqueName=${encodeURIComponent(uniqueName)}`, waitUntilResumed)
      )
    ]);

    return {
      id: uniqueName,
      url: location.href,
      pageTitle,
      visibleText,
      candidate: candidate.ok ? (candidate.data || {}) : {},
      positionHistory: positionHistory.ok ? asArray(positionHistory.data?.data) : [],
      livePositions: livePositions.ok ? asArray(livePositions.data?.data) : [],
      endpointResults: { candidate, positionHistory, livePositions }
    };
  }

  const copyPortfolioToLeadMap = new Map();

  function saveMapping(copyId, leadId) {
    if (!copyId || !leadId || String(copyId) === String(leadId)) return;
    const cStr = String(copyId);
    const lStr = String(leadId);
    copyPortfolioToLeadMap.set(cStr, lStr);
    try {
      if (typeof sessionStorage !== "undefined") {
        const raw = sessionStorage.getItem("ctl_copy_to_lead_map");
        const obj = raw ? JSON.parse(raw) : {};
        obj[cStr] = lStr;
        sessionStorage.setItem("ctl_copy_to_lead_map", JSON.stringify(obj));
      }
    } catch (_e) {}
  }

  function loadMappingsFromStorage() {
    try {
      if (typeof sessionStorage !== "undefined") {
        const raw = sessionStorage.getItem("ctl_copy_to_lead_map");
        if (raw) {
          const obj = JSON.parse(raw);
          for (const [k, v] of Object.entries(obj)) {
            if (k && v && k !== v) copyPortfolioToLeadMap.set(k, v);
          }
        }
      }
    } catch (_e) {}
  }
  loadMappingsFromStorage();

  // Resource entries are per document, not per SPA route, so entries from a
  // previous route would name the wrong trader. The baseline is the URL the
  // document loaded with (every entry then belongs to it); only a later URL
  // change moves the cutoff forward.
  let lastNavigationTime = 0;
  let lastDetectedUrl = typeof location !== "undefined" ? location.href : "";

  function markNavigation(url = (typeof location !== "undefined" ? location.href : "")) {
    if (url && url !== lastDetectedUrl) {
      lastDetectedUrl = url;
      if (typeof performance !== "undefined" && typeof performance.now === "function") {
        lastNavigationTime = performance.now();
      }
    }
  }

  // copy-management shows each card's trader and its lead portfolio id as text
  // ("投資組合 ID: 5131…") but opens the setting page through a button, and the
  // copy portfolio id the next URL carries lives only in the page's React state
  // (invisible to an isolated-world content script). So the two are paired by
  // intent: remember the card the user pressed, then bind it to the copy-setting
  // URL that follows. Measured 2026-10-02 on copy-management: 0 anchors to
  // lead-details or copy-setting, ids present as card text.
  const LEAD_ID_PATTERN = /\b\d{16,20}\b/g;
  const PRESS_TTL_MS = 5000;
  let pressedLead = null;

  // The smallest ancestor holding any id is the card; if it holds several, the
  // press landed on a wrapper and names no single trader.
  function leadIdOfCard(target) {
    for (let node = target, depth = 0; node && depth < 12; node = node.parentElement, depth += 1) {
      const ids = new Set(String(node.innerText || "").match(LEAD_ID_PATTERN) || []);
      if (ids.size === 1) return [...ids][0];
      if (ids.size > 1) return null;
    }
    return null;
  }

  function rememberPressedCard(target, now = Date.now()) {
    const leadId = leadIdOfCard(target);
    pressedLead = leadId ? { leadId, at: now } : null;
  }

  function claimPressedLead(copyId) {
    const press = pressedLead;
    pressedLead = null;
    if (!press || Date.now() - press.at > PRESS_TTL_MS || press.leadId === copyId) return null;
    saveMapping(copyId, press.leadId);
    return press.leadId;
  }

  function findLeadPortfolioIdOnSettingPage(parsed = new URL(location.href)) {
    const mode = parsed.searchParams.get("mode");
    const paramId = parsed.searchParams.get("portfolioId");

    // In copy mode (not edit), searchParams portfolioId is the lead trader's portfolio ID directly
    if (mode !== "edit" && paramId) {
      return paramId;
    }

    if (!paramId) return null;

    markNavigation(parsed.href);

    if (copyPortfolioToLeadMap.has(paramId)) {
      return copyPortfolioToLeadMap.get(paramId);
    }

    const pressed = claimPressedLead(paramId);
    if (pressed) return pressed;

    // Fallback: resource entries the page itself requested for this route (the
    // content script cannot read response bodies, only URLs).
    try {
      if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
        const resources = performance.getEntriesByType("resource");
        for (let i = resources.length - 1; i >= 0; i--) {
          const entry = resources[i];
          // If we tracked navigation time, ignore resources fetched before this navigation
          if (lastNavigationTime > 0 && entry.startTime < (lastNavigationTime - 150)) {
            continue;
          }
          const entryUrl = entry.name || "";
          const match1 = entryUrl.match(/[?&]leadPortfolioId=(\d+)/);
          if (match1 && match1[1] !== paramId) {
            saveMapping(paramId, match1[1]);
            return match1[1];
          }
          const match2 = entryUrl.match(/\/lead-portfolio\/detail\?portfolioId=(\d+)/);
          if (match2 && match2[1] !== paramId) {
            saveMapping(paramId, match2[1]);
            return match2[1];
          }
        }
      }
    } catch (_e) {}

    return null;
  }

  function detectLeadPage(url = location.href) {
    const parsed = new URL(url);
    if (parsed.hostname === "www.binance.com") {
      const match = parsed.pathname.match(/\/copy-trading\/lead-details\/(\d+)/);
      if (match) return { platform: "Binance", id: match[1], pageType: "lead-details" };
      if (parsed.pathname.includes("/copy-trading/copy-setting")) {
        const mode = parsed.searchParams.get("mode") || "copy";
        const copyPortfolioId = parsed.searchParams.get("portfolioId");
        const id = findLeadPortfolioIdOnSettingPage(parsed);
        if (id) return { platform: "Binance", id, pageType: "copy-setting", mode, copyPortfolioId };
      }
    }
    if (parsed.hostname === "www.okx.com") {
      const match = parsed.pathname.match(/\/copy-trading\/account\/([A-Za-z0-9_-]+)/);
      if (match) return { platform: "OKX", id: match[1], pageType: "lead-details" };
    }
    return null;
  }

  async function fetchLeadData(context, options = {}) {
    if (context.platform === "Binance") return fetchBinanceLead(context, options);
    if (context.platform === "OKX") return fetchOkxLead(context, options);
    throw new Error(`Unsupported platform: ${context.platform}`);
  }

  global.CopyTradingLensProviders = {
    detectLeadPage,
    fetchLeadData,
    fetchBinanceListPage,
    fetchBinanceMarkPrices,
    fetchBinancePositionMarks,
    planMarkWindows,
    fetchBinanceMarketHistory,
    rememberPressedCard,
    markNavigation
  };
})(window);
