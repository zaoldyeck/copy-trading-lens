# TASKS

## Chrome Extension 發布版

- [x] 建立獨立公開專案資料夾，避免把交易 bot repo 或私密 header/cookie 一起公開。
- [x] 採用 Chrome Manifest V3，符合 Chrome Web Store 目前接受的 extension 格式。
- [x] 不內建既有帶單員靜態排名或歷史快照，改為使用者進入個別帶單員頁面後即時抓取當頁資料分析。
- [x] Binance provider：抓取 detail、目前持倉、歷史倉位、歷史訂單、轉帳紀錄。
- [x] OKX provider：抓取公開排行候選資料、歷史倉位、目前持倉。
- [x] 分析引擎：評估 ROI/MDD、盈虧比、持倉時間、逆勢加倉、補保證金、目前浮虧死扛、滑價/高頻可複製性。
- [x] 頁面 UI：在 Binance/OKX 個別跟單員頁面顯示摘要、風險、證據與設定建議。
- [x] Popup：說明 extension 目的、資料處理方式與手動刷新方式。
- [x] README：公開 GitHub 使用說明、開發、打包、上架前檢查。
- [x] Privacy Policy：明確說明不收集、不傳送、不儲存 cookie/header/API key。
- [x] Chrome Web Store Description：可直接貼到商店頁面的說明文案。
- [x] 打包腳本：產生可上傳 Chrome Web Store 的 zip。
- [x] 基本驗證：manifest JSON、JS 語法、必要檔案、zip 結構。

## 後續可做但不阻塞 v0.1.0

- [ ] 加入使用者自訂風險門檻。
- [ ] 加入匯出單一帶單員分析 JSON 的按鈕。
- [ ] 針對 OKX 補更多公開 API 欄位，例如 copier 分布、週收益柱狀圖與分潤資訊。
- [ ] 建立自動化 Playwright smoke test，載入 unpacked extension 並在 fixture page 測試 UI。
