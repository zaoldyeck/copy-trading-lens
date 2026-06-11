(function attachProviders(global) {
  "use strict";

  const BINANCE_BASE = "https://www.binance.com";
  const OKX_BASE = "https://www.okx.com";
  const PAGE_SIZE = 100;

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

  async function fetchBinancePaged(path, portfolioId, maxPages = 6) {
    const rows = [];
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const response = await postBinance(path, {
        portfolioId,
        pageNumber,
        pageSize: PAGE_SIZE
      });
      if (response?.code && response.code !== "000000") {
        throw new Error(`Binance ${path} returned code ${response.code}`);
      }
      const pageRows = binanceDataList(response);
      rows.push(...pageRows);
      if (pageRows.length < PAGE_SIZE) break;
      await sleep(120);
    }
    return rows;
  }

  async function fetchBinanceListItem(portfolioId, timeRange = "30D") {
    const maxPages = 6;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const response = await postBinance("/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list", {
        pageNumber,
        pageSize: 30,
        timeRange,
        dataType: "ROI",
        favoriteOnly: false,
        hideFull: false,
        nickname: "",
        order: "DESC",
        userAsset: 0
      });
      if (response?.code && response.code !== "000000") {
        throw new Error(`Binance list returned code ${response.code}`);
      }
      const rows = asArray(response?.data?.list);
      const found = rows.find((row) => String(row.leadPortfolioId) === String(portfolioId));
      if (found) return found;
      if (rows.length < 30) break;
      await sleep(120);
    }
    return null;
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

    const [listItem, live, positionHistory, orderHistory, transferHistory] = await Promise.all([
      safeFetch("listItem", () => fetchBinanceListItem(portfolioId)),
      safeFetch("livePositions", () =>
        getBinance(`/bapi/futures/v1/friendly/future/copy-trade/lead-data/positions?portfolioId=${encodeURIComponent(portfolioId)}`)
      ),
      safeFetch("positionHistory", () =>
        fetchBinancePaged("/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/position-history", portfolioId, 15)
      ),
      safeFetch("orderHistory", () =>
        fetchBinancePaged("/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/order-history", portfolioId, 15)
      ),
      safeFetch("transferHistory", () =>
        fetchBinancePaged("/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/transfer-history", portfolioId, 6)
      )
    ]);
    endpointResults.listItem = listItem;
    endpointResults.livePositions = live;
    endpointResults.positionHistory = positionHistory;
    endpointResults.orderHistory = orderHistory;
    endpointResults.transferHistory = transferHistory;

    return {
      id: portfolioId,
      url: location.href,
      pageTitle,
      visibleText,
      detail: detailResult.ok ? (detailResult.data?.data || {}) : {},
      listItem: listItem.ok ? (listItem.data || {}) : {},
      livePositions: live.ok ? binanceDataList(live.data) : [],
      positionHistory: positionHistory.ok ? positionHistory.data : [],
      orderHistory: orderHistory.ok ? orderHistory.data : [],
      transferHistory: transferHistory.ok ? transferHistory.data : [],
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
    fetchLeadData
  };
})(window);
