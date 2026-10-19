# nem-predispatch-bess-advisor

讀 AEMO 最新的 30 分鐘預調度電價，找出接下來最划算的儲能充放電時段，算出預估收益。整頁是靜態網頁，資料在瀏覽器裡直接向 AEMO 取，不需要伺服器。

網址：<https://ancpower.github.io/nem-predispatch-bess-advisor/>（repo 公開並開啟 GitHub Pages 後生效）

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

## 本機執行

頁面用 ES module 載入 `src/`，要經過 HTTP 才開得起來，直接開 `index.html` 檔案不行：

```bash
uv run --no-project python -m http.server 8000
```

然後開 <http://127.0.0.1:8000>。

## 測試

需要 Node 22 以上，沒有 npm 依賴：

```bash
node --test "tests/*.test.js"
```

CI 在每個 PR 跑同一個指令（`.github/workflows/ci.yml`）。

## 檔案結構

各模組的職責與依賴在 [`docs/module_map.md`](docs/module_map.md)。

## 發佈

GitHub Pages 從 `main` 分支根目錄發佈，合併即上線。AncPower 是 GitHub 免費方案，Pages 只能開在公開 repo。

## 不做

- 5 分鐘預調度（P5MIN）：只在 NEMWeb，網頁讀不到；等確定要在盤中使用再評估。
- 實際結算價、FCAS 輔助服務價格。
