# Chrome Web Store Listing Draft

## Extension Name

Copy Trading Lens

## Short Description

即時分析 Binance / OKX 跟單員頁面的策略風險、死扛、補保證金與可複製性。

## Detailed Description

Copy Trading Lens 是給 Binance / OKX 跟單用戶的風控分析工具。

當你打開個別跟單員頁面時，Extension 會在頁面右側顯示即時分析面板，幫你檢查這位帶單員是否可能存在：

- 類馬丁格爾或逆勢加倉
- 虧損持倉拖太久
- 虧損期補保證金
- 目前浮虧死扛
- 盈虧比失衡
- 高勝率但尾部風險不明
- 高頻微利導致跟單者被滑價與手續費吃掉
- 跟單者 PnL 與帶單員帳面 ROI 背離

它不使用固定排名，也不內建舊的帶單員資料庫。每次分析都會根據你目前打開的 Binance / OKX 頁面，讀取當下可取得的資料，並在你的瀏覽器本機完成計算。

適合用來回答：

- 這個帶單員是不是靠扛單撐住帳面績效？
- ROI 很高是否值得承受 MDD？
- 跟單者可能會不會因滑價、延遲或補保證金不同步而賠錢？
- 現在是否不該複製現有倉位？
- 這個策略比較像短線、網格、類馬丁還是波段？

重要聲明：

- 本工具不是交易機器人，不會下單。
- 本工具不是投資建議，不保證收益或安全。
- 分析只根據當前頁面可取得資料，若交易所限制資料或 API 改版，面板會標示資料不足。

## Permission Justification

### Host permissions: `https://www.binance.com/*`, `https://www.okx.com/*`

用途：在 Binance / OKX 個別跟單員頁面讀取同站 API 的帶單員資料，例如績效、目前持倉、歷史倉位、訂單或轉帳紀錄。資料只在使用者瀏覽器本機分析，不會傳送到任何外部伺服器。

### Content scripts

用途：只在 Binance / OKX 跟單員 detail page 顯示分析面板，不會在其他網站運作。

## Privacy Disclosure

Copy Trading Lens 不收集、不出售、不傳送使用者資料。沒有後端服務，沒有 analytics，沒有 remote code，沒有 cookie/header/API key 儲存。

## Category

Productivity

## Language

Traditional Chinese
