# 資料來源

本 repo 用到、或已規劃要用的每一個資料來源，都記在這裡：從哪裡取得、內容是什麼、代表什麼意義、用在哪條公式、怎麼更新。新增或更換來源時，要在同一個 commit 更新本檔。

標記說明：

- **已實測**：網址在 2026-10-19 實際請求過、讀過內容
- ⚠️：尚未取得第一手來源，或還沒實測

## 總覽

| # | 來源 | 狀態 | 程式或檔案 |
|---|---|---|---|
| 1 | AEMO 儀表板 API（預調度電價） | 網頁使用中 | `src/dashboard_source.js` |
| 2 | NEMWeb 預調度檔（手動上傳） | 網頁使用中 | `src/upload_parser.js` |
| 3 | AEMO 每月電價與需求檔（手動上傳） | 網頁使用中 | `src/history_calibration.js` |
| 4 | GitHub Issues，標籤 `special-date` | 網頁使用中 | `src/special_date_notes.js` |
| 5 | 情境工具的市場預設值 | 網頁使用中，**沒有原始來源** | `src/scenario_presets.js` |
| 6 | AEMO STTM 雪梨天然氣每日價格 | 已存進 repo，離線分析使用中 | `data/external/sttm_sydney_daily_price.csv` |
| 7 | AER 天然氣財政年度平均價 | 已存進 repo，只用來核對 #6 | `data/external/aer_gas_market_prices_financial_year.csv` |
| 8 | AEMO 機組登記資料（NSW 電池） | 已存進 repo，離線分析使用中 | `data/external/nsw_battery_units.csv` |
| 9 | AEMO 電價與區域資料（`nsw-dispatch-bess-strategy` 的 `input/`） | 離線分析使用中 | `analysis/local_sources.py`；檔案在另一個 repo，路徑由環境變數設定 |
| 10 | Open-Meteo 歷史天氣 API | #11 規劃中 | — |
| 11 | AEMO 機組發電量 `DISPATCH_UNIT_SCADA` | #11 規劃中 | — |
| 12 | AEMO 屋頂型太陽能 `ROOFTOP_PV_ACTUAL` | #11 規劃中 | — |

特殊事件（#14）還沒有資料，補上後加進本表。離線分析的輸出檔 `data/factor_weights.json` 寫在最後一節。

## 網頁使用中的來源

### 1. AEMO 儀表板 API

| 項目 | 說明 |
|---|---|
| 網址 | `POST https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN`，請求內容 `{"timeScale":["30MIN"]}` |
| 內容 | 五個區域的 30 分鐘電價，含實際價與預測價 |
| 意義 | 取 `PERIODTYPE = FORECAST` 的列，也就是 AEMO 最新一次預調度算出的預測電價 |
| 用在哪裡 | 預調度工具的 `select_best_plan`，從中選出收益最高的充放電時段 |
| 更新 | 網頁開啟時讀一次，之後每 5 分鐘一次 |
| 限制 | 沒有公開文件與服務保證；回應中沒有預調度的執行時間 |

### 2. NEMWeb 預調度檔

| 項目 | 說明 |
|---|---|
| 網址 | <https://nemweb.com.au/Reports/Current/PredispatchIS_Reports/> 的 `PUBLIC_PREDISPATCHIS_*.zip` |
| 內容 | AEMO MMS 格式（以 `I`／`D` 開頭的列）的預調度結果 |
| 意義 | 和 #1 是同一份預測電價，多了預調度執行序號 |
| 用在哪裡 | #1 讀取失敗時的備援，算法相同；排除 `INTERVENTION ≠ 0` 的列 |
| 更新 | 使用者手動上傳；NEMWeb 沒有開放跨網域讀取，網頁無法自己下載 |
| 限制 | 上傳後自動更新會暫停 |

### 3. AEMO 每月電價與需求檔

| 項目 | 說明 |
|---|---|
| 網址 | `https://www.aemo.com.au/aemo/data/nem/priceanddemand/PRICE_AND_DEMAND_{YYYYMM}_{區域}.csv`，例如 `PRICE_AND_DEMAND_202401_NSW1.csv`（已實測） |
| 內容 | `REGION`、`SETTLEMENTDATE`、`TOTALDEMAND`（MW）、`RRP`（澳幣／MWh）、`PERIODTYPE`，每 5 分鐘一筆 |
| 意義 | 區域結算電價與總需求 |
| 用在哪裡 | 情境工具的歷史校準：`calibrate_from_history` 擬合日型態、尖峰日比例、四小時價差中位數 |
| 更新 | 使用者手動上傳 |
| 限制 | AEMO 網站沒有開放跨網域讀取 |

### 4. GitHub Issues：特殊日期備註

| 項目 | 說明 |
|---|---|
| 網址 | `https://api.github.com/repos/AncPower/nem-predispatch-bess-advisor/issues?labels=special-date&state=open` |
| 內容 | 使用者用 issue 表單記下的日期、時間、市場與補充說明 |
| 意義 | 資料特殊的日子，例如極端天氣、機組事故、資料異常 |
| 用在哪裡 | 勾選「校準時排除此日」的日期，不納入 #3 的歷史校準 |
| 更新 | 網頁開啟時讀取，或按「重新整理備註」 |
| 限制 | 未登入時，每個網路每小時只能呼叫 60 次；2026-10-19 查詢時還沒有任何這個標籤的 issue |

### 5. 情境工具的市場預設值

| 項目 | 說明 |
|---|---|
| 網址 | 沒有記錄。程式註解只寫「依公開報導整理的示意價格型態」 |
| 內容 | 七個市場的基準電價、午間凹陷、傍晚尖峰、天然氣傳導比例、尖峰機率、價格上下限、價差標準 |
| 意義 | 示意值，不是市場數據 |
| 用在哪裡 | 情境工具開啟時的初始參數（`default_parameters`）與價格模擬 |
| 更新 | 改程式 |
| 限制 | 來源無法追溯。#11 完成後，NSW 的值會改用 `data/factor_weights.json` 的建議基準值（#12） |

## 已存進 repo 的外部資料

三個檔案都放在 `data/external/`，內容是抽出原始檔需要的部分，欄位名稱都改成小寫底線。

### 6. AEMO STTM 雪梨天然氣每日價格

| 項目 | 說明 |
|---|---|
| 網址 | 下載頁：<https://www.aemo.com.au/energy-systems/gas/short-term-trading-market-sttm/data-sttm/daily-sttm-reports> 的「STTM Price and Withdrawals」；檔案：<https://www.aemo.com.au/-/media/files/gas/sttm/data/sttm-price-and-withdrawals.xlsx>（已實測，1.6 MB） |
| 原始內容 | Excel 檔，雪梨、阿德雷德、布里斯本各一張工作表，從 2010-09-01（雪梨）起每天一列 |
| 存進 repo 的部分 | 工作表「SYD price and withdrawals」從 2024-01-01 到 2026-09-30 的資料，共 1,004 天，沒有缺值 |
| 檔案欄位 | `gas_date`、`exante_price_aud_per_gj`（事前市場價，澳幣／GJ）、`expost_price_aud_per_gj`（事後不平衡價，澳幣／GJ） |
| 意義 | STTM（短期天然氣交易市場）雪梨交易點的天然氣價格。事前價是前一天依報價算出的價格，事後價依實際用量修正 |
| 用在哪裡 | #11 的「天然氣價格」因素，取 `exante_price_aud_per_gj`，以 `gas_date` 對應同一個日曆日的套利收益 |
| 核對 | 用這份資料算出的財政年度平均：2024/25 為 13.04、2025/26 為 11.37，和 #7 AER 公布的值相同 |
| 更新 | AEMO 每月第 5 個工作日前更新這份 Excel，每月重新下載一次即可。最近 31 天也可以從 <https://nemweb.com.au/Reports/CURRENT/STTM/> 的 `int651_v1_ex_ante_market_price_rpt_1.csv`（`hub_identifier = SYD`）取得 |
| 限制 | 天然氣日的起訖和日曆日不同，這裡直接用同一個日期對應 |

### 7. AER 天然氣財政年度平均價

| 項目 | 說明 |
|---|---|
| 網址 | <https://www.aer.gov.au/industry/registers/charts/gas-market-prices>，2026-07-20 從頁面下載 |
| 內容 | 2011/12 到 2025/26 每個財政年度（7 月到隔年 6 月）一列，欄位是 Victoria、Adelaide、Brisbane、Sydney 等交易點的平均價（澳幣／GJ） |
| 意義 | AER（澳洲能源監管機構）整理的年度平均。STTM 交易點是每日事前價的簡單平均 |
| 用在哪裡 | 不放進公式。一年只有一個值，在每日迴歸裡等於常數；只用來核對 #6 |
| 原始檔 | `AER_FYTD market prices_1_20260720174752.CSV`；存進 repo 時只去掉 Windows 換行符號，內容未改 |
| 限制 | 原始檔第一欄標題寫「Month beginning」，實際內容是財政年度 |

### 8. AEMO 機組登記資料：NSW 電池

| 項目 | 說明 |
|---|---|
| 網址 | AEMO 歷史資料庫（MMSDM）2026-09 月份的兩個表（已實測）：<br>`DUDETAILSUMMARY`：<https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/2026/MMSDM_2026_09/MMSDM_Historical_Data_SQLLoader/DATA/PUBLIC_ARCHIVE%23DUDETAILSUMMARY%23FILE01%23202609010000.zip><br>`DUDETAIL`：<https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/2026/MMSDM_2026_09/MMSDM_Historical_Data_SQLLoader/DATA/PUBLIC_ARCHIVE%23DUDETAIL%23FILE01%23202609010000.zip> |
| 原始內容 | `DUDETAILSUMMARY`：每個機組在每段期間的區域、類型、電站；`DUDETAIL`：每次容量變更的記錄，最早到 1998 年 |
| 篩選 | `DUDETAILSUMMARY` 中 `REGIONID = NSW1` 且 `DISPATCHTYPE = BIDIRECTIONAL`（雙向機組，即電池）的 18 台機組；`DUDETAIL` 每個機組與生效日只留 `VERSIONNO` 最大的一筆，共 25 列 |
| 檔案欄位 | `duid`（機組代號）、`station_id`（電站）、`effective_date`（這組容量的生效日）、`registered_capacity_mw`（登記容量）、`max_capacity_mw`（最大放電功率）、`max_storage_capacity_mwh`（最大儲能量）、`region_start_date`／`region_end_date`（在 NSW1 的有效期間，`2999-12-31` 代表仍在運轉） |
| 意義 | NSW 已併網電池的放電功率與儲能量。電池越多，尖峰時段越多電池搶著放電，套利價差越容易被壓縮 |

**用在公式上（#11）：**

1. 每月月底的裝置量：
   - 放電功率（MW）= 所有符合條件機組的 `max_capacity_mw` 加總
   - 儲能量（MWh）= 所有符合條件機組的 `max_storage_capacity_mwh` 加總
   - 符合條件：`region_start_date` ≤ 月底 < `region_end_date`；同一機組有多列時，取 `effective_date` ≤ 月底的最後一列
2. 當月每天都用這個月底值，作為「電池裝置量」因素的原始值。
3. 和其他因素一樣先標準化、調整正負方向，再交給 HiGHS 求權重。

依上述方式算出的部分月底值：

| 月底 | 機組數 | 放電功率（MW） | 儲能量（MWh） |
|---|---|---|---|
| 2024-07-31 | 3 | 140 | 230 |
| 2024-12-31 | 8 | 1,210 | 2,327 |
| 2025-06-30 | 9 | 1,670 | 3,400 |
| 2025-12-31 | 13 | 2,700 | 7,509.2 |
| 2026-06-30 | 17 | 3,169 | 8,676.2 |
| 2026-09-30 | 18 | 3,409 | 10,066.2 |

**限制：**

- 篩選結果最早的生效日是 2024-07-04（`BHB1`）。在這之前，電池拆成「發電機 ＋ 負載」兩個機組登記（例如 `BHBG1` 與 `BHBL1`），不會被 `BIDIRECTIONAL` 篩到。所以 2024-01 到 2024-06 沒有數據。
- 這半年先不採計於公式計算（2026-10-19 決定）：「電池裝置量」因素只用 2024-07 起的資料，不補值，也不用 0 代替。
- 更新：每月下載最新月份的這兩個表，重新篩選即可，因為裡面已有完整歷史。

## 離線分析使用的本機資料

### 9. AEMO 電價與區域資料

| 項目 | 說明 |
|---|---|
| 位置 | `nsw-dispatch-bess-strategy` repo 的 `input/{期間}/`，由環境變數 `NSW_DISPATCH_INPUT_DIRECTORY` 指定；資料不進本 repo |
| 涵蓋期間 | 2023-12-01 到 2026-08-31；三個期間資料夾互相重疊，同一時段以時間戳記去除重複 |
| `trading_price.csv` | AEMO MMS `TRADING PRICE` 表：每 5 分鐘一筆區域結算電價 `RRP`（AUD/MWh）。只取 `REGIONID = NSW1` |
| `p5min_region_solution.csv` | AEMO MMS `P5MIN REGIONSOLUTION` 表：每 5 分鐘求解一次、每次預測 12 個時段。只取每次求解的第一個時段（`RUN_DATETIME = INTERVAL_DATETIME`），它最接近實際調度；排除介入（`INTERVENTION ≠ 0`） |
| 一天的定義 | NEM 時間 00:00 到 24:00，以時段開始時間判斷（AEMO 時間戳記是時段結束，先減 5 分鐘）；不足 288 個時段的日子不用 |

**用在公式上：**

| 用途 | 算法 | 程式 |
|---|---|---|
| 每日套利收益（被解釋變數） | 每 6 個 5 分鐘電價平均成一個 30 分鐘電價，以 5 MW／20 MWh、MLF 1 跑 `select_best_plan`（與主頁同一套規則），取最佳計畫的總收益 | `analysis/arbitrage_revenue.py` |
| 日均需求 | 當天 `TOTALDEMAND` 平均（MW） | `analysis/daily_factors.py` |
| 晚間尖峰需求 | 17:00–21:00 的 `TOTALDEMAND` 最大值（MW） | 同上 |
| 供給餘裕 | 當天 `AVAILABLEGENERATION − TOTALDEMAND` 的最小值（MW），代表當天最吃緊的時刻 | 同上 |
| 淨進出口 | 當天 `NETINTERCHANGE` 平均（MW）；正值為 NSW 輸出到其他區域 ⚠️ 正負號定義依 AEMO MMS 文件，尚未查證 | 同上 |

## #11 規劃中的來源

之後逐一加入，每個來源一個 PR。

| # | 來源 | 網址或 API | 內容 | 預計用法 |
|---|---|---|---|---|
| 10 | Open-Meteo 歷史天氣 | `https://archive-api.open-meteo.com/v1/archive?latitude=-33.87&longitude=151.21&daily=temperature_2m_mean,temperature_2m_max&timezone=Australia%2FSydney`（已實測） | 雪梨每日平均與最高氣溫 | 氣溫偏離同月常態的度數 |
| 11 | AEMO 機組發電量 | MMSDM 每月的 `DISPATCH_UNIT_SCADA` 表（目錄同 #8，2024-01 約 22.6 MB） | 每台機組每 5 分鐘的實際出力（MW） | NSW 太陽能、風力的日發電量。⚠️ 要靠另一個表判斷燃料類型，還沒確認用哪個 |
| 12 | AEMO 屋頂型太陽能 | MMSDM 每月的 `ROOFTOP_PV_ACTUAL` 表；最近幾天在 <https://nemweb.com.au/Reports/Current/ROOFTOP_PV/ACTUAL/> | 每區域每 30 分鐘的屋頂型太陽能估計出力（MW） | NSW 屋頂型太陽能的日發電量。⚠️ `TYPE` 欄分 `MEASUREMENT` 與 `SATELLITE` 兩種估法，只能選一種 |

MMSDM 的檔名格式改過：2024-01 是 `PUBLIC_DVD_{表名}_{YYYYMM}010000.zip`，2026-08 起是 `PUBLIC_ARCHIVE#{表名}#FILE01#{YYYYMM}010000.zip`。程式要先讀目錄列表、用表名比對檔名，下載時 `#` 寫成 `%23`。

## 分析輸出：`data/factor_weights.json`

由 `analysis/build_factor_weights.py` 產生，進 git、隨 GitHub Pages 部署，給情境頁讀取（#12）。

| 欄位 | 意義 |
|---|---|
| `generated_at` | 產生時間（UTC，ISO 8601） |
| `data_period` | 擬合用的期間與天數：所有因素與收益都有值的日子 |
| `battery_spec` | 算收益用的電池規格 |
| `revenue` | 收益取 log(1 + AUD) 後的平均數與標準差、收益中位數（AUD），以及把預測值換算回 AUD 的公式 |
| `intercept` | L1 迴歸的截距（z 分數尺度） |
| `fit_quality` | R² 與平均絕對誤差（log 尺度 z 分數、換算回 AUD 兩種） |
| `factors[]` | 每個因素的 `factor_name`（程式名稱）、`label`（中文名稱）、`unit`（單位）、`source`（資料來源）、`weight`（非負、取到小數第 6 位後加總剛好為 1）、`direction`（1 代表因素越高收益越高）、`spearman_correlation`、擬合期間的 `mean` 與 `standard_deviation`、`monthly_baseline`（1–12 月的中位數，用各因素自己的全部資料） |

限制：`battery_power_mw` 的 `monthly_baseline` 把逐年成長的裝置量按月份合併取中位數（例如 7 月混合 2024 年的 140 MW 與 2025 年的 1,670 MW），不適合直接當作預測期間的基準值；#12 使用前要決定改用最新值或其他做法。

收益取 log 的原因：2024-07 到 2026-08 的每日收益中位數約 2,650 AUD、最高 228,011 AUD，不轉換時少數尖峰日主導擬合，R² 只有 -0.03；取 log 後為 0.48（2026-10-19 決定）。
