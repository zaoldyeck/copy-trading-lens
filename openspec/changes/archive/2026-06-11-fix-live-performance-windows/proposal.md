## Why

目前 Binance 面板的 ROI/MDD 會先依賴 30D 排行 API；如果該帶單員不在前幾頁，或頁面文字沒有被解析到，未知值會被顯示成 0。這會把「沒有抓到」誤導成「真的 0%」，也不符合使用者要求的進入頁面後即時抓取最新資料、並以第一筆交易到現在作為主績效。

## What Changes

- Binance 主績效改為優先用當前頁面 API 抓到的歷史倉位、轉帳紀錄、目前資金重建全期間 ROI/PnL。
- Binance 同步抓取 `7D`、`30D`、`90D`、`180D`、`365D` 的 live `query-list` 視窗資料，作為交叉檢查與 MDD 補充，不再只掃 30D 前幾頁。
- 未抓到或不能可靠重建的 ROI/MDD SHALL 顯示為 `N/A`，不能 fallback 成 0。
- UI SHALL 明確標示主績效來源，例如「歷史現金流重建」或「交易所視窗 fallback」，並列出時間窗交叉檢查。
- 歷史交易樣本 SHALL 標示抓取筆數、交易所回報總筆數與是否完整抓完。

## Capabilities

### New Capabilities
- `binance-reconstructed-performance`: 以 Binance live API 的歷史交易/轉帳/資金資料重建全期間績效。

### Modified Capabilities
- `exchange-data-fetching`: Binance 資料抓取需取得標準績效視窗，並回報歷史資料完整度。
- `analysis-overlay-ui`: UI 需顯示全期間主績效、資料來源、標準視窗交叉檢查與不可用資料狀態。

## Impact

- Affected code: `src/providers.js`, `src/analysis.js`, `src/content.js`, `src/content.css`
- Affected docs: `README.md`, `STORE_LISTING.md`
- No new external dependency.
- No backend, no static trader database, no credential storage.
