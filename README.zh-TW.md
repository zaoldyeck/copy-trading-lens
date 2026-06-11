# Copy Trading Lens

[English README](README.md)

Copy Trading Lens 是一個 Chrome Extension，用來在 Binance / OKX 個別跟單員頁面上，即時分析該帶單員的跟單風險。

它不是交易機器人，不會幫你下單，也不保證收益。它的目標是把跟單前最容易忽略的風險攤開來：類馬丁格爾、逆勢加倉、補保證金、死扛浮虧、高頻微利滑價、盈虧比失衡、跟單者實際體驗背離。

## 核心特性

- 支援 Binance 跟單員頁面：`/copy-trading/lead-details/<portfolioId>`
- 支援 OKX 跟單員頁面：`/copy-trading/account/<uniqueName>`
- 進入個別帶單員頁面後自動分析
- 不使用靜態帶單員名單
- 每次都從目前頁面重新抓取同站、目前 session 可見的最新資料
- Binance 主績效優先由當下抓到的歷史交易、轉帳紀錄與目前帶單資金重建
- 顯示全期間年化收益；有現金流資料時用 XIRR/APY，否則用全期間 ROI 推估 CAGR
- Binance 歷史分頁遇到系統忙碌、網路抖動、429/5xx 等暫時錯誤時會持續重試，直到抓完可用歷史資料
- 只在你的瀏覽器本機運算
- 沒有後端服務、analytics、remote code、cookie/header/API key 儲存，也不會上傳帳戶資料
- 顯示可解釋證據，而不是只給黑盒分數
- 使用 Chrome extension i18n，預設英文，支援台灣正體中文 (`zh_TW`)

## 分析內容

Extension 會根據當前頁面即時能取得的資料，檢查：

- 全期間 ROI / 年化收益 / 全期間 PnL / MDD / 交易天數 / 跟單者 PnL/AUM
- Binance 7D / 30D / 90D / 180D / 365D 交易所時間窗交叉檢查
- 勝率、平均獲利、平均虧損、盈虧比、每筆期望值
- 獲利單與虧損單持倉時間
- 歷史訂單中的逆勢加倉、分層、最大層數與高頻拆單特徵
- 轉帳紀錄中是否有虧損持倉期間資金轉入
- 目前持倉是否有明顯浮虧或高曝險
- 高頻微利策略是否可能被跟單延遲、滑價、手續費吃掉

## Chrome Web Store 上架前安裝

在 extension 還沒上架 Chrome Web Store 之前，請先從 GitHub Releases 安裝：

1. 打開 GitHub 最新 release。
2. 下載 `copy-trading-lens-<version>.zip`。
3. 解壓縮到本機資料夾。
4. 打開 `chrome://extensions`。
5. 開啟 **Developer mode**。
6. 點 **Load unpacked**。
7. 選擇解壓縮後的資料夾。
8. 打開 Binance 或 OKX 的個別跟單員頁面。

## 從原始碼安裝

```bash
npm run package
```

然後在 Chrome：

1. 打開 `chrome://extensions`
2. 開啟 **Developer mode**
3. 點 **Load unpacked**
4. 選擇這個 repository 資料夾，或選擇 `dist/copy-trading-lens/`
5. 打開 Binance 或 OKX 的個別跟單員頁面

## 權限說明

Manifest 只要求：

- `https://www.binance.com/*`
- `https://www.okx.com/*`

原因是 extension 需要在 Binance / OKX 跟單員頁面呼叫同站 API，取得該頁本來就能看到或登入後可見的帶單員資料。Extension 不會把資料傳到任何第三方伺服器。

Content script 只會在以下頁面注入：

- `https://www.binance.com/*/copy-trading/lead-details/*`
- `https://www.okx.com/*/copy-trading/account/*`

## 隱私

請見 [PRIVACY.md](PRIVACY.md)。

簡短版本：

- 沒有後端
- 沒有 analytics
- 沒有 remote code
- 沒有資料上傳
- 沒有 credential 儲存
- 同源請求可能使用瀏覽器正常 session 與交易所要求的 CSRF header，但不會儲存或傳給第三方
- 沒有靜態帶單員資料庫

## 原始碼驗證

```bash
npm run icons
npm run validate
npm run package
```

## 限制

- 交易所 API 或頁面結構可能改版，導致部分資料暫時抓不到。
- Binance 全期間 ROI 是用「目前帶單資金 + 已提領 - 已投入」重建；若 Binance 沒提供完整歷史轉帳或歷史倉位，面板會標示資料不完整或 `N/A`。
- 年化收益在有現金流時使用 XIRR/APY；若現金流不足，才用 ROI 與交易天數推估 CAGR。短樣本的年化值可能非常極端，應搭配 MDD 與交易行為判讀。
- Binance 標準視窗 ROI/MDD 來自當下 live `query-list` API，只作交叉檢查，不作為靜態資料庫。
- 未登入時，某些 Binance 資料可能不可見。
- OKX 公開資料不像 Binance 訂單/轉帳資料那麼完整，因此部分判斷會比較保守。
- Hidden positions 本身不會被當作負面訊號；只會標示資料不足。
- 分析結果是風險提示，不是投資建議。

## License

Creative Commons Attribution-NonCommercial 4.0 International (`CC-BY-NC-4.0`)。

可以署名分享、修改，但未經另外書面授權不得商業使用。
