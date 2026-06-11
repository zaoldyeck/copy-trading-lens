## Context

這個專案是獨立於交易 bot repo 的 Chrome Extension，目標是公開到 GitHub 並可提交 Chrome Web Store。使用者會在已登入或未登入的 Binance/OKX 網頁上瀏覽個別帶單員頁面，extension 需要在該頁面即時分析，而不是打包舊報告或固定名單。

主要限制是 Chrome Manifest V3、Chrome Web Store 權限最小化、不能上傳使用者資料、不能儲存 cookie/header/API key、不能使用遠端程式碼。交易所頁面與 API 也可能改版，所以資料抓取必須防禦式處理缺欄位與部分失敗。

## Goals / Non-Goals

**Goals:**

- 在 Binance/OKX 個別跟單員頁面自動顯示本機即時計算的跟單風險分析。
- 使用當前頁面同源可取得資料，包含 detail、目前持倉、歷史倉位、訂單、轉帳與頁面可見文字。
- 把風險拆成可解釋證據：類馬丁/逆勢加倉、虧損期補資金、目前浮虧死扛、盈虧比、持倉時間、滑價可複製性。
- 讓 extension package 可直接人工載入測試並打包成 Chrome Web Store zip。
- README、隱私聲明與商店文案不得包含任何私密 header、cookie、API key 或既有使用者資料。

**Non-Goals:**

- 不提供交易下單、跟單、自動交易或資金管理功能。
- 不提供投資保證、收益保證或法律/財務建議。
- 不建立後端服務，也不把使用者頁面、帳戶或交易資料傳到外部。
- 不內建既有報告中的靜態帶單員推薦資料庫。
- 不繞過交易所權限；使用者看不到的私有資料不強行取得。

## Decisions

1. **Manifest V3 content script over backend service**

   Extension 以 Manifest V3 content script 注入 Binance/OKX lead page。資料抓取發生在使用者瀏覽器內，使用當前站台 session 送出同源 request。

   Rationale: 不需要收集或儲存使用者憑證，也更符合 Chrome Web Store 對資料最小化與單一用途的要求。

   Alternative considered: 建立雲端 API 代理。放棄原因是會引入資料收集、帳號 session、成本與安全責任，不符合這個 extension 的最小化目標。

2. **Provider adapter boundary**

   Binance 與 OKX 各自實作 provider adapter，輸出統一 raw shape 給分析引擎。adapter 負責 endpoint、欄位差異、分頁、錯誤與部分資料失敗。

   Rationale: 交易所 API 欄位與可見資料不同，分析規則應該依賴規格化資料而不是散落在 UI 裡。

3. **Explainable rule engine over opaque score**

   分析引擎輸出 `verdict`、`positives`、`cautions`、`evidence` 與統計值，不只給單一分數。

   Rationale: 跟單風險需要知道原因，例如「虧損期轉入」比「風險分數 82」更能指引用戶決策。

4. **Overlay UI with explicit data status**

   UI 以可收合 overlay 顯示，不取代交易所頁面。若某些 API 失敗或資料不足，必須清楚列出缺失，不能把空資料當安全。

   Rationale: 交易所頁面是主體；extension 只能補上分析層，並且需要讓使用者知道分析根據哪些資料。

5. **Publishable repo hygiene**

   Repo 只包含 extension source、OpenSpec artifacts、README、privacy、store description、packaging scripts。`.gitignore` 排除 dist、local、log、node_modules。

   Rationale: 使用者要求公開 GitHub；不能把既有研究 repo、header、cookie 或快取資料帶進公開專案。

## Risks / Trade-offs

- API endpoint 改版或 CORS/session 限制 -> provider 必須顯示資料取得失敗，並用頁面可見文字做最低限度 fallback。
- 使用者未登入時部分資料不可見 -> UI 必須標示「資料不足」，而不是輸出過度確定的推薦。
- Content script host permission 覆蓋 `www.binance.com` 與 `www.okx.com` -> README 與 store description 必須清楚說明用途，manifest match 只在跟單頁注入。
- 跟單風險規則仍是啟發式 -> UI 必須呈現證據與限制，避免宣稱能保證收益或保證排除所有風險。
- 交易所頁面 DOM 經常變動 -> 核心資料以 API 為主，DOM 文字只作 fallback。
