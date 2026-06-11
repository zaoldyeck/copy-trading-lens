## Why

Binance 與 OKX 跟單頁面目前只呈現交易員的表層績效，使用者很難在跟單前看出補保證金、死扛、類馬丁、滑價不可複製、盈虧比失衡等真正會讓跟單者受傷的風險。這個 change 要把既有帶單員分析方法產品化成可公開上架的 Chrome Extension，讓使用者停留在個別帶單員頁面時即可用當下資料即時分析。

## What Changes

- 新增一個獨立、可公開發布的 Chrome Manifest V3 extension 專案。
- 在 Binance 與 OKX 個別跟單員頁面自動偵測平台與 lead trader id。
- 不內建舊報告或靜態帶單員資料庫；每次分析都從使用者當前頁面的同源 API 與可見頁面資料取得最新資料。
- 對 Binance 抓取 detail、目前持倉、歷史倉位、歷史訂單、轉帳紀錄。
- 對 OKX 抓取公開候選/排行資料、歷史倉位、目前持倉；在公開資料不足時清楚標示限制。
- 在使用者瀏覽器本機計算風險：ROI/MDD、盈虧比、期望值、虧損持倉時間、逆勢加倉、補保證金、目前浮虧死扛、歷史關閉、單一標的集中、高頻微利可複製性。
- 在頁面上顯示 overlay，包含結論、證據、主要風險、正向訊號、建議跟單設定與資料取得狀態。
- 補齊 README、隱私聲明、Chrome Web Store Description 與打包腳本，確保可以乾淨上傳 Chrome Web Store。

## Capabilities

### New Capabilities
- `lead-page-detection`: Detect supported Binance/OKX lead trader pages and extract the current trader identifier.
- `exchange-data-fetching`: Fetch current lead trader data from Binance/OKX page-context APIs without storing credentials or static trader snapshots.
- `local-risk-analysis`: Compute follower-oriented copy-trading risk diagnostics locally in the browser.
- `analysis-overlay-ui`: Render a concise, explainable analysis panel on the current lead trader page.
- `store-ready-packaging`: Package the extension with publishable docs, privacy text, permission justifications, and validation checks.

### Modified Capabilities

None.

## Impact

- Adds Chrome extension files under this independent public project.
- Uses Chrome Manifest V3 content scripts and host permissions for `www.binance.com` and `www.okx.com`.
- Uses exchange same-origin browser requests from the user's active session; no backend service, no API key, no stored cookie/header, and no remote code.
- Adds local packaging/validation scripts and documentation required for GitHub publication and Chrome Web Store submission.
