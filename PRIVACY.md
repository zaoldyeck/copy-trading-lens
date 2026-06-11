# Privacy Policy

Copy Trading Lens 不收集個人資料。

## 資料處理方式

Extension 只在使用者打開 Binance 或 OKX 個別跟單員頁面時運作。它會在使用者瀏覽器內，向當前網站的同源 API 讀取該帶單員頁面相關資料，並在本機完成分析。

## 不收集的資料

Copy Trading Lens 不會收集、儲存或傳送：

- cookie
- request header
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
