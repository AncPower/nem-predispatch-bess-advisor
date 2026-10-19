# nem-predispatch-bess-advisor

兩個儲能決策用的靜態網頁，資料在瀏覽器裡直接取得，不需要伺服器。

| 工具 | 網址 | 用途 |
|---|---|---|
| AEMO 預調度充放電建議 | <https://ancpower.github.io/nem-predispatch-bess-advisor/> | 讀最新的 30 分鐘預調度電價，找出接下來最划算的充放電時段與預估收益 |
| 儲能情境因子與歷史校準 | <https://ancpower.github.io/nem-predispatch-bess-advisor/scenario/> | 用歷史電價校準價格型態，加上天氣、相關市場與新聞事件，評估四小時價差標準 |

兩者頁首互相連結。以下「資料來源」與「計算」兩節講預調度工具，情境工具在後面獨立一節。

## 資料來源

| 方式 | 端點 | 何時用 |
|---|---|---|
| 自動讀取 | `POST https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN`，內容 `{"timeScale":["30MIN"]}`，取 `PERIODTYPE = FORECAST` 的列 | 預設。開頁就讀，之後每 5 分鐘一次 |
| 手動上傳 | [NEMWeb PredispatchIS_Reports](https://nemweb.com.au/Reports/Current/PredispatchIS_Reports/) 的 `PUBLIC_PREDISPATCHIS_*.zip` 或解壓後的 CSV | 自動讀取失敗時。上傳後自動更新會暫停 |

自動讀取用的是 AEMO 官網 NEM 資料儀表板背後的 API。它回 `Access-Control-Allow-Origin: *`，網頁可以直接呼叫；NEMWeb 沒有這個標頭，瀏覽器會擋，所以只能手動上傳。這支 API 沒有公開文件，AEMO 改格式時頁面會指出哪一列哪個欄位不符。回應裡也沒有預調度的執行時間。

兩種來源 2026-10-19 實測過：NSW1 都是 67 個 30 分鐘時段，預測到下一個市場日 04:00（NEM 時間）。

## 計算

- 每段長度＝容量 ÷ 功率，連續、滿功率。
- 一個循環是充、放兩段；兩個循環是充、放、充、放四段一起選，取放電段總價減充電段總價最大的組合。每個循環的價差（放電段均價 − 充電段均價）必須為正，且不低於「每循環最低價差」（預設 0）。同分取最早；一個與兩個循環同分取一個；沒有組合符合就不排。
- 來回效率固定 100%，不計損耗。損失係數（MLF）只縮放收益。
- 搜尋範圍是整個預測期間，可以跨過午夜。建議計畫一律從空電池開始；「目前電量」只用在自訂價格的試算。

## 情境工具

### 資料來源

| 資料 | 來源 | 何時讀 |
|---|---|---|
| 市場預設值 | 程式內的示意價格型態（`src/scenario_presets.js`），不是即時數據 | 開頁 |
| 歷史電價 | 手動上傳 CSV，例如 AEMO 的 `PRICE_AND_DEMAND_YYYYMM_NSW1.csv`；AEMO 網站沒有開放跨網域讀取，網頁無法直接下載 | 上傳時 |
| 特殊日期備註 | 本 repo 標籤為 `special-date`、未關閉的 GitHub issue，以 GitHub REST API 讀取 | 開頁與按「重新整理備註」時 |

備註用 issue 表單 [`.github/ISSUE_TEMPLATE/special_date.yml`](.github/ISSUE_TEMPLATE/special_date.yml) 新增，頁面上的按鈕會帶入日期、時間、市場與補充資訊。勾選「校準時排除此日」的日期不納入歷史校準；關閉 issue 就等於撤回。GitHub API 未登入時每個網路每小時 60 次，所以頁面不自動輪詢。issue 內文任何人都能寫，頁面只當純文字顯示。

### 計算

- 每日電價＝基準價 × 日型態（清晨小峰、午間再生能源凹陷、傍晚尖峰）＋雜訊，偶發尖峰落在 18 至 21 時。模擬 400 條路徑，亂數種子固定。
- 電池為空時在當日最低的連續四小時充電；之後最高的連續四小時與充電價的價差達標就放電，否則持有，等滿最長天數就強制放電。
- 四小時電池，預設 5 MW／20 MWh；來回效率固定 100%，不計損耗。
- 歷史校準以最小平方法擬合日型態的四個係數，再算尖峰日比例、天氣波動度與四小時價差中位數。檔案含多個區域時用 NSW1。

## 本機執行

頁面用 ES module 載入 `src/`，要經過 HTTP 才開得起來，直接開 HTML 檔案不行：

```bash
uv run --no-project python -m http.server 8000
```

然後開 <http://127.0.0.1:8000>（預調度工具）或 <http://127.0.0.1:8000/scenario/>（情境工具）。

## 測試

需要 Node 22 以上，沒有 npm 依賴：

```bash
node --test "tests/*.test.js"
```

離線分析層（`analysis/`，Python）用 uv 管理，測試用 pytest：

```bash
uv sync
uv run pytest
```

CI 在每個 PR 跑這兩組測試（`.github/workflows/ci.yml` 的 `test` 與 `analysis` 兩個 job）。

## 檔案結構

各模組的職責與依賴在 [`docs/module_map.md`](docs/module_map.md)。`analysis/` 是 #11 的離線分析層：目前有 MMS CSV 解析、`select_best_plan` 的 Python 版，以及由 5 分鐘電價算每日套利收益；因素與權重求解之後加入。所有資料來源的網址、內容、意義與用在哪條公式在 [`docs/data_sources.md`](docs/data_sources.md)；外部資料的存檔放在 `data/external/`。

## 發佈

GitHub Pages 從 `main` 分支根目錄發佈，合併即上線。AncPower 是 GitHub 免費方案，Pages 只能開在公開 repo。

## 不做

- 5 分鐘預調度（P5MIN）：只在 NEMWeb，網頁讀不到；等確定要在盤中使用再評估。
- 實際結算價、FCAS 輔助服務價格。
- 情境工具的天氣與相關市場換算係數仍是初始假設，沒有用實際資料校準。
