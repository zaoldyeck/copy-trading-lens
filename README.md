# Copy Trading Lens

Copy Trading Lens 是一個 Chrome Extension，用來在 Binance / OKX 個別跟單員頁面上，即時分析該帶單員的跟單風險。

它不是交易機器人，不會幫你下單，也不保證收益。它的目標是把跟單前最容易忽略的風險攤開來：類馬丁格爾、逆勢加倉、補保證金、死扛浮虧、高頻微利滑價、盈虧比失衡、跟單者實際體驗背離。

## 核心特性

- 支援 Binance 跟單員頁面：`/copy-trading/lead-details/<portfolioId>`
- 支援 OKX 跟單員頁面：`/copy-trading/account/<uniqueName>`
- 進入個別帶單員頁面後自動分析，不使用靜態帶單員名單
- Binance 主績效優先由當下抓到的歷史交易、轉帳紀錄與目前帶單資金重建，不依賴頁面目前選到 7D/30D/90D/180D
- Binance 歷史分頁遇到 `系統忙碌`、網路抖動、429/5xx 等暫時錯誤時會持續重試，直到抓完可用歷史資料
- 只在你的瀏覽器本機運算，沒有後端服務
- 不收集、不上傳、不儲存 cookie、header、API key、帳戶資料
- 顯示可解釋證據，而不是只給黑盒分數

## 分析內容

Extension 會根據當前頁面即時能取得的資料，檢查：

- 全期間 ROI / 全期間 PnL / MDD / 交易天數 / 跟單者 PnL/AUM
- Binance 7D / 30D / 90D / 180D / 365D 交易所時間窗交叉檢查
- 勝率、平均獲利、平均虧損、盈虧比、每筆期望值
- 獲利單與虧損單持倉時間
- 歷史訂單中的逆勢加倉、分層、最大層數與高頻拆單特徵
- 轉帳紀錄中是否有虧損持倉期間資金轉入
- 目前持倉是否有明顯浮虧或高曝險
- 高頻微利策略是否可能被跟單延遲、滑價、手續費吃掉

## 安裝測試

```bash
npm run package
```

然後在 Chrome：

1. 打開 `chrome://extensions`
2. 開啟 Developer mode
3. 點 Load unpacked
4. 選擇這個資料夾，或選擇 `dist/copy-trading-lens/`
5. 打開 Binance 或 OKX 的個別跟單員頁面

## 打包 Chrome Web Store zip

```bash
npm run package
```

輸出檔案：

```text
dist/copy-trading-lens-0.1.0.zip
```

這個 zip 只包含 extension runtime 必要檔案：`manifest.json`、`popup.html`、`assets/`、`src/`。

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
- 沒有靜態帶單員資料庫

## 開發

```bash
npm run icons
npm run validate
npm run package
```

OpenSpec change：

```text
openspec/changes/build-copy-trading-lens-extension/
```

## 限制

- 交易所 API 或頁面結構可能改版，導致部分資料暫時抓不到。
- Binance 全期間 ROI 是用「目前帶單資金 + 已提領 - 已投入」重建；若 Binance 沒提供完整歷史轉帳或歷史倉位，面板會標示資料不完整或 `N/A`。
- Binance 標準視窗 ROI/MDD 來自當下 live `query-list` API，只作交叉檢查，不作為靜態資料庫。
- 未登入時，某些 Binance 資料可能不可見。
- OKX 公開資料不像 Binance 訂單/轉帳資料那麼完整，因此部分判斷會比較保守。
- Hidden positions 本身不會被當作負面訊號；只會標示資料不足。
- 分析結果是風險提示，不是投資建議。

## License

MIT
