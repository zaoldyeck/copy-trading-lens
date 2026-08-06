# Binance 跟單排行分析報告（30 天 ROI 榜、交易滿 30 天篩選）

**產生時間**：2026-08-06　**候選人數**：140（排名 1～140，即「玄冥二老」之上的全部交易員，該員已跟單故不重複分析）
**篩選條件**：`timeRange=30D`、`dataType=ROI`、`order=DESC`、`daysTrading>=30`、`portfolioType=ALL`、`useAiRecommended=true`（對應 Binance 頁面上的「AI 推薦／smart filter」榜單）
**資料來源**：Binance 公開 copy-trade API，直接拉取每位交易員的**全部歷史**（平倉紀錄、訂單紀錄、轉帳紀錄、五個時間窗績效），不是只看 30 天快照。140 人全數抓取成功，0 筆失敗。
**分析工具**：本專案 `tools/cli.mjs report`，底層跑的是 `src/analysis.js`／`src/providers.js`——跟 Chrome 擴充功能顯示給你的邏輯完全同一份程式碼，沒有第二套判準。

---

## 方法論：這份報告在測什麼、為什麼

### 判定五級
分析器把每位交易員分到五個等級之一，由嚴到鬆：

| 等級 | 意思 | 觸發條件（擇一即中） |
|---|---|---|
| 🚫 **不建議跟 / 暫不跟 / 高風險不建議一般跟單** (avoid) | 有直接證據顯示帳戶會在虧損時做出跟單者無法同步複製的行為，或歷史回撤已經大到不合理 | 虧損持倉期間偵測到資金轉入；逆勢加碼、虧損持倉拖延、盈虧比失衡同時出現（風險組合訊號）；目前有顯著浮虧倉位；歷史回撤 ≥50% |
| ⚠️ **高風險候補** (risky) | 沒有前述直接證據，但風險訊號已經多到不能忽略 | 警示數 ≥3、或回撤 ≥30%、或逆勢加碼率 ≥35%、或盈虧比 <0.5 |
| 👀 **觀察** (watch) | 樣本太薄，判斷不出型態 | 其餘情況的預設值 |
| ✅ **可小額測試候選** (followable) | 天數與樣本數達標，沒有觸發任何警示 | 天數 ≥30 且平倉 ≥30 筆，且不落入以上任何一類 |
| 🏆 **較適合跟單候選** (preferred) | 同時滿足：天數 ≥60、平倉 ≥50 筆、回撤 <15%、盈虧比 ≥1.5、逆勢加碼率 <15%、目前無顯著浮虧 | 全部條件同時成立 |

**沒有「零風險」這一級**——preferred 也只代表「目前看不到結構性問題」，不是保證。

### 策略型態怎麼判斷（含兩次真實的分類修正）
分析器看**訂單紀錄**裡的加碼行為，不是看標籤或自稱：

- **馬丁格爾（Martingale）**：逆勢加碼率 >35% 且（加碼倉位持續放大、或虧損倉位持有時間過長、或盈虧比失衡），同時加碼層數 ≥3、**且加碼價距不算網格級的緊密**（>120 個基點）。白話：跌了不停損、反而在有意義的價格拉開後越跌越加碼，賭反彈，一旦方向錯到底就是等比放大的虧損。
- **網格 / 區間交易（Grid）**：加碼是分層的、加碼間距很窄（≤120 個基點）、交易頻率高、**而且真的有雙向round-trip**（平倉單數相對開倉單數不能太少）。白話：固定價距掛單吃震盪，買低賣高反覆循環，行情走出區間才會累積浮虧。
- **DCA / 左側交易**：逆勢加碼率 ≥20% 但沒達到馬丁或網格的門檻。白話：跌了會攤平，不管是人工判斷還是自動化執行，方向上就是持續往同一邊加碼。
- **剝頭皮 / 波段 / 右側趨勢**：健康的三種型態，差別在持倉時間長短與進場邏輯，不涉及逆勢加碼。

**逆勢加碼率**、**加碼層數**、**加碼價距**、**開平倉比例**、**盈虧比**這五個數字組合起來，就是本報告分辨「乾淨策略」跟「賭一把」的核心依據。

> **兩次真實的分類修正，起因是同一位交易員**：本報告第一版把 **[13] 熬鹰资本**判成「馬丁格爾」。使用者指出這人是純人工交易，查證後發現兩件事都跟原判斷不同：
> 1. **不是人工**——Binance 官方帳戶標籤裡有 `API_KEY_TRADE`（API／程式化交易的官方標記），訂單紀錄裡有兩筆不同金額的賣單時間戳精確到同一毫秒，人手做不到。**已在分析器裡確認**：馬丁格爾判定新增「加碼價距不能是網格級緊密」的排除條件（原本馬丁格爾在 if/else 鏈裡排在網格前面，兩者條件同時成立時馬丁格爾會搶先中，18/31 個馬丁格爾標籤因此誤判——熬鹰资本的加碼價距中位數只有 2.5 個基點，遠比網格門檻的 120 基點緊密）。
> 2. **也不是網格**——單純把它改標網格還是錯的。網格的核心是「買低賣高反覆循環」，本質上開倉跟平倉次數要接近；熬鹰资本的訂單裡開倉 1906 筆、平倉只有 265 筆（13.9%），主力標的（SKHYNIXUSDT，一個股票掛鉤永續合約）1722 筆訂單裡 1699 筆是買進做多，價格從 1405 跌到 1026 一路加碼、幾乎不平倉——這是**單邊往下攤平**，不是雙向網格。**已在分析器裡加第二個修正**：網格判定新增「開平倉比例不能太懸殊」的條件（開平倉比例低於 25% 就不算網格）。這個門檻是從實際資料量出來的——140 人裡原本標網格的 32 人，開平倉比例落在 35%～400%+ 一群，只有 4 個異常值卡在 0.2%／8%／14%／15%，25% 剛好落在這個斷層帶。
>
> **兩次修正合計後，全批 140 人重新跑過**：馬丁格爾 31 位 → 13 位，網格 20 位 → 28 位，DCA 左側 45 位 → 55 位；三者合計仍是 96 位（68.6%），**沒有任何交易員因此離開「逆勢加碼」風險家族，只是型態標籤更準了**。避免跟單的判定（verdict）本身兩次修正都不受影響——熬鹰资本目前仍是「不建議跟」，理由是回撤 68.3%、逆勢加碼率 39%、虧損倉位持有時間明顯長於獲利倉位，這些跟「是馬丁格爾還是網格還是 DCA」無關，是獨立成立的風險證據。它最終的正確描述是：**自動化執行的單邊攤平（DCA 左側），不是人工，不是馬丁，也不是網格**。

### 「年化報酬（CAGR/XIRR）」欄位怎麼看——天數短的帳戶請忽略這欄
表格裡的「年化」欄位，是把全期間報酬率按複利公式外推到一年（`(1+ROI)^(365/天數) - 1`，有現金流資料時用 XIRR）。**這個外推對天數短、報酬率高的帳戶會產生完全不合理的數字**（本報告裡有交易員只跑了 30 幾天、原始報酬率就有 5000%，外推一年變成幾千萬到幾百億 %，是複利數學的產物，不是真實可能發生的年化報酬）。**判讀原則：天數 <90 天的帳戶，這欄位直接忽略，看旁邊的「近 30 天 ROI」欄位就好；天數夠長（半年以上）時，年化欄位才有參考意義。** 兩欄並排放，正是為了讓你自己看出「這是不是靠短窗口灌出來的數字」。

### 「虧損期入金」是什麼、為什麼是最重的紅燈
交易員在**某個虧損中的倉位還沒平倉時**，把新資金轉入帶單帳戶——這是跟單者結構上無法同步複製的行為（你不會知道他何時、要補多少），也是「用錢撐住不被強平」的直接證據，不是巧合。本報告統計時已排除 `LEAD_FEE_DEPOSIT`（分潤手續費補繳，通常幾毛到幾塊錢，不是真實資金救援）以及只納入真正的資金流入（`LEAD_DEPOSIT`/`LEAD_INVEST`），避免手續費雜訊把次數灌水。

### 三個容易被忽略、但本報告有算的隱藏訊號
- **歷史關閉次數**（`closeLeadCount`）：這人之前關過幾次帶單帳戶重開。次數越高，代表遇到問題就換一個新的「乾淨」頁面重新計時的可能性越大。
- **隱藏歷史天數**（`preStartHistoryDays`）：平倉/轉帳紀錄裡，早於「官方顯示起始時間」的天數。>0 代表現在頁面上顯示的「N 天 / ROI X%」只是重開後的新窗口，可能藏著前一輪的爆倉史。
- **重建數據可靠性**（`reliable`）：全期間 ROI 是用現金流重建出來的，如果起始點對不上（前述隱藏歷史）或資料不完整，這個旗標會是 false，代表頁面上的漂亮數字要打折看。

---

## 執行摘要：先講最重要的結論

**140 位「30 天 ROI 排行榜上最靠前」的交易員裡，92 位（65.7%）被判不建議跟單，只有 1 位達到「較適合跟單候選」等級，11 位可小額測試，1 位觀察中，其餘 35 位是高風險候補。**

策略型態分布更直接說明問題（已套用上述兩次分類修正）：
- **DCA / 左側交易**：55 位（39.3%）
- **網格 / 區間交易**：28 位（20.0%）
- **馬丁格爾**：13 位（9.3%）
- 三者合計 **96 位（68.6%）** 都是「逆勢加碼、賭反彈」家族。
- 乾淨的剝頭皮／波段／右側趨勢型態合計只有 25 位（17.9%）。

**這不是巧合，是排行榜本身的機制在篩選你。** 30 天 ROI 排行榜獎勵的是「短期報酬率最高」，而逆勢加碼／馬丁／網格這類策略的報酬曲線特徵正是「長期穩定小賺、直到一次性大賠」——排到 30 天窗口的高點，統計上最容易挑到「還沒遇到那次大賠」的樣本。你在榜單最上面看到的爆炸性數字（VickyKaushal 5302%、鎏渊 7086%、小新交易員 2146%），本身就是這個機制運作的結果，不是這些人特別厲害。

---

## 完整排行表格（按判定嚴重度排序）

| 排名 | 交易員 | 天數 | 年化(CAGR/XIRR) | 近30天ROI | MDD | 勝率 | 盈虧比 | 虧損期入金 | 策略型態 | 判定 |
|---|---|---|---|---|---|---|---|---|---|---|
| 32 | [芝麻芝麻](https://www.binance.com/zh-TC/copy-trading/lead-details/4971482014090862081?timeRange=30D) | 136 | 33215143% | 144.1% | 14.1% | 46.7% | 7.82 | 無 | 右側交易 / 趨勢跟隨 | 🏆 較適合跟單候選 |
| 10 | [来一杯清茶](https://www.binance.com/zh-TC/copy-trading/lead-details/5114550459351371264?timeRange=30D) | 37 | 10502638547519328% | 384.6% | 25.3% | 82.9% | 4.09 | 無 | DCA / 左側交易 | ✅ 可小額測試候選 |
| 40 | [HK大叔D](https://www.binance.com/zh-TC/copy-trading/lead-details/5082904357337048064?timeRange=30D) | 59 | 2007742% | 126.8% | 19.8% | 56.4% | 1.61 | 無 | 剝頭皮 | ✅ 可小額測試候選 |
| 48 | [富一次就足够](https://www.binance.com/zh-TC/copy-trading/lead-details/5121749078299654657?timeRange=30D) | 32 | 19217837% | 96.7% | 13.7% | 43.9% | 2.10 | 無 | 剝頭皮 | ✅ 可小額測試候選 |
| 56 | [静宝Trader](https://www.binance.com/zh-TC/copy-trading/lead-details/5062779826159549440?timeRange=30D) | 73 | 3250% | 81.1% | 25.5% | 96.2% | 59.96 | 無 | 波段交易 | ✅ 可小額測試候選 |
| 75 | [Passion lucky little orange king](https://www.binance.com/zh-TC/copy-trading/lead-details/5097511984930658560?timeRange=30D) | 49 | 1752356% | 55.4% | 12.6% | 100.0% | N/A | 無 | 剝頭皮 | ✅ 可小額測試候選 |
| 85 | [布鲁斯村长](https://www.binance.com/zh-TC/copy-trading/lead-details/4904114645412812033?timeRange=30D) | 182 | 1165% | 49.2% | 25.5% | 80.0% | 2.34 | 無 | DCA / 左側交易 | ✅ 可小額測試候選 |
| 105 | [专空暴涨币](https://www.binance.com/zh-TC/copy-trading/lead-details/5107107059031359745?timeRange=30D) | 42 | 2199% | 38.5% | 12.3% | 56.8% | 1.44 | 無 | 波段交易 | ✅ 可小額測試候選 |
| 107 | [Callme卢本伟](https://www.binance.com/zh-TC/copy-trading/lead-details/4512404768792222208?timeRange=30D) | 452 | 183% | 38.0% | 18.7% | 73.8% | 1.17 | 無 | 未偵測到明顯高風險交易模式 | ✅ 可小額測試候選 |
| 111 | [Hassiiiiiii](https://www.binance.com/zh-TC/copy-trading/lead-details/5023790571803063297?timeRange=30D) | 99 | 40056% | 37.0% | 24.1% | 80.9% | 3.35 | 無 | 波段交易 | ✅ 可小額測試候選 |
| 121 | [笑里藏猫](https://www.binance.com/zh-TC/copy-trading/lead-details/4373485373878739969?timeRange=30D) | 548 | 163% | 33.1% | 23.3% | 75.8% | 2.51 | 無 | 右側交易 / 趨勢跟隨 | ✅ 可小額測試候選 |
| 126 | [人生到处知何似](https://www.binance.com/zh-TC/copy-trading/lead-details/4556315195316581632?timeRange=30D) | 422 | 33% | 30.0% | 26.4% | 93.2% | 11.25 | 無 | 未偵測到明顯高風險交易模式 | ✅ 可小額測試候選 |
| 122 | [Connnars](https://www.binance.com/zh-TC/copy-trading/lead-details/5050018266813140224?timeRange=30D) | 81 | 64% | 32.0% | 19.7% | 100.0% | N/A | 無 | 交易紀錄不足 | 👀 觀察 |
| 1 | [VickyKaushal](https://www.binance.com/zh-TC/copy-trading/lead-details/5118776604240532481?timeRange=30D) | 34 | 14208015% | 5306.6% | 0.1% | 83.6% | 0.14 | 無 | 網格 / 區間交易 | ⚠️ 高風險候補 |
| 4 | [凯迪财经](https://www.binance.com/zh-TC/copy-trading/lead-details/5119090739504514048?timeRange=30D) | 34 | 39063356% | 506.8% | 7.2% | 76.9% | 0.51 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 6 | [皮卡丘量化](https://www.binance.com/zh-TC/copy-trading/lead-details/5100314095265428480?timeRange=30D) | 47 | 29235597% | 452.6% | 49.7% | 29.7% | 4.55 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 11 | [还有那么多目标没实现](https://www.binance.com/zh-TC/copy-trading/lead-details/5072119827468653313?timeRange=30D) | 66 | 29409234% | 379.4% | 41.7% | 96.2% | 0.99 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 20 | [币指多ai量化工具3](https://www.binance.com/zh-TC/copy-trading/lead-details/5097406838970133249?timeRange=30D) | 49 | 2194749% | 210.8% | 8.3% | 76.2% | 0.60 | 無 | 網格 / 區間交易 | ⚠️ 高風險候補 |
| 23 | [市梦率 200](https://www.binance.com/zh-TC/copy-trading/lead-details/5123333115570932993?timeRange=30D) | 31 | 30167141% | 201.6% | 8.8% | 100.0% | N/A | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 24 | [积累原始资本](https://www.binance.com/zh-TC/copy-trading/lead-details/5109439272237132800?timeRange=30D) | 40 | 15532712% | 193.9% | 35.6% | 61.3% | 1.06 | 無 | 未偵測到明顯高風險交易模式 | ⚠️ 高風險候補 |
| 29 | [大隐于朝](https://www.binance.com/zh-TC/copy-trading/lead-details/5084240749029615104?timeRange=30D) | 58 | 12956553602% | 159.7% | 39.4% | 75.1% | 0.52 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 30 | [金镶玉](https://www.binance.com/zh-TC/copy-trading/lead-details/5111266863036727808?timeRange=30D) | 39 | 87711566% | 157.5% | 10.0% | 61.9% | 1.44 | 無 | 未偵測到明顯高風險交易模式 | ⚠️ 高風險候補 |
| 31 | [克己复利](https://www.binance.com/zh-TC/copy-trading/lead-details/5118957184695262465?timeRange=30D) | 34 | 7738673% | 153.1% | 44.9% | 67.1% | 0.90 | 無 | 網格 / 區間交易 | ⚠️ 高風險候補 |
| 33 | [goodhaha](https://www.binance.com/zh-TC/copy-trading/lead-details/5066421744284270337?timeRange=30D) | 70 | 655402984% | 142.9% | 26.9% | 96.2% | 0.47 | 無 | 交易紀錄不足 | ⚠️ 高風險候補 |
| 34 | [一只饲养员](https://www.binance.com/zh-TC/copy-trading/lead-details/5106111650998328832?timeRange=30D) | 43 | 296817% | 133.4% | 42.4% | 87.0% | 0.27 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 39 | [悟空行者](https://www.binance.com/zh-TC/copy-trading/lead-details/5058554442875015681?timeRange=30D) | 76 | 14595% | 127.0% | 46.6% | 67.8% | 0.55 | 無 | 剝頭皮 | ⚠️ 高風險候補 |
| 46 | [添天-Trader](https://www.binance.com/zh-TC/copy-trading/lead-details/5116162540710377216?timeRange=30D) | 36 | 5323% | 106.5% | 48.8% | 43.1% | 1.27 | 無 | 波段交易 | ⚠️ 高風險候補 |
| 55 | [分析师李涵](https://www.binance.com/zh-TC/copy-trading/lead-details/4871505589745295616?timeRange=30D) | 205 | 626% | 85.1% | 45.6% | 84.0% | 2.90 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 59 | [Off-Duty Santa](https://www.binance.com/zh-TC/copy-trading/lead-details/5099790348346659328?timeRange=30D) | 47 | 140299% | 75.0% | 0.4% | 84.9% | 0.37 | 無 | 未偵測到明顯高風險交易模式 | ⚠️ 高風險候補 |
| 65 | [Genacud](https://www.binance.com/zh-TC/copy-trading/lead-details/5106482936524032000?timeRange=30D) | 42 | 24614% | 66.5% | 17.4% | 93.3% | 0.24 | 無 | 未偵測到明顯高風險交易模式 | ⚠️ 高風險候補 |
| 66 | [豆壳资管 ALPHA...](https://www.binance.com/zh-TC/copy-trading/lead-details/5121701902529609728?timeRange=30D) | 32 | 16564900% | 66.0% | 10.3% | 77.8% | 12.77 | 無 | 左側搶反彈但停損快 | ⚠️ 高風險候補 |
| 67 | [逢春化绿](https://www.binance.com/zh-TC/copy-trading/lead-details/5114561986167403008?timeRange=30D) | 37 | 12673222% | 64.2% | 42.7% | 58.5% | 0.59 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 68 | [方幻资本](https://www.binance.com/zh-TC/copy-trading/lead-details/5088700299483824129?timeRange=30D) | 55 | 3840% | 60.0% | 10.1% | 55.2% | 1.40 | 無 | 網格 / 區間交易 | ⚠️ 高風險候補 |
| 72 | [BTC荣主席](https://www.binance.com/zh-TC/copy-trading/lead-details/5079451489425475073?timeRange=30D) | 61 | 47099298% | 57.3% | 48.4% | 90.0% | 1.58 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 74 | [万倍 小白兔](https://www.binance.com/zh-TC/copy-trading/lead-details/5094758288553721345?timeRange=30D) | 51 | 1870% | 56.5% | 32.0% | 75.7% | 0.53 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 79 | [萧炎他哥](https://www.binance.com/zh-TC/copy-trading/lead-details/5052673756769390336?timeRange=30D) | 80 | 650588097% | 51.4% | 22.4% | 96.7% | 2.55 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 83 | [ANS568 crypto](https://www.binance.com/zh-TC/copy-trading/lead-details/4956682966099962369?timeRange=30D) | 146 | 18771% | 49.5% | 22.7% | 95.6% | 0.28 | 無 | 波段交易 | ⚠️ 高風險候補 |
| 88 | [驭鹰猎手](https://www.binance.com/zh-TC/copy-trading/lead-details/5080014986897740289?timeRange=30D) | 61 | 1776331602% | 49.0% | 20.7% | 58.5% | 0.42 | 無 | 網格 / 區間交易 | ⚠️ 高風險候補 |
| 92 | [绝绝子量化](https://www.binance.com/zh-TC/copy-trading/lead-details/5010499259088388609?timeRange=30D) | 109 | 87442% | 48.2% | 36.5% | 98.4% | 0.02 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 95 | [琴心剑魄量化](https://www.binance.com/zh-TC/copy-trading/lead-details/5027661983202255104?timeRange=30D) | 97 | 1234% | 46.0% | 13.8% | 45.1% | 2.58 | 無 | 網格 / 區間交易 | ⚠️ 高風險候補 |
| 102 | [流沐](https://www.binance.com/zh-TC/copy-trading/lead-details/4978633340637175553?timeRange=30D) | 131 | 14655% | 40.6% | 21.6% | 90.2% | 0.54 | 無 | 馬丁格爾 | ⚠️ 高風險候補 |
| 103 | [求其_](https://www.binance.com/zh-TC/copy-trading/lead-details/5075520138668888576?timeRange=30D) | 64 | 1612138% | 39.7% | 23.0% | 63.5% | 1.29 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 115 | [The Wealth Explorer](https://www.binance.com/zh-TC/copy-trading/lead-details/5011927020146328832?timeRange=30D) | 108 | 886% | 35.4% | 10.4% | 65.6% | 2.73 | 無 | 網格 / 區間交易 | ⚠️ 高風險候補 |
| 117 | [Trafagen VS](https://www.binance.com/zh-TC/copy-trading/lead-details/5109382782177090817?timeRange=30D) | 40 | 1431% | 35.0% | 31.7% | 87.8% | 0.12 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 119 | [不停梭-](https://www.binance.com/zh-TC/copy-trading/lead-details/5090588047188778241?timeRange=30D) | 53 | 13035% | 34.4% | 15.0% | 71.4% | 2.07 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 124 | [平静交易不上头](https://www.binance.com/zh-TC/copy-trading/lead-details/4592223376813667584?timeRange=30D) | 397 | -15% | 30.3% | 41.1% | 63.2% | 0.45 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 125 | [星辰社区-意钦](https://www.binance.com/zh-TC/copy-trading/lead-details/4788776444236355328?timeRange=30D) | 262 | 1683% | 30.0% | 11.7% | 97.3% | 0.20 | 無 | DCA / 左側交易 | ⚠️ 高風險候補 |
| 135 | [D2AO Havana Fund](https://www.binance.com/zh-TC/copy-trading/lead-details/5014431893767672321?timeRange=30D) | 106 | 195% | 27.6% | 15.5% | 94.1% | 25.38 | 無 | 交易紀錄不足 | ⚠️ 高風險候補 |
| 其餘 92 位 | 見下方「不建議跟單」分組 | | | | | | | | | 🚫 avoid |

> 完整 140 筆機器可讀資料（含本表未顯示的逆勢加碼率、加碼層數、開平倉比例、歷史關閉次數、隱藏歷史天數等全部欄位）在 `reports/binance-30d-roi-ranking.json`。

---

## 質化分析：每一位的具體理由

### 🏆 首選推薦（1 位）

**[32] [芝麻芝麻](https://www.binance.com/zh-TC/copy-trading/lead-details/4971482014090862081?timeRange=30D)** — 136 天、近 30 天 ROI 144.1%、MDD 14.1%、勝率僅 46.7%、盈虧比 **7.82**。全榜唯一達到「較適合跟單候選」門檻的人，而且體質剛好跟前面 96 位「逆勢加碼」家族相反：勝率不到一半，但**贏的時候贏很多、輸的時候輸很少**（右側趨勢跟隨，等方向確認才進場），逆勢加碼率只有 5.2%，136 天歷史裡沒有任何虧損期入金、目前也沒有浮虧倉位。這是唯一一個「不需要高勝率也能穩定獲利」的健康結構——盈虧比 7.82 代表就算未來勝率降到只有 20% 也還有機會打平以上。全榜最值得認真考慮的一位。

### ✅ 可小額測試候選（11 位，按盈虧比排序）

- **[56] [静宝Trader](https://www.binance.com/zh-TC/copy-trading/lead-details/5062779826159549440?timeRange=30D)**：盈虧比 59.96（近乎不可思議），但這是因為 73 天裡幾乎沒有虧損樣本撐出來的比值，波段型態、目前小額浮虧 34 USDT。數字漂亮但統計意義上仍偏薄，小額測試即可，不要因為這個比值就重倉。
- **[126] [人生到处知何似](https://www.binance.com/zh-TC/copy-trading/lead-details/4556315195316581632?timeRange=30D)**：422 天最長歷史之一，盈虧比 11.25、逆勢加碼率 0%，體質乾淨，唯一疑慮是勝率 93.2% 偏高，仍要留意尾部風險，但目前沒有觸發任何警示。
- **[10] [来一杯清茶](https://www.binance.com/zh-TC/copy-trading/lead-details/5114550459351371264?timeRange=30D)**：本次專案分析過的老面孔，37 天、盈虧比 4.09。前幾輪追蹤下來持續穩定，逆勢加碼率 30.9% 偏高但尚未觸發警示，值得繼續觀察但別重倉。
- **[111] [Hassiiiiiii](https://www.binance.com/zh-TC/copy-trading/lead-details/5023790571803063297?timeRange=30D)**：99 天、盈虧比 3.35、逆勢加碼率 0%，型態乾淨。
- **[121] [笑里藏猫](https://www.binance.com/zh-TC/copy-trading/lead-details/4373485373878739969?timeRange=30D)**：548 天全榜第二長歷史，盈虧比 2.51、逆勢加碼率僅 4.3%，右側趨勢型態，體質穩定但近 30 天 ROI 已放緩至 33.1%，適合看重穩定性而非爆發力的人。
- **[85] [布鲁斯村长](https://www.binance.com/zh-TC/copy-trading/lead-details/4904114645412812033?timeRange=30D)**：182 天、盈虧比 2.34，但逆勢加碼率 20%、最深加碼 42 層、目前有 416 USDT 浮虧，属於本組裡風險係數較高的一位，小額測試務必設好停損。
- **[48] [富一次就足够](https://www.binance.com/zh-TC/copy-trading/lead-details/5121749078299654657?timeRange=30D)**：本專案先前追蹤過，剝頭皮型態，盈虧比 2.10，但要留意最深加碼層數高達 179 層（雖然目前沒觸發警示），且勝率僅 43.9%——高頻策略，跟單延遲與手續費侵蝕會比其他型態更明顯。
- **[40] [HK大叔D](https://www.binance.com/zh-TC/copy-trading/lead-details/5082904357337048064?timeRange=30D)**：本專案先前追蹤過的另一位，59 天、盈虧比 1.61，體質持續健康，歷史關閉 3 次但未達警示門檻。
- **[105] [专空暴涨币](https://www.binance.com/zh-TC/copy-trading/lead-details/5107107059031359745?timeRange=30D)**：42 天、盈虧比 1.44，波段型態，樣本尚淺，先小額觀察。
- **[107] [Callme卢本伟](https://www.binance.com/zh-TC/copy-trading/lead-details/4512404768792222208?timeRange=30D)**：452 天全榜最長歷史，但盈虧比僅 1.17，貼近及格邊緣，長壽不等於體質好，建議持續複查。
- **[75] [Passion lucky little orange king](https://www.binance.com/zh-TC/copy-trading/lead-details/5097511984930658560?timeRange=30D)**：100% 勝率、盈虧比算不出來（從未虧損），49 天樣本——跟本專案先前分析過的「星辰社区-海」是同一種型態：還沒被真正的虧損行情測試過，數字漂亮但參考價值有限，務必小額。

### 👀 觀察中（1 位）

**[122] [Connnars](https://www.binance.com/zh-TC/copy-trading/lead-details/5050018266813140224?timeRange=30D)** — 81 天、近 30 天 ROI 只有 32.0%、100% 勝率但樣本太薄（交易紀錄不足），判斷不出型態。暫不推薦，也沒有明確理由排除，純觀察。

### ⚠️ 高風險候補（35 位）

這組沒有觸發「直接證據」等級的紅燈（沒有虧損期入金、回撤 <50%），但警示數已經多到不能忽略——多數是逆勢加碼率偏高（20~60% 區間）、或盈虧比 <0.5、或回撤 30~49% 之間。完整名單與逆勢加碼率、加碼層數、隱藏歷史天數見下：

- **[1] [VickyKaushal](https://www.binance.com/zh-TC/copy-trading/lead-details/5118776604240532481?timeRange=30D)**：34天、近30天ROI 5306.6%、MDD 0.1%、勝率 83.6%、盈虧比 0.14、逆勢加碼 11.8%（最深 41 層）（歷史關閉20次；隱藏歷史89天；重建數據不可靠）——本專案先前深入分析過，網格型態，20 次重開，MDD 顯示 0.1% 但那只是這一輪太年輕還沒經歷過回撤，不建議跟。
- **[4] [凯迪财经](https://www.binance.com/zh-TC/copy-trading/lead-details/5119090739504514048?timeRange=30D)**：34天、近30天ROI 506.8%、MDD 7.2%、勝率 76.9%、盈虧比 0.51、逆勢加碼 35.9%（最深 14 層）（歷史關閉14次；隱藏歷史60天；現正浮虧166 USDT；重建數據不可靠）
- **[6] [皮卡丘量化](https://www.binance.com/zh-TC/copy-trading/lead-details/5100314095265428480?timeRange=30D)**：47天、近30天ROI 452.6%、MDD 49.7%、勝率僅 29.7%、盈虧比 4.55、逆勢加碼 31.3%（最深 158 層）（歷史關閉11次；隱藏歷史54天；現正浮虧2,475 USDT；重建數據不可靠）——勝率低但盈虧比高，型態上比較像右側，但隱藏歷史與 11 次重開仍是隱憂。
- **[11] [还有那么多目标没实现](https://www.binance.com/zh-TC/copy-trading/lead-details/5072119827468653313?timeRange=30D)**：66天、近30天ROI 379.4%、MDD 41.7%、勝率 96.2%、盈虧比 0.99、逆勢加碼 35.1%（最深 45 層）（現正浮虧19 USDT）——盈虧比卡在及格線下,高勝率+逆勢加碼組合需留意。
- **[20] [币指多ai量化工具3](https://www.binance.com/zh-TC/copy-trading/lead-details/5097406838970133249?timeRange=30D)**：49天、逆勢加碼 41.5%（最深 66 層）、盈虧比 0.60，網格型態，回撤控制尚可(8.3%)但加碼行為偏重。
- **[23] [市梦率 200](https://www.binance.com/zh-TC/copy-trading/lead-details/5123333115570932993?timeRange=30D)**：31天、100% 勝率、盈虧比算不出來、現正浮虧86 USDT，樣本剛好卡在門檻邊緣，太薄。
- **[24] [积累原始资本](https://www.binance.com/zh-TC/copy-trading/lead-details/5109439272237132800?timeRange=30D)**：40天、MDD 35.6%、盈虧比 1.06，未偵測到明顯策略型態，回撤是主要疑慮。
- **[29] [大隐于朝](https://www.binance.com/zh-TC/copy-trading/lead-details/5084240749029615104?timeRange=30D)**：58天、盈虧比 0.52、逆勢加碼 20.5%（最深 38 層）、歷史關閉 8 次——已達serial closer門檻。
- **[30] [金镶玉](https://www.binance.com/zh-TC/copy-trading/lead-details/5111266863036727808?timeRange=30D)**：39天、歷史關閉高達 **46 次**（全榜第二高）、隱藏歷史 76 天、重建數據不可靠——重開次數極端，數字本身就該質疑。
- **[31] [克己复利](https://www.binance.com/zh-TC/copy-trading/lead-details/5118957184695262465?timeRange=30D)**：34天、MDD 44.9%、盈虧比 0.90，網格型態，回撤偏高。
- **[33] [goodhaha](https://www.binance.com/zh-TC/copy-trading/lead-details/5066421744284270337?timeRange=30D)**：近30天ROI 142.9% 亮眼，但隱藏歷史 66 天、重建數據不可靠——很可能包含前一輪的殘留績效，不能照單全收。
- **[34] [一只饲养员](https://www.binance.com/zh-TC/copy-trading/lead-details/5106111650998328832?timeRange=30D)**：43天、盈虧比 0.27、隱藏歷史 73 天。
- **[39] [悟空行者](https://www.binance.com/zh-TC/copy-trading/lead-details/5058554442875015681?timeRange=30D)**：75天、MDD 46.6%、歷史關閉 13 次、隱藏歷史 8 天。
- **[46] [添天-Trader](https://www.binance.com/zh-TC/copy-trading/lead-details/5116162540710377216?timeRange=30D)**：36天、MDD 48.8%、勝率僅 43.1%、隱藏歷史 87 天（全組最長之一）。
- **[55] [分析师李涵](https://www.binance.com/zh-TC/copy-trading/lead-details/4871505589745295616?timeRange=30D)**：204天較長歷史、盈虧比 2.90 尚可，但 MDD 45.6% 偏高、現正浮虧140 USDT。
- **[59] [Off-Duty Santa](https://www.binance.com/zh-TC/copy-trading/lead-details/5099790348346659328?timeRange=30D)**：近30天ROI 75.0%，但歷史關閉 17 次、隱藏歷史 82 天，同樣是「重開洗數字」嫌疑。
- **[65] [Genacud](https://www.binance.com/zh-TC/copy-trading/lead-details/5106482936524032000?timeRange=30D)**：42天、盈虧比 0.24 偏弱。
- **[66] [豆壳资管 ALPHA...](https://www.binance.com/zh-TC/copy-trading/lead-details/5121701902529609728?timeRange=30D)**：本專案先前分析過，盈虧比 12.77 亮眼但逆勢加碼率高達 50.3%、歷史關閉 8 次，樣本僅 32 天、18 筆平倉，判斷依據仍薄。
- **[67] [逢春化绿](https://www.binance.com/zh-TC/copy-trading/lead-details/5114561986167403008?timeRange=30D)**：37天、逆勢加碼 46.6%、歷史關閉 13 次、隱藏歷史 83 天——三個負面訊號疊加。
- **[68] [方幻资本](https://www.binance.com/zh-TC/copy-trading/lead-details/5088700299483824129?timeRange=30D)**：55天、逆勢加碼 49.7%（接近馬丁門檻），網格型態。
- **[72] [BTC荣主席](https://www.binance.com/zh-TC/copy-trading/lead-details/5079451489425475073?timeRange=30D)**：MDD 48.4%、盈虧比尚可 1.58，逆勢加碼 35.5%，DCA 左側型態，加碼行為的風險本身不小。
- **[74] [万倍 小白兔](https://www.binance.com/zh-TC/copy-trading/lead-details/5094758288553721345?timeRange=30D)**：50天、盈虧比 0.53、MDD 32%。
- **[79] [萧炎他哥](https://www.binance.com/zh-TC/copy-trading/lead-details/5052673756769390336?timeRange=30D)**：逆勢加碼 54.5%、歷史關閉 17 次，盈虧比 2.55 尚可但加碼行為偏重。
- **[83] [ANS568 crypto](https://www.binance.com/zh-TC/copy-trading/lead-details/4956682966099962369?timeRange=30D)**：本專案長期追蹤對象，最新一輪盈虧比從先前的 1.24 惡化到 0.28，7 天窗口已轉負（詳見先前對話紀錄），這次批量分析再次確認**已從 followable 降級**，建議先停。
- **[88] [驭鹰猎手](https://www.binance.com/zh-TC/copy-trading/lead-details/5080014986897740289?timeRange=30D)**：61天、隱藏歷史 61 天（幾乎跟顯示天數一樣長，代表官方起始時間幾乎沒有意義）。
- **[92] [绝绝子量化](https://www.binance.com/zh-TC/copy-trading/lead-details/5010499259088388609?timeRange=30D)**：盈虧比僅 0.02（全組最差之一），98.4% 超高勝率，典型賺小賠大結構。
- **[95] [琴心剑魄量化](https://www.binance.com/zh-TC/copy-trading/lead-details/5027661983202255104?timeRange=30D)**：加碼層數高達 197 層，網格型態。
- **[102] [流沐](https://www.binance.com/zh-TC/copy-trading/lead-details/4978633340637175553?timeRange=30D)**：逆勢加碼 43.7%、加碼層數 89 層、加碼價距偏寬（非緊密網格），維持馬丁格爾分類。
- **[103] [求其_](https://www.binance.com/zh-TC/copy-trading/lead-details/5075520138668888576?timeRange=30D)**：歷史關閉 17 次、隱藏歷史 27 天、現正浮虧195 USDT，三重疊加。
- **[115] [The Wealth Explorer](https://www.binance.com/zh-TC/copy-trading/lead-details/5011927020146328832?timeRange=30D)**：盈虧比 2.73 尚可，但逆勢加碼 48.1%（接近馬丁門檻）、加碼層數 28。
- **[117] [Trafagen VS](https://www.binance.com/zh-TC/copy-trading/lead-details/5109382782177090817?timeRange=30D)**：盈虧比僅 0.12，隱藏歷史 74 天。
- **[119] [不停梭-](https://www.binance.com/zh-TC/copy-trading/lead-details/5090588047188778241?timeRange=30D)**：逆勢加碼 55.9%，盈虧比 2.07 尚可但加碼行為偏重。
- **[124] [平静交易不上头](https://www.binance.com/zh-TC/copy-trading/lead-details/4592223376813667584?timeRange=30D)**：397天長歷史但近 30 天 ROI 已轉負（-15%的年化背後，30天ROI 30.3%其實是短期反彈，長期趨勢仍偏弱），MDD 41.1%。
- **[125] [星辰社区-意钦](https://www.binance.com/zh-TC/copy-trading/lead-details/4788776444236355328?timeRange=30D)**：97.3% 超高勝率、盈虧比僅 0.20，典型賺小賠大。
- **[135] [D2AO Havana Fund](https://www.binance.com/zh-TC/copy-trading/lead-details/5014431893767672321?timeRange=30D)**：盈虧比 25.38 極高，但隱藏歷史 15 天、重建數據不可靠，樣本待驗證。

### 🚫 不建議跟單（92 位，佔全榜 65.7%）

按觸發的核心證據分四組。每組先講「這個機制在防什麼事故」，再列出全部名單。**分組依據是回撤／虧損期入金／逆勢加碼率這些獨立指標，不受上述策略型態標籤修正影響。**

#### A. 虧損期入金——最直接的證據（51 位）

在虧損倉位還沒平倉時，帳戶收到新的資金轉入。這代表操盤者本人正在手動介入避免強平，跟單者無法同步做到同一件事。特別注意 **[81] 观火明夷-天空** 跟 **[71] 杰玛尔资管**——都是本專案先前深入分析過的案例（前者靠 $7,534 緊急輸血才躲過強平、後者官方入金只有 $500 卻提走 $11,700，同時歷史關閉 **29 次**）。**金額由高到低**：

- **[108] [龟兔赛跑985-稳健型](https://www.binance.com/zh-TC/copy-trading/lead-details/4635972047552772865?timeRange=30D)**：367天、近30天ROI 37.8%、MDD 64.2%、勝率 61.2%、盈虧比 0.55、逆勢加碼 36.3%（最深 14 層）、虧損期入金 9 次共 152,847 USDT
- **[84] [小拜拜](https://www.binance.com/zh-TC/copy-trading/lead-details/4955210500316427776?timeRange=30D)**：147天、近30天ROI 49.3%、MDD 39.1%、勝率 66.7%、盈虧比 1.35、逆勢加碼 32.3%（最深 12 層）、虧損期入金 15 次共 127,012 USDT
- **[49] [GGbond哦](https://www.binance.com/zh-TC/copy-trading/lead-details/4704742992209563648?timeRange=30D)**：320天、近30天ROI 92.5%、MDD 40.9%、勝率 98.9%、盈虧比 0.04、逆勢加碼 0.0%（最深 33 層）、虧損期入金 8 次共 79,122 USDT
- **[8] [趋势交易王](https://www.binance.com/zh-TC/copy-trading/lead-details/5121666018948220416?timeRange=30D)**：32天、近30天ROI 397.0%、MDD 62.7%、勝率 14.6%、盈虧比 0.91、逆勢加碼 38.9%（最深 963 層）、虧損期入金 3 次共 62,070 USDT（隱藏歷史87天；重建數據不可靠）
- **[7] [汤姆cat](https://www.binance.com/zh-TC/copy-trading/lead-details/5073038860429169153?timeRange=30D)**：66天、近30天ROI 420.0%、MDD 73.6%、勝率 53.5%、盈虧比 1.09、逆勢加碼 27.4%（最深 39 層）、虧損期入金 1 次共 50,100 USDT
- **[114] [Nevermore_7 AKA 老胖猴儿](https://www.binance.com/zh-TC/copy-trading/lead-details/5036596596958492416?timeRange=30D)**：91天、MDD 75.4%、勝率 64.7%、盈虧比 0.48、逆勢加碼 60.2%（最深 108 層）、虧損期入金 49 次共 49,369 USDT
- **[90] [傑森投資基金](https://www.binance.com/zh-TC/copy-trading/lead-details/5010138181201982465?timeRange=30D)**：109天、MDD 57.2%、勝率 45.9%、盈虧比 1.06、逆勢加碼 39.2%（最深 68 層）、虧損期入金 19 次共 26,546 USDT（隱藏歷史15天；現正浮虧1,539 USDT；重建數據不可靠）
- **[97] [绿茶时光](https://www.binance.com/zh-TC/copy-trading/lead-details/5044016029246786817?timeRange=30D)**：86天、MDD 40.8%、勝率 96.7%、盈虧比 0.04、逆勢加碼 35.1%（最深 59 層）、虧損期入金 6 次共 19,867 USDT
- **[82] [闹闹基金会](https://www.binance.com/zh-TC/copy-trading/lead-details/5123468843328084481?timeRange=30D)**：31天、MDD 6.5%、勝率 90.7%、盈虧比 0.45、逆勢加碼 41.2%（最深 37 層）、虧損期入金 1 次共 11,469 USDT（現正浮虧153 USDT）
- **[109] [雨后的夏天](https://www.binance.com/zh-TC/copy-trading/lead-details/5122837800040158209?timeRange=30D)**：31天、MDD 16.1%、勝率 41.5%、盈虧比 1.23、逆勢加碼 24.5%（最深 10 層）、虧損期入金 1 次共 10,000 USDT（隱藏歷史61天；現正浮虧2,532 USDT；重建數據不可靠）
- **[69] [Phorusrhacidae](https://www.binance.com/zh-TC/copy-trading/lead-details/3866994260364752129?timeRange=30D)**：898天、MDD 59.3%、勝率 90.5%、盈虧比 0.08、逆勢加碼 0.0%（最深 11 層）、虧損期入金 5 次共 8,986 USDT（歷史關閉17次）
- **[81] [观火明夷-天空](https://www.binance.com/zh-TC/copy-trading/lead-details/4818459045963553537?timeRange=30D)**：241天、MDD 43.3%、勝率 98.6%、盈虧比 0.17、逆勢加碼 28.2%（最深 4 層）、虧損期入金 3 次共 7,534 USDT
- **[101] [Pei Rath tObx 骆驼祥子](https://www.binance.com/zh-TC/copy-trading/lead-details/4917900657997249280?timeRange=30D)**：173天、MDD 84.1%、勝率 88.4%、盈虧比 0.10、逆勢加碼 76.7%（最深 128 層）、虧損期入金 1 次共 5,500 USDT（現正浮虧6,320 USDT）
- **[91] [意策稳算量化](https://www.binance.com/zh-TC/copy-trading/lead-details/5017907810143209217?timeRange=30D)**：104天、MDD 29.4%、勝率 60.7%、盈虧比 0.83、逆勢加碼 30.2%（最深 48 層）、虧損期入金 15 次共 4,073 USDT（歷史關閉23次）
- **[106] [南帝一灯](https://www.binance.com/zh-TC/copy-trading/lead-details/5033762598222902784?timeRange=30D)**：93天、MDD 19.8%、勝率 85.3%、盈虧比 0.49、逆勢加碼 36.7%（最深 7 層）、虧損期入金 1 次共 4,000 USDT（歷史關閉13次；現正浮虧11 USDT）
- **[21] [重生之我在币圈捡垃圾-](https://www.binance.com/zh-TC/copy-trading/lead-details/5088110611707352576?timeRange=30D)**：55天、MDD 91.0%、勝率 84.4%、盈虧比 0.35、逆勢加碼 52.6%（最深 39 層）、虧損期入金 6 次共 3,433 USDT（隱藏歷史14天；重建數據不可靠）
- **[120] [Cw00](https://www.binance.com/zh-TC/copy-trading/lead-details/5112772623301787392?timeRange=30D)**：38天、MDD 2.5%、勝率 82.2%、盈虧比 1.03、逆勢加碼 10.0%（最深 4 層）、虧損期入金 1 次共 3,228 USDT
- **[51] [小鲨鱼shark](https://www.binance.com/zh-TC/copy-trading/lead-details/5054101289664245760?timeRange=30D)**：79天、MDD 42.7%、勝率 53.0%、盈虧比 0.98、逆勢加碼 12.2%（最深 9 層）、虧損期入金 31 次共 3,219 USDT
- **[62] [清风道](https://www.binance.com/zh-TC/copy-trading/lead-details/5106888175985958913?timeRange=30D)**：42天、MDD 26.6%、勝率 81.5%、盈虧比 0.29、逆勢加碼 43.5%（最深 6 層）、虧損期入金 1 次共 3,000 USDT（隱藏歷史78天；重建數據不可靠）
- **[19] [嗨小发](https://www.binance.com/zh-TC/copy-trading/lead-details/5096238483765341696?timeRange=30D)**：50天、MDD 71.0%、勝率 97.8%、盈虧比 0.03、逆勢加碼 28.3%（最深 106 層）、虧損期入金 3 次共 2,500 USDT（現正浮虧112 USDT）
- **[94] [TraderOWL](https://www.binance.com/zh-TC/copy-trading/lead-details/4725909602392933633?timeRange=30D)**：305天、MDD 81.4%、勝率 58.5%、盈虧比 0.98、逆勢加碼 21.9%（最深 8 層）、虧損期入金 2 次共 2,435 USDT
- **[9] [芸辰教员](https://www.binance.com/zh-TC/copy-trading/lead-details/5107682424653877504?timeRange=30D)**：42天、MDD 56.3%、勝率 91.2%、盈虧比 3.17、逆勢加碼 25.0%（最深 5 層）、虧損期入金 1 次共 2,036 USDT（隱藏歷史2天；現正浮虧35 USDT；重建數據不可靠）
- **[71] [杰玛尔资管](https://www.binance.com/zh-TC/copy-trading/lead-details/5107130273071040257?timeRange=30D)**：42天、MDD 9.0%、勝率 84.8%、盈虧比 0.54、逆勢加碼 28.4%（最深 21 層）、虧損期入金 1 次共 2,000 USDT（歷史關閉29次；隱藏歷史78天；重建數據不可靠）
- **[133] [CopyLite](https://www.binance.com/zh-TC/copy-trading/lead-details/5082085932966866945?timeRange=30D)**：59天、MDD 53.3%、勝率 71.6%、盈虧比 0.54、逆勢加碼 0.0%（最深 112 層）、虧損期入金 8 次共 1,600 USDT（隱藏歷史51天；現正浮虧1,524 USDT；重建數據不可靠）
- **[60] [浪中念悦](https://www.binance.com/zh-TC/copy-trading/lead-details/5071099057063556608?timeRange=30D)**：67天、MDD 39.3%、勝率 79.8%、盈虧比 3.97、逆勢加碼 31.0%（最深 7 層）、虧損期入金 2 次共 1,179 USDT（現正浮虧138 USDT）
- **[128] [圣大](https://www.binance.com/zh-TC/copy-trading/lead-details/4901853412080677888?timeRange=30D)**：184天、MDD 23.2%、勝率 67.6%、盈虧比 0.43、逆勢加碼 27.7%（最深 6 層）、虧損期入金 2 次共 1,047 USDT（現正浮虧23 USDT）
- **[127] [小涛_红雷团伙](https://www.binance.com/zh-TC/copy-trading/lead-details/4956058547359265281?timeRange=30D)**：146天、MDD 87.0%、勝率 98.0%、盈虧比 0.03、逆勢加碼 68.3%（最深 13 層）、虧損期入金 2 次共 1,037 USDT
- **[54] [悟空只想空](https://www.binance.com/zh-TC/copy-trading/lead-details/5063354055786336000?timeRange=30D)**：72天、MDD 28.4%、勝率 60.7%、盈虧比 0.79、逆勢加碼 0.0%（最深 4 層）、虧損期入金 1 次共 1,000 USDT
- **[86] [幻方](https://www.binance.com/zh-TC/copy-trading/lead-details/4847213992013158656?timeRange=30D)**：221天、MDD 56.3%、勝率 81.7%、盈虧比 0.56、逆勢加碼 34.1%（最深 241 層）、虧損期入金 1 次共 1,000 USDT（現正浮虧861 USDT）
- **[131] [馨影5245](https://www.binance.com/zh-TC/copy-trading/lead-details/5123706933479274240?timeRange=30D)**：31天、MDD 6.7%、勝率 93.9%、盈虧比 0.17、逆勢加碼 11.8%（最深 4 層）、虧損期入金 1 次共 1,000 USDT
- **[35] [deepseek量化之路](https://www.binance.com/zh-TC/copy-trading/lead-details/5027731030778117632?timeRange=30D)**：97天、MDD 60.1%、勝率 64.5%、盈虧比 0.58、逆勢加碼 25.4%（最深 13 層）、虧損期入金 3 次共 886 USDT（隱藏歷史23天；現正浮虧577 USDT；重建數據不可靠）
- **[93] [葫芦娃黑马](https://www.binance.com/zh-TC/copy-trading/lead-details/4962823996387848961?timeRange=30D)**：142天、MDD 26.6%、勝率 75.5%、盈虧比 1.07、逆勢加碼 65.8%（最深 80 層）、虧損期入金 2 次共 850 USDT
- **[116] [深圳老韭菜](https://www.binance.com/zh-TC/copy-trading/lead-details/5025347618056880384?timeRange=30D)**：98天、MDD 12.8%、勝率 77.4%、盈虧比 1.21、逆勢加碼 44.4%（最深 26 層）、虧損期入金 2 次共 775 USDT（現正浮虧3 USDT）
- **[14] [逐梦天舟](https://www.binance.com/zh-TC/copy-trading/lead-details/5046374891657474560?timeRange=30D)**：84天、MDD 56.6%、勝率 65.6%、盈虧比 1.11、逆勢加碼 22.6%（最深 9 層）、虧損期入金 4 次共 570 USDT（現正浮虧596 USDT）
- **[112] [李非与](https://www.binance.com/zh-TC/copy-trading/lead-details/4995909937889293825?timeRange=30D)**：119天、MDD 59.5%、勝率 66.7%、盈虧比 2.61、逆勢加碼 23.5%（最深 10 層）、虧損期入金 1 次共 500 USDT（現正浮虧780 USDT）
- **[123] [美联储副主席沃干](https://www.binance.com/zh-TC/copy-trading/lead-details/5105934327203668481?timeRange=30D)**：43天、MDD 32.5%、勝率 75.8%、盈虧比 1.13、逆勢加碼 42.3%（最深 9 層）、虧損期入金 1 次共 500 USDT
- **[138] [Pro BTC Trading](https://www.binance.com/zh-TC/copy-trading/lead-details/4726761499290459904?timeRange=30D)**：304天、MDD 76.2%、勝率 37.2%、盈虧比 1.94、逆勢加碼 0.0%（最深 10 層）、虧損期入金 1 次共 500 USDT
- **[16] [开局100u](https://www.binance.com/zh-TC/copy-trading/lead-details/5022193685685677825?timeRange=30D)**：101天、MDD 89.5%、勝率 68.7%、盈虧比 1.05、逆勢加碼 18.5%（最深 21 層）、虧損期入金 3 次共 495 USDT（現正浮虧860 USDT）
- **[139] [湾流](https://www.binance.com/zh-TC/copy-trading/lead-details/5075271858529100544?timeRange=30D)**：64天、MDD 17.7%、勝率 64.9%、盈虧比 0.94、逆勢加碼 9.7%（最深 3 層）、虧損期入金 1 次共 451 USDT
- **[78] [地球是个球](https://www.binance.com/zh-TC/copy-trading/lead-details/5085373373623542016?timeRange=30D)**：57天、MDD 16.0%、勝率 80.4%、盈虧比 0.49、逆勢加碼 17.4%（最深 6 層）、虧損期入金 1 次共 310 USDT
- **[113] [币圈十二叔](https://www.binance.com/zh-TC/copy-trading/lead-details/5051200019981811968?timeRange=30D)**：81天、MDD 19.5%、勝率 56.6%、盈虧比 0.39、逆勢加碼 0.0%（最深 20 層）、虧損期入金 2 次共 304 USDT（歷史關閉15次；隱藏歷史82天；重建數據不可靠）
- **[22] [勇途量化策略](https://www.binance.com/zh-TC/copy-trading/lead-details/5110618465056505600?timeRange=30D)**：40天、MDD 16.4%、勝率 80.2%、盈虧比 0.58、逆勢加碼 35.0%（最深 16 層）、虧損期入金 1 次共 282 USDT（歷史關閉12次；隱藏歷史55天；現正浮虧200 USDT；重建數據不可靠）
- **[44] [牛熊摆渡人](https://www.binance.com/zh-TC/copy-trading/lead-details/5096968193101811713?timeRange=30D)**：49天、MDD 74.9%、勝率 79.3%、盈虧比 0.83、逆勢加碼 41.5%（最深 17 層）、虧損期入金 1 次共 275 USDT
- **[61] [一步一步爬山虎](https://www.binance.com/zh-TC/copy-trading/lead-details/5057146551021088512?timeRange=30D)**：76天、MDD 35.4%、勝率 88.7%、盈虧比 0.33、逆勢加碼 21.7%（最深 4 層）、虧損期入金 1 次共 234 USDT
- **[77] [善富E族-姐夫](https://www.binance.com/zh-TC/copy-trading/lead-details/5076494843629357824?timeRange=30D)**：63天、MDD 46.7%、勝率 79.1%、盈虧比 0.31、逆勢加碼 60.1%（最深 437 層）、虧損期入金 2 次共 225 USDT（隱藏歷史21天；重建數據不可靠）
- **[73] [澄衡波浪](https://www.binance.com/zh-TC/copy-trading/lead-details/5077826926356165632?timeRange=30D)**：62天、MDD 37.5%、勝率 36.4%、盈虧比 2.09、逆勢加碼 0.0%（最深 23 層）、虧損期入金 1 次共 206 USDT
- **[28] [WayneChu](https://www.binance.com/zh-TC/copy-trading/lead-details/4991821431728314112?timeRange=30D)**：122天、MDD 72.1%、勝率 80.1%、盈虧比 0.29、逆勢加碼 0.0%（最深 39 層）、虧損期入金 1 次共 200 USDT
- **[5] [Money Empire ](https://www.binance.com/zh-TC/copy-trading/lead-details/5111693353246966784?timeRange=30D)**：39天、MDD 44.2%、勝率 76.0%、盈虧比 0.50、逆勢加碼 9.3%（最深 33 層）、虧損期入金 1 次共 100 USDT（隱藏歷史31天；現正浮虧39 USDT；重建數據不可靠）
- **[50] [阳光算力](https://www.binance.com/zh-TC/copy-trading/lead-details/5079642847105446401?timeRange=30D)**：61天、MDD 30.9%、勝率 86.0%、盈虧比 0.54、逆勢加碼 38.5%（最深 34 層）、虧損期入金 1 次共 26 USDT（歷史關閉9次；隱藏歷史41天；現正浮虧43 USDT；重建數據不可靠）
- **[100] [黑袍小分队](https://www.binance.com/zh-TC/copy-trading/lead-details/5065357423393074433?timeRange=30D)**：71天、MDD 64.2%、勝率 62.6%、盈虧比 1.28、逆勢加碼 19.5%（最深 7 層）、虧損期入金 2 次共 20 USDT（現正浮虧1,874 USDT）
- **[15] [CoinKing ver_final](https://www.binance.com/zh-TC/copy-trading/lead-details/5077868856265402368?timeRange=30D)**：62天、MDD 52.6%、勝率 89.8%、盈虧比 0.08、逆勢加碼 0.0%（最深 9 層）、虧損期入金 1 次共 2 USDT（隱藏歷史57天；重建數據不可靠）

#### B. 歷史回撤過大（30 位，無虧損期入金證據，但回撤 ≥50%）

回撤 ≥50% 代表帳戶淨值曾經從高點腰斬以上。就算現在帳戶正在賺錢，這種波動幅度意味著你隨時可能在某一輪回撤剛開始時跟進，直接扛下腰斬：

- **[98] [三和道长](https://www.binance.com/zh-TC/copy-trading/lead-details/4823111653455102977?timeRange=30D)**：238天、MDD 90.2%、盈虧比 3.38，回撤全榜數一數二誇張。
- **[134] [lion086](https://www.binance.com/zh-TC/copy-trading/lead-details/4914854656769106433?timeRange=30D)**：175天、MDD 85.3%、100% 勝率但無平倉樣本可信度低。
- **[27] [大道无形我有型–BNB](https://www.binance.com/zh-TC/copy-trading/lead-details/4939017463752658432?timeRange=30D)**：158天、MDD 83.5%、盈虧比僅 0.11，馬丁型態。
- **[136] [周文王](https://www.binance.com/zh-TC/copy-trading/lead-details/4023784565234525696?timeRange=30D)**：789天全榜最長歷史，但 MDD 79.5%——長壽不代表安全。
- **[38] [阿冷HODL](https://www.binance.com/zh-TC/copy-trading/lead-details/5037029478517640449?timeRange=30D)**：MDD 77.8%，盈虧比 3.39 尚可但波動極端。
- **[36] [舔一口就泡](https://www.binance.com/zh-TC/copy-trading/lead-details/4978313648854368256?timeRange=30D)**：MDD 76.8%、盈虧比僅 0.13，網格型態。
- **[58] [ZZH111](https://www.binance.com/zh-TC/copy-trading/lead-details/5016454688410489344?timeRange=30D)**：MDD 75.6%、逆勢加碼 62.5%，ROI 已轉負。
- **[130] [叶思鸣](https://www.binance.com/zh-TC/copy-trading/lead-details/5014828616737026048?timeRange=30D)**：MDD 73.9%，歷史關閉 11 次。
- **[80] [Armandino](https://www.binance.com/zh-TC/copy-trading/lead-details/5107700514419316224?timeRange=30D)**：MDD 73.8%，隱藏歷史 53 天，數據不可靠。
- **[140] [人人富](https://www.binance.com/zh-TC/copy-trading/lead-details/4823488234015142657?timeRange=30D)**：MDD 73.5%，ROI 已轉負，網格型態加碼層數 80。
- **[104] [ETTrader](https://www.binance.com/zh-TC/copy-trading/lead-details/4750820417699079681?timeRange=30D)**：MDD 73.5%，ROI 已轉負。
- **[87] [相对论](https://www.binance.com/zh-TC/copy-trading/lead-details/4841196969892864512?timeRange=30D)**：MDD 71.8%，225 天長歷史但波動極端。
- **[129] [星星捞月](https://www.binance.com/zh-TC/copy-trading/lead-details/4929439643010061057?timeRange=30D)**：MDD 70.3%，盈虧比僅 0.26。
- **[13] [熬鹰资本](https://www.binance.com/zh-TC/copy-trading/lead-details/5075281354358777856?timeRange=30D)**：MDD 68.3%，逆勢加碼率 38.6%、加碼層數高達 **1684 層**（全榜最深）、加碼價距中位數僅 2.5 個基點（極緊密）。這是本報告經過兩輪查證修正的案例：Binance 官方 `API_KEY_TRADE` 標籤 + 訂單同毫秒重複下單，確認是自動化執行、不是人工；但開倉 1906 筆對平倉僅 265 筆（13.9%）、主力標的（SKHYNIXUSDT）1699/1722 筆訂單是單邊買進做多、價格一路從 1405 跌到 1026，也不是雙向網格——**最終正確分類是自動化執行的 DCA 左側單邊攤平**。歷史關閉 9 次。
- **[17] [Ketaaaa](https://www.binance.com/zh-TC/copy-trading/lead-details/5117787902104322049?timeRange=30D)**：MDD 66.5%，盈虧比 0.94。
- **[132] [Monkey911](https://www.binance.com/zh-TC/copy-trading/lead-details/4763954199553903361?timeRange=30D)**：MDD 65.7%，**現正浮虧 18,839 USDT**——本組現存浮虧最大者之一。
- **[89] [小新交易员](https://www.binance.com/zh-TC/copy-trading/lead-details/4855144495762648832?timeRange=30D)**：MDD 64.7%，回撤極端。
- **[26] [唐老鸭财经](https://www.binance.com/zh-TC/copy-trading/lead-details/5106649240094108929?timeRange=30D)**：MDD 63.7%，現正浮虧2,450 USDT，隱藏歷史17天。
- **[45] [三和社区-Tocoin](https://www.binance.com/zh-TC/copy-trading/lead-details/5094274581959606528?timeRange=30D)**：MDD 59.8%，隱藏歷史77天，數據不可靠。
- **[12] [他们都叫我赌怪](https://www.binance.com/zh-TC/copy-trading/lead-details/5110759170467129344?timeRange=30D)**：MDD 58.9%，逆勢加碼60.1%。
- **[96] [小高财富密码](https://www.binance.com/zh-TC/copy-trading/lead-details/4768305571155374592?timeRange=30D)**：MDD 57.4%，樣本不足無法判斷型態。
- **[2] [安妮97](https://www.binance.com/zh-TC/copy-trading/lead-details/5116997171074486529?timeRange=30D)**：MDD 57.2%，歷史關閉18次、隱藏歷史85天。
- **[52] [Sen998](https://www.binance.com/zh-TC/copy-trading/lead-details/5100189019629018625?timeRange=30D)**：MDD 56.9%，馬丁型態。
- **[3] [鎏渊](https://www.binance.com/zh-TC/copy-trading/lead-details/5108371059752839168?timeRange=30D)**：全榜近30天ROI最高之一，但 MDD 56.0%、隱藏歷史118天——極端亮眼數字背後是極端風險。
- **[53] [交易员赤木](https://www.binance.com/zh-TC/copy-trading/lead-details/5053391822100353280?timeRange=30D)**：MDD 55.9%，盈虧比0.40。
- **[43] [Cooma](https://www.binance.com/zh-TC/copy-trading/lead-details/4993536743184078592?timeRange=30D)**：MDD 55.6%，高報酬高回撤組合。
- **[37] [小明在右边](https://www.binance.com/zh-TC/copy-trading/lead-details/4996638030068086528?timeRange=30D)**：MDD 53.3%，**現正浮虧 30,319 USDT**——本組現存浮虧最大者。
- **[76] [景沐辰](https://www.binance.com/zh-TC/copy-trading/lead-details/4999370013026116608?timeRange=30D)**：MDD 52.2%，盈虧比7.62尚可，但回撤仍過大。
- **[63] [薄荷巧克力](https://www.binance.com/zh-TC/copy-trading/lead-details/4394552835450474753?timeRange=30D)**：534天長歷史，MDD 50.9%。
- **[118] [智能操作风火](https://www.binance.com/zh-TC/copy-trading/lead-details/4577970699563577857?timeRange=30D)**：407天長歷史，MDD 50.6%，勝率僅35.7%。

#### C. 逆勢加碼組合（10 位，回撤未達 50% 但加碼行為已達風險組合門檻）

回撤數字還不算誇張，但逆勢加碼率普遍在 37~49%，已經逼近風險組合的判定邊緣（型態上有的是馬丁、有的是網格或 DCA 左側，但**共同點是逆勢加碼行為本身偏重**，不管背後是人工還是自動化執行）：

- **[47] [OA_T100](https://www.binance.com/zh-TC/copy-trading/lead-details/5111142402744452609?timeRange=30D)**：逆勢加碼49.3%，隱藏歷史49天。
- **[99] [零度玩家](https://www.binance.com/zh-TC/copy-trading/lead-details/5024435657034432001?timeRange=30D)**：逆勢加碼47.9%，加碼層數146層，盈虧比9.53尚可但加碼行為本身是風險。
- **[70] [币海揽金](https://www.binance.com/zh-TC/copy-trading/lead-details/5035179920515726336?timeRange=30D)**：逆勢加碼47.4%，加碼層數416層，歷史關閉33次（全榜第三高）。
- **[18] [领航量化观势](https://www.binance.com/zh-TC/copy-trading/lead-details/5117780547953263617?timeRange=30D)**：逆勢加碼46.0%，歷史關閉18次、隱藏歷史86天，數據不可靠。
- **[137] [GoldRush](https://www.binance.com/zh-TC/copy-trading/lead-details/5031454375430644481?timeRange=30D)**：逆勢加碼45.6%，盈虧比僅0.01（全榜最差）。
- **[25] [Trump YX](https://www.binance.com/zh-TC/copy-trading/lead-details/5116343973122243585?timeRange=30D)**：逆勢加碼45.3%，隱藏歷史26天。
- **[110] [噼里啪啦蕾](https://www.binance.com/zh-TC/copy-trading/lead-details/5082830305037874176?timeRange=30D)**：逆勢加碼42.2%，隱藏歷史20天。
- **[41] [Yann3](https://www.binance.com/zh-TC/copy-trading/lead-details/5100467457994699776?timeRange=30D)**：逆勢加碼41.5%，MDD 45.7%。
- **[42] [起航未来](https://www.binance.com/zh-TC/copy-trading/lead-details/5106218213701575936?timeRange=30D)**：逆勢加碼41.1%，隱藏歷史71天。
- **[64] [1s5d4re34](https://www.binance.com/zh-TC/copy-trading/lead-details/5118494240538746112?timeRange=30D)**：逆勢加碼37.3%，歷史關閉11次、隱藏歷史26天。

#### D. 現正浮虧（1 位）

- **[57] [小宇同学](https://www.binance.com/zh-TC/copy-trading/lead-details/5115852981013542145?timeRange=30D)**：36天、近30天ROI 78.5%亮眼，但**歷史關閉 24 次**、隱藏歷史 79 天、目前正浮虧 988 USDT、重建數據不可靠——亮眼數字背後是全榜數一數二的重開次數，典型「洗記錄」嫌疑。

---

## 附註

- 完整機器可讀資料：`reports/binance-30d-roi-ranking.json`（140 筆，含本文未展開的全部欄位，包含每位交易員完整的五個時間窗 ROI）。
- 重新產生／更新此報告：`node tools/cli.mjs rank-above <目標 portfolioId> --minDays 30 | node tools/cli.mjs report /dev/stdin --out reports/xxx.md`（見 `tools/README.md`）。**注意：`report` 指令會整檔覆寫輸出檔案，不會保留手動加寫的質化分析段落——重跑前請先備份或改寫到別的檔名。**
- 本報告是**單一時間點快照**（2026-08-06）。跟單市場變化快，同一位交易員一週後的結構可能完全不同（本報告裡的 ANS568 crypto 就是活生生的例子：先前追蹤時 followable，這次批量複查已經降級為 risky）——**判定會過期，跟單前建議重新拉一次數據，不要只看這份報告的舊結論**。
- 本報告與判定邏輯僅供研究參考，不構成投資建議，不保證獲利或本金安全。
