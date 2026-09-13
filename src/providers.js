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

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function csrfTokenFromCookie() {
    const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  async function fetchJson(url, options = {}) {
    const headers = {
      "accept": "application/json, text/plain, */*",
      "content-type": "application/json",
      "clienttype": "web",
      "lang": document.documentElement.lang || "zh-TC",
      ...options.headers
    };
    const csrf = csrfTokenFromCookie();
    if (csrf && !headers.csrftoken) headers.csrftoken = csrf;

    let response;
    try {
      response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        ...options,
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
  async function untilAnswered(fn) {
    let lastRetryError = "";
    for (let attempt = 1; ; attempt += 1) {
      try {
        return { value: await fn(), retries: attempt - 1, lastRetryError };
      } catch (error) {
        if (!isRetriable(error)) throw error;
        lastRetryError = error.message;
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

  async function postBinance(path, payload) {
    const { value } = await untilAnswered(async () => requireBinanceOk(path, await fetchJson(`${BINANCE_BASE}${path}`, {
      method: "POST",
      body: JSON.stringify(payload)
    })));
    return value;
  }

  async function getBinance(path) {
    const { value } = await untilAnswered(async () => requireBinanceOk(path, await fetchJson(`${BINANCE_BASE}${path}`, { method: "GET" })));
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

  async function fetchBinancePagedPage(path, portfolioId, pageNumber, pageSize) {
    const { value, retries, lastRetryError } = await untilAnswered(async () => requireBinanceOk(path,
      await fetchJson(`${BINANCE_BASE}${path}`, {
        method: "POST",
        body: JSON.stringify({ portfolioId, pageNumber, pageSize })
      })));
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

  async function fetchBinancePagedDetailed(path, portfolioId, onProgress) {
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
      const page = await fetchBinancePagedPage(path, portfolioId, pageNumber, PAGE_SIZE);
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

  async function fetchBinanceListPage(timeRange, pageNumber, nickname = "", extraParams = {}) {
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
    });
    return {
      total: Number(response?.data?.total ?? 0),
      rows: asArray(response?.data?.list)
    };
  }

  async function fetchBinanceListItem(portfolioId, timeRange = "30D", nickname = "") {
    if (nickname) {
      const filtered = await fetchBinanceListPage(timeRange, 1, nickname);
      const found = filtered.rows.find((row) => String(row.leadPortfolioId) === String(portfolioId));
      if (found) return { item: found, source: "nickname", searchedPages: 1, total: filtered.total };
    }

    const maxPages = 20;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await fetchBinanceListPage(timeRange, pageNumber, "");
      const rows = page.rows;
      const found = rows.find((row) => String(row.leadPortfolioId) === String(portfolioId));
      if (found) return { item: found, source: "scan", searchedPages: pageNumber, total: page.total };
      if (rows.length < LIST_PAGE_SIZE) break;
      await sleep(120);
    }
    return null;
  }

  async function fetchBinancePerformanceWindows(portfolioId, detail) {
    const nickname = String(detail?.nickname || detail?.nicknameTranslate || "").trim();
    const endpointResults = {};
    const windows = {};

    await Promise.all(BINANCE_TIME_RANGES.map(async (timeRange) => {
      const result = await safeFetch(`performance:${timeRange}`, () =>
        fetchBinanceListItem(portfolioId, timeRange, nickname)
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
    const portfolioId = context.id;
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const progressFor = (label) => (onProgress
      ? (event) => onProgress({ label, ...event })
      : undefined);
    const visibleText = document.body?.innerText || "";
    const pageTitle = document.title;
    const endpointResults = {};

    const detailResult = await safeFetch("detail", () =>
      getBinance(`/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/detail?portfolioId=${encodeURIComponent(portfolioId)}`)
    );
    endpointResults.detail = detailResult;

    const detailData = detailResult.ok ? (detailResult.data?.data || {}) : {};
    const performance = await fetchBinancePerformanceWindows(portfolioId, detailData);
    Object.assign(endpointResults, performance.endpointResults);

    const [live, positionHistory, orderHistory, transferHistory] = await Promise.all([
      safeFetch("livePositions", () =>
        getBinance(`/bapi/futures/v1/friendly/future/copy-trade/lead-data/positions?portfolioId=${encodeURIComponent(portfolioId)}`)
      ),
      safeFetch("positionHistory", () =>
        fetchBinancePagedDetailed("/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/position-history", portfolioId, progressFor("positionHistory"))
      ),
      safeFetch("orderHistory", () =>
        fetchBinancePagedDetailed("/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history", portfolioId, progressFor("orderHistory"))
      ),
      safeFetch("transferHistory", () =>
        fetchBinancePagedDetailed("/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/transfer-history", portfolioId, progressFor("transferHistory"))
      )
    ]);
    endpointResults.livePositions = live;
    endpointResults.positionHistory = positionHistory;
    endpointResults.orderHistory = orderHistory;
    endpointResults.transferHistory = transferHistory;

    const positionData = positionHistory.ok ? positionHistory.data : {};
    const orderData = orderHistory.ok ? orderHistory.data : {};
    const transferData = transferHistory.ok ? transferHistory.data : {};

    return {
      id: portfolioId,
      url: location.href,
      pageTitle,
      visibleText,
      detail: detailData,
      performanceWindows: performance.windows,
      listItem: performance.windows["30D"] || performance.windows["365D"] || {},
      livePositions: live.ok ? binanceDataList(live.data) : [],
      positionHistory: positionHistory.ok ? asArray(positionData.rows) : [],
      orderHistory: orderHistory.ok ? asArray(orderData.rows) : [],
      transferHistory: transferHistory.ok ? asArray(transferData.rows) : [],
      historyStatus: {
        positionHistory: positionHistory.ok ? {
          total: positionData.total,
          fetched: positionData.fetched,
          pages: positionData.pages,
          complete: positionData.complete,
          duplicateRows: positionData.duplicateRows,
          retryCount: positionData.retryCount,
          lastRetryError: positionData.lastRetryError
        } : { total: 0, fetched: 0, pages: 0, complete: false, error: positionHistory.error },
        orderHistory: orderHistory.ok ? {
          total: orderData.total,
          fetched: orderData.fetched,
          pages: orderData.pages,
          complete: orderData.complete,
          duplicateRows: orderData.duplicateRows,
          retryCount: orderData.retryCount,
          lastRetryError: orderData.lastRetryError
        } : { total: 0, fetched: 0, pages: 0, complete: false, error: orderHistory.error },
        transferHistory: transferHistory.ok ? {
          total: transferData.total,
          fetched: transferData.fetched,
          pages: transferData.pages,
          complete: transferData.complete,
          duplicateRows: transferData.duplicateRows,
          retryCount: transferData.retryCount,
          lastRetryError: transferData.lastRetryError
        } : { total: 0, fetched: 0, pages: 0, complete: false, error: transferHistory.error }
      },
      endpointResults
    };
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

  async function fetchBinanceMarkPrices(symbols) {
    const wanted = Array.from(new Set(asArray(symbols).map((value) => String(value)).filter(Boolean)));
    if (!wanted.length) return { marks: {}, missing: [], fetchedAtMs: Date.now(), source: "none" };

    const marks = {};
    let source = "";
    if (wanted.length > PREMIUM_INDEX_ALL_WEIGHT) {
      const all = await safeFetch("mark:all", () =>
        untilAnswered(() => fetchJson(`${BINANCE_BASE}/fapi/v1/premiumIndex`, { method: "GET" })).then((answer) => answer.value)
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
          untilAnswered(() => fetchJson(`${BINANCE_BASE}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`, { method: "GET" })).then((answer) => answer.value)
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

  async function okxGet(pathWithQuery) {
    const { value } = await untilAnswered(async () =>
      requireOkxOk(pathWithQuery, await fetchJson(`${OKX_BASE}${pathWithQuery}`, { method: "GET" })));
    return value;
  }

  async function findOkxCandidate(uniqueName) {
    const rankTypes = ["yieldRatio", "pnl", "followPnl", "aum", "winRatio"];
    for (const rankType of rankTypes) {
      for (let start = 1; start <= 181; start += 20) {
        const response = await okxGet(`/priapi/v5/ecotrade/public/follow-rank?size=20&type=${rankType}&start=${start}`);
        const ranks = asArray(response?.data?.[0]?.ranks);
        const found = ranks.find((row) => String(row.uniqueName) === String(uniqueName));
        if (found) return found;
        if (ranks.length < 20) break;
        await sleep(100);
      }
    }
    return null;
  }

  async function fetchOkxLead(context) {
    const uniqueName = context.id;
    const visibleText = document.body?.innerText || "";
    const pageTitle = document.title;

    const [candidate, positionHistory, livePositions] = await Promise.all([
      safeFetch("candidate", () => findOkxCandidate(uniqueName)),
      safeFetch("positionHistory", () =>
        okxGet(`/priapi/v5/ecotrade/public/position-history?uniqueName=${encodeURIComponent(uniqueName)}&limit=100`)
      ),
      safeFetch("livePositions", () =>
        okxGet(`/priapi/v5/ecotrade/public/trader/position-detail?uniqueName=${encodeURIComponent(uniqueName)}`)
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

  function detectLeadPage(url = location.href) {
    const parsed = new URL(url);
    if (parsed.hostname === "www.binance.com") {
      const match = parsed.pathname.match(/\/copy-trading\/lead-details\/(\d+)/);
      if (match) return { platform: "Binance", id: match[1] };
    }
    if (parsed.hostname === "www.okx.com") {
      const match = parsed.pathname.match(/\/copy-trading\/account\/([A-Za-z0-9_-]+)/);
      if (match) return { platform: "OKX", id: match[1] };
    }
    return null;
  }

  async function fetchLeadData(context, options = {}) {
    if (context.platform === "Binance") return fetchBinanceLead(context, options);
    if (context.platform === "OKX") return fetchOkxLead(context);
    throw new Error(`Unsupported platform: ${context.platform}`);
  }

  global.CopyTradingLensProviders = {
    detectLeadPage,
    fetchLeadData,
    fetchBinanceListPage,
    fetchBinanceMarkPrices
  };
})(window);
