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
| 6 | AEMO STTM 雪梨天然氣每日價格 | #11 使用中 | `data/external/sttm_sydney_daily_price.csv`、`analysis/external_factors.py` |
| 7 | AER 天然氣財政年度平均價 | 已存進 repo，只用來核對 #6 | `data/external/aer_gas_market_prices_financial_year.csv` |
| 8 | AEMO 機組登記資料（NSW 電池） | #11 使用中 | `data/external/nsw_battery_units.csv`、`analysis/external_factors.py` |
| 9 | AEMO 電價與區域資料（`nsw-dispatch-bess-strategy` 的 `input/`） | #11 使用中 | 另一個 repo 的本機資料，路徑由 `NEM_INPUT_DIRECTORY` 設定；`analysis/daily_revenue.py`、`analysis/region_factors.py` |
| 10 | Open-Meteo 歷史天氣 API | #11 規劃中 | — |
| 11 | AEMO 機組發電量 `DISPATCH_UNIT_SCADA` | #11 規劃中 | — |
| 12 | AEMO 屋頂型太陽能 `ROOFTOP_PV_ACTUAL` | #11 規劃中 | — |

特殊事件（#14）還沒有資料，補上後加進本表。#6、#8、#9 算出的權重寫在 `data/factor_weights.json`，格式見文末〈輸出：`data/factor_weights.json`〉。

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
| 用在哪裡 | #11 的 `gas_price_aud_per_gj` 因素：取 `exante_price_aud_per_gj`，以 `gas_date` 對應同一個交易日的套利收益。程式是 `analysis/external_factors.py` 的 `parse_gas_prices` |
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
3. 月底沒有任何符合條件的機組時視為缺資料，那個月的日子不進擬合期間。
4. 和其他因素一樣先標準化、調整正負方向，再交給 HiGHS 求權重（因素名稱 `battery_power_mw`）。

程式是 `analysis/external_factors.py` 的 `battery_power_at` 與 `daily_battery_power`；下表的放電功率由 `analysis/tests/test_external_factors.py` 對 repo 內的 CSV 驗證。

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

## 本機的 AEMO 原始資料

### 9. AEMO 電價與區域資料

原始檔約 1.9 GB，不放進 repo。

| 項目 | 說明 |
|---|---|
| 位置 | 環境變數 `NEM_INPUT_DIRECTORY` 指到的目錄，目前是 `nsw-dispatch-bess-strategy/input/`（連結到 `nem-forecast-reliability/input/`）。底下每個期間資料夾一組檔案：`2024-01_2024-12`、`2025-01_2025-12`、`2026-01_2026-08` |
| 原始出處 | AEMO MMS 資料模型的 `TRADING.PRICE` 與 `P5MIN.REGIONSOLUTION` 兩張表，由 `nem-forecast-reliability` 的匯入程式下載。⚠️ 下載網址記在那個 repo，本檔沒有第一手核對 |
| 格式 | MMS CSV：`I` 列是欄名，`D` 列是資料。同一個檔會中途換版本，欄位順序也跟著變（例如 2024 檔第 70,281 行從 TRADING.PRICE v2 換成 v3），所以程式一律依欄名讀（`analysis/mms_csv.py`） |
| 涵蓋期間 | 每個資料夾前後各多一個月，例如 2024 資料夾是 2023-12-01 到 2025-02-01 00:00。相鄰資料夾重疊的 35,712 個 5 分鐘電價完全相同；程式依時間戳記去重，值不同就停止 |
| 時間 | NEM 時間（AEST，UTC+10，不調夏令時間），時間戳記是時段結束時間。交易日 D 是時段開始時間落在 D 00:00 到 D+1 00:00 之間的時段 |
| 更新 | 由 `nem-forecast-reliability` 匯入新期間後，重跑 `NEM_INPUT_DIRECTORY=<原始資料目錄> uv run python -m analysis.build_factor_weights` |

#### `trading_price.csv`：每日套利收益（被解釋變數）

| 項目 | 說明 |
|---|---|
| 內容 | NSW1 每 **5 分鐘**一筆的 `RRP`（區域參考價，AUD/MWh），`PERIODID` 為 1–288。2026-10-19 更正：本檔與 #11 原本寫成 30 分鐘 |
| 篩選 | `REGIONID = NSW1`。實測每一列都是 `PRICE_STATUS = FIRM`、`INVALIDFLAG = 0` |
| 公式 | 1. 30 分鐘電價 = 結束於 T−25 到 T 分鐘的 6 筆 RRP 平均，和主頁讀的 30 分鐘預調度電價同一個時間單位<br>2. 每天 48 段各自跑 `select_best_plan`（5 MW／20 MWh、MLF 1），從空電池開始，不跨午夜；當天收益 = 最佳計畫的總收益<br>3. 不足 48 段的日子不算收益 |
| 程式 | `analysis/daily_revenue.py`。`select_best_plan` 的 Python 版在 `analysis/arbitrage_plan.py`，和 JS 版用 `tests/fixtures/select_best_plan_cases.json` 驗證結果相同 |
| 實測 | 2023-12-01 到 2026-08-31 共 1,005 天，每天都有完整 288 筆。每日收益中位數 2,651 AUD，最高 378,665 AUD（2024-05-08，在擬合期間之前） |

#### `p5min_region_solution.csv`：四個區域因素

| 項目 | 說明 |
|---|---|
| 內容 | 每 5 分鐘求解一次，每次預測 12 個時段。用到三欄，單位都是 MW：`TOTALDEMAND`（區域總需求）、`AVAILABLEGENERATION`（可用發電量）、`NETINTERCHANGE`（跨區淨送電） |
| 篩選 | `REGIONID = NSW1`；每次求解只取第一個時段（`INTERVAL_DATETIME = RUN_DATETIME`），代表當下狀態。舊版 v7 有 `INTERVENTION` 欄，只留 0，實測全為 0 |
| 正負號 | `NETINTERCHANGE` 正值是 NSW 淨送出，負值是淨輸入。依據：三個期間檔的第一時段列都符合 `TOTALDEMAND ≈ DISPATCHABLEGENERATION − DISPATCHABLELOAD − NETINTERCHANGE`，平均絕對誤差 0.04–0.08 MW，個別列最大約 98 MW。⚠️ AEMO MMS 資料模型的欄位說明原文還沒查到 |
| 公式 | `demand_mean_mw`：當天 288 個 `TOTALDEMAND` 的平均<br>`evening_peak_demand_mw`：時段開始於 17:00–21:00（結束於 17:05–21:00，共 48 個）的 `TOTALDEMAND` 最大值<br>`supply_margin_min_mw`：當天 `AVAILABLEGENERATION − TOTALDEMAND` 的最小值<br>`net_interchange_mean_mw`：當天 `NETINTERCHANGE` 的平均 |
| 缺漏 | 求解不到 288 次的日子整天排除，不補值：2023-12-05（286 次）、2024-09-05（276 次）、2024-11-19（284 次）、2025-03-04（287 次），和各資料夾的 `ingest_anomaly_report.txt` 一致 |
| 程式 | `analysis/region_factors.py` |
| 讀取時間 | 逐行串流讀取，整條流程在本機約 40 秒 |

## #11 規劃中的來源

加入公式時再補上欄位與公式細節。

| # | 來源 | 網址或 API | 內容 | 預計用法 |
|---|---|---|---|---|
| 10 | Open-Meteo 歷史天氣 | `https://archive-api.open-meteo.com/v1/archive?latitude=-33.87&longitude=151.21&daily=temperature_2m_mean,temperature_2m_max&timezone=Australia%2FSydney`（已實測） | 雪梨每日平均與最高氣溫 | 氣溫偏離同月常態的度數 |
| 11 | AEMO 機組發電量 | MMSDM 每月的 `DISPATCH_UNIT_SCADA` 表（目錄同 #8，2024-01 約 22.6 MB） | 每台機組每 5 分鐘的實際出力（MW） | NSW 太陽能、風力的日發電量。⚠️ 要靠另一個表判斷燃料類型，還沒確認用哪個 |
| 12 | AEMO 屋頂型太陽能 | MMSDM 每月的 `ROOFTOP_PV_ACTUAL` 表；最近幾天在 <https://nemweb.com.au/Reports/Current/ROOFTOP_PV/ACTUAL/> | 每區域每 30 分鐘的屋頂型太陽能估計出力（MW） | NSW 屋頂型太陽能的日發電量。⚠️ `TYPE` 欄分 `MEASUREMENT` 與 `SATELLITE` 兩種估法，只能選一種 |

MMSDM 的檔名格式改過：2024-01 是 `PUBLIC_DVD_{表名}_{YYYYMM}010000.zip`，2026-08 起是 `PUBLIC_ARCHIVE#{表名}#FILE01#{YYYYMM}010000.zip`。程式要先讀目錄列表、用表名比對檔名，下載時 `#` 寫成 `%23`。

## 輸出：`data/factor_weights.json`

由 `NEM_INPUT_DIRECTORY=<原始資料目錄> uv run python -m analysis.build_factor_weights` 在 repo 根目錄產生，進 git，隨 GitHub Pages 部署，給 scenario 頁（#12）讀。實際的權重與擬合品質只記在 JSON，本節不重複。

### 模型

| 步驟 | 內容 |
|---|---|
| 1. 目標 | y = log(1 + 每日收益)，再轉 z 分數。每日收益是長尾分布，取 log 才不會被少數尖峰日主導（2026-10-19 決定，見 #11） |
| 2. 因素 | #6、#8、#9 的六個因素各自轉 z 分數（母體標準差） |
| 3. 方向 | `direction` = 因素與 y 的 Pearson 相關係數的正負號；相關係數為 0 時取 +1 |
| 4. 求解 | HiGHS（`highspy`）解最小絕對誤差（L1）的線性規劃：min Σ\|e_d\|，限制 c + Σ v_k × direction_k × z_kd + e_d = y 的 z 分數，v_k ≥ 0，截距 c 不設限 |
| 5. 權重 | `weight` = v_k ÷ Σv，非負、加總為 1；`model.scale` = Σv；Σv = 0 時程式直接停止 |
| 6. 擬合品質 | R² 與 MAE 在 log 尺度算；`mean_absolute_error_aud` 是預測換回 AUD 後的 MAE |
| 擬合期間 | 六個因素都有值的日子，目前是 2024-07-01 到 2026-08-31。期間內缺資料的日子列在 `period.excluded_days` 並寫明原因 |

由 JSON 算預測值：

```text
log(1 + 收益) = target.mean + target.standard_deviation
                × (model.intercept + model.scale × Σ weight × direction × (因素值 − mean) ÷ standard_deviation)
```

### 欄位

| 欄位 | 內容 |
|---|---|
| `schema_version` | 格式版本，目前是 1 |
| `generated_at` | 產生時間，ISO 8601 UTC（`Z` 結尾） |
| `period` | `start_date`、`end_date`、`day_count`（擬合用的天數）、`excluded_days`（期間內被排除的日子與原因） |
| `battery_specification` | 算收益用的電池：5 MW／20 MWh、MLF 1 |
| `target` | `name`、`transform`（`log1p`）、log 收益的 `mean` 與 `standard_deviation`、收益中位數 `median_aud` |
| `model` | `objective`、`solver`、`solver_version`、`intercept`、`scale`、`prediction_formula` |
| `factors[]` | 每個因素一筆：`factor_name`、`unit`、`description`、`weight`、`direction`、`correlation`、原始值的 `mean` 與 `standard_deviation`、`monthly_baseline`、`latest_value` |
| `factors[].monthly_baseline` | 擬合期間內每個日曆月份（`"01"`–`"12"`，跨年合併）每日原始值的中位數 |
| `factors[].latest_value` | `year_month` 與 `value`：擬合期間最後一個年月（目前 2026-08）每日原始值的中位數；電池當月每天相同，等於那個月的月底值 |
| `pending_factors[]` | 還沒放進公式的因素，`weight` 為 0：特殊事件（#14）、氣溫、太陽能與風力、屋頂型太陽能 |
| `fit_quality` | `r_squared`、`mean_absolute_error_log`、`mean_absolute_error_aud` |
| `input_fingerprint` | 見下方〈輸入指紋與 CI 檢查〉 |

### 2026-10-19 的決定

| 決定 | 理由 |
|---|---|
| 除了權重，再輸出 `model.scale` 與 `model.intercept` | 權重加總為 1 的加權平均，標準差小於 1，直接當預測值會被壓扁；有了 scale 與截距，#12 才能把因素偏離基準的程度換算成收益變化 |
| 每個因素加上 `latest_value` | 天然氣價與電池裝置量隨時間單調變化，跨年的月份中位數不適合當它們的基準，例如電池 7 月的中位數混了 2024、2025、2026 三年的裝置量 |

### 輸入指紋與 CI 檢查

`input_fingerprint` 記錄 JSON 是由哪些輸入算出來的：

- `code_files`：`analysis/` 第一層每個 `.py`（不含 `analysis/tests/`）的 sha256
- `external_files`：實際讀到的兩個 `data/external/` 檔（#6、#8）的 sha256
- `combined_sha256`：把上面兩組排序後再算一次 sha256
- `raw_input_files`：#9 六個原始檔的相對路徑、大小與 sha256。CI 沒有原始資料，這部分只記錄、不驗證

CI 的 `analysis` job 會跑 `analysis/tests/test_factor_weights_freshness.py`：重算 `combined_sha256`，和 JSON 不同就失敗，訊息列出改動的檔案與重跑指令。改了分析程式或 `data/external/` 之後，要在本機重跑並把 JSON 一起 commit。

`uv.lock` 不在指紋內，所以依賴升版（例如 `highspy`）改變解的時候，CI 不會發現。
