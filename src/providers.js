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

    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      ...options,
      headers
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (error) {
      throw new Error(`Non-JSON response from ${url}: HTTP ${response.status}`);
    }
    if (!response.ok) {
      const code = json?.code || json?.msg || response.status;
      throw new Error(`HTTP ${response.status} from ${url}: ${code}`);
    }
    return json;
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
    return fetchJson(`${BINANCE_BASE}${path}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  async function getBinance(path) {
    return fetchJson(`${BINANCE_BASE}${path}`, { method: "GET" });
  }

  function binanceDataList(response) {
    if (Array.isArray(response?.data)) return response.data;
    return asArray(response?.data?.list);
  }

  function binanceCodeError(path, response) {
    const code = response?.code || "UNKNOWN";
    const message = response?.message || response?.msg || "Unknown Binance response";
    return `Binance ${path} returned code ${code}: ${message}`;
  }

  function isRetriableBinanceError(message) {
    const text = String(message || "").toLowerCase();
    return text.includes("11012005")
      || text.includes("系統目前忙碌")
      || text.includes("system is busy")
      || text.includes("failed to fetch")
      || text.includes("network")
      || text.includes("timeout")
      || text.includes("http 408")
      || text.includes("http 418")
      || text.includes("http 429")
      || text.includes("http 5");
  }

  function retryDelayMs(attempt) {
    const base = Math.min(15000, 500 * (2 ** Math.min(attempt - 1, 5)));
    return base + Math.floor(Math.random() * 250);
  }

  async function fetchBinancePagedPage(path, portfolioId, pageNumber, pageSize) {
    let lastError = "";
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await postBinance(path, {
          portfolioId,
          pageNumber,
          pageSize
        });
        if (!response?.code || response.code === "000000") {
          return {
            response,
            retries: attempt - 1,
            lastRetryError: lastError
          };
        }
        lastError = binanceCodeError(path, response);
      } catch (fetchError) {
        lastError = fetchError instanceof Error ? fetchError.message : String(fetchError);
      }
      if (!isRetriableBinanceError(lastError)) {
        throw new Error(lastError);
      }
      await sleep(retryDelayMs(attempt));
    }
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

  async function fetchBinancePagedDetailed(path, portfolioId) {
    const rows = [];
    let total = null;
    let pages = 0;
    let retryCount = 0;
    let lastRetryError = "";
    let prematureRetries = 0;
    let depthLimited = false;
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
      rows.push(...pageRows);
      if (Number.isFinite(total) && rows.length >= total) break;
      if (!Number.isFinite(total) && pageRows.length < PAGE_SIZE) break;
      await sleep(120);
    }
    return {
      rows,
      total: Number.isFinite(total) ? total : rows.length,
      fetched: rows.length,
      pages,
      complete: !depthLimited,
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
    if (response?.code && response.code !== "000000") {
      throw new Error(`Binance list returned code ${response.code}`);
    }
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

  async function fetchBinanceLead(context) {
    const portfolioId = context.id;
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
        fetchBinancePagedDetailed("/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/position-history", portfolioId)
      ),
      safeFetch("orderHistory", () =>
        fetchBinancePagedDetailed("/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history", portfolioId)
      ),
      safeFetch("transferHistory", () =>
        fetchBinancePagedDetailed("/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/transfer-history", portfolioId)
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
          retryCount: positionData.retryCount,
          lastRetryError: positionData.lastRetryError
        } : { total: 0, fetched: 0, pages: 0, complete: false, error: positionHistory.error },
        orderHistory: orderHistory.ok ? {
          total: orderData.total,
          fetched: orderData.fetched,
          pages: orderData.pages,
          complete: orderData.complete,
          retryCount: orderData.retryCount,
          lastRetryError: orderData.lastRetryError
        } : { total: 0, fetched: 0, pages: 0, complete: false, error: orderHistory.error },
        transferHistory: transferHistory.ok ? {
          total: transferData.total,
          fetched: transferData.fetched,
          pages: transferData.pages,
          complete: transferData.complete,
          retryCount: transferData.retryCount,
          lastRetryError: transferData.lastRetryError
        } : { total: 0, fetched: 0, pages: 0, complete: false, error: transferHistory.error }
      },
      endpointResults
    };
  }

  async function okxGet(pathWithQuery) {
    return fetchJson(`${OKX_BASE}${pathWithQuery}`, { method: "GET" });
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

  async function fetchLeadData(context) {
    if (context.platform === "Binance") return fetchBinanceLead(context);
    if (context.platform === "OKX") return fetchOkxLead(context);
    throw new Error(`Unsupported platform: ${context.platform}`);
  }

  global.CopyTradingLensProviders = {
    detectLeadPage,
    fetchLeadData,
    fetchBinanceListPage
  };
})(window);
