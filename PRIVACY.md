# Privacy Policy

Copy Trading Lens does not collect personal data.

## How Data Is Processed

The extension runs only when the user opens a supported Binance or OKX copy-trading lead-trader page. It reads lead-trader data from same-origin page APIs available to the current browser session and computes the analysis locally in the browser.

Same-origin exchange requests may use the browser's normal session context and exchange-required CSRF header. These values are used only for same-origin requests to the exchange page the user is already visiting; they are not stored, logged, or sent to third parties.

## Data Not Collected

Copy Trading Lens does not collect, store, or transmit:

- cookies or request headers as stored records
- API keys
- account IDs
- exchange login credentials
- user asset data
- user order history
- raw API responses
- analysis results
- browsing history

## Third-Party Transfer

There is no backend service, no analytics service, and no third-party data transfer.

The extension does not send data to the developer, a cloud server, or a third-party analytics provider.

## Local Storage

The current version does not use Chrome storage and does not create a local database. Analysis results live only in page memory and are recomputed after page refresh.

## Permission Purpose

The extension requests host permissions for `www.binance.com` and `www.okx.com` only to:

- inject the analysis panel on individual lead-trader pages
- read same-origin public/session-visible lead-trader data
- compute local copy-trading risk analysis

## Contact

Open a GitHub issue in this repository for privacy or security concerns.

---

# 隱私權政策

Copy Trading Lens 不收集個人資料。

## 資料處理方式

Extension 只在使用者打開 Binance 或 OKX 個別跟單員頁面時運作。它會在使用者瀏覽器內，向當前網站的同源 API 讀取該帶單員頁面相關資料，並在本機完成分析。

同源請求可能使用瀏覽器正常 session 與交易所要求的 CSRF header。這些值只會用於使用者正在瀏覽的交易所同源請求，不會被儲存、記錄或傳給第三方。

## 不收集的資料

Copy Trading Lens 不會收集、儲存或傳送：

- cookie 或 request header 的儲存紀錄
- API key
- 帳戶 id
- 交易所登入憑證
- 使用者資產資料
- 使用者下單紀錄
- 原始 API response
- 分析結果
- 瀏覽紀錄

## 第三方傳輸

沒有後端服務，沒有 analytics，沒有第三方資料傳輸。

Extension 不會把任何資料送到開發者、雲端伺服器或第三方分析服務。

## 本機暫存

目前版本不使用 Chrome storage，也不建立本機資料庫。分析結果只存在於頁面生命週期中的記憶體，重新整理頁面後會重新抓取與重新分析。

## 權限用途

Extension 要求 `www.binance.com` 與 `www.okx.com` host permissions，只用於：

- 在個別跟單員頁面注入分析面板
- 讀取同站 API 回傳的帶單員公開/登入可見資料
- 在本機計算跟單風險分析

## 聯絡

請在 GitHub repository 開 issue 回報隱私或安全問題。
