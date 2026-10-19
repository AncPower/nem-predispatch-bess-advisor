# 模組地圖

每個模組的層級、職責與依賴。匯入只能由高層流向低層，不得循環。新增、改名或刪除模組時，同一個 commit 更新本檔與 `tests/module_layers.test.js` 的層級表。

| 模組 | 層級 | 職責 | 對外介面 | 依賴 |
|---|---|---|---|---|
| `src/nem_time.js` | L0 基礎 | NEM 時間字串解析與格式化 | `INTERVAL_MINUTES`, `INTERVAL_HOURS`, `parse_nem_timestamp`, `format_nem_label`, `interval_start_minute` | — |
| `src/window_selection.js` | L1 純計算 | 一起選最多兩個循環的充放電窗；由計畫推出建議價格 | `segment_length_for`, `select_best_plan`, `suggest_price_thresholds` | `nem_time` |
| `src/threshold_dispatch.js` | L1 純計算 | 自訂價格門檻的逐時段模擬 | `simulate_threshold_dispatch` | `nem_time` |
| `src/dashboard_source.js` | L2 資料來源 | 呼叫 AEMO 儀表板 API（逾時、重試）並驗證回應 | `DASHBOARD_REPORT_URL`, `TransientFetchError`, `fetch_dashboard_report`, `parse_dashboard_report` | `nem_time` |
| `src/upload_parser.js` | L2 資料來源 | 解析手動上傳的 NEMWeb 預調度 CSV | `parse_predispatch_csv` | `nem_time` |
| `src/page_render.js` | L3 顯示 | 計畫卡片、KPI、兩張圖（Chart.js） | `format_number`, `format_aud`, `render_plan_steps`, `render_kpi_row`, `draw_price_chart`, `draw_sweep_chart` | `nem_time` |
| `src/app.js` | L4 進入點 | 讀資料、收集輸入、呼叫計算與顯示、自動更新 | — | 以上全部 |

外部函式庫由 `index.html` 從 cdnjs 以全域變數載入：JSZip 3.10.1（解壓上傳的 zip）、Chart.js 4.4.1（畫圖）。
