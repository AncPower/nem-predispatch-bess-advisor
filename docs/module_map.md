# 模組地圖

每個模組的層級、職責與依賴。匯入只能由高層流向低層，不得循環。新增、改名或刪除模組時，同一個 commit 更新本檔與 `tests/module_layers.test.js` 的層級表。

| 模組 | 層級 | 職責 | 對外介面 | 依賴 |
|---|---|---|---|---|
| `src/nem_time.js` | L0 基礎 | NEM 時間字串解析與格式化 | `INTERVAL_MINUTES`, `INTERVAL_HOURS`, `parse_nem_timestamp`, `format_nem_label`, `interval_start_minute` | — |
| `src/csv_line.js` | L0 基礎 | CSV 單列拆欄 | `split_csv_line` | — |
| `src/http_request.js` | L0 基礎 | JSON API 請求：逾時、暫時性錯誤退避重試、HTTP 狀態錯誤 | `TransientFetchError`, `HttpStatusError`, `fetch_json_with_retry` | — |
| `src/number_format.js` | L0 基礎 | 數字與金額顯示格式 | `format_number`, `format_money` | — |
| `src/day_shape.js` | L0 基礎 | 鐘形權重與連續 N 小時窗摘要 | `bell_weight`, `summarize_day_windows` | — |
| `src/scenario_presets.js` | L0 基礎 | 情境工具的市場預設、新聞事件、欄位定義 | `BATTERY_DURATION_HOURS`, `MARKET_PRESETS`, `NEWS_ADJUSTMENTS`, `default_parameters`, `build_field_definitions`, `clamp_to_field_limits` | — |
| `src/window_selection.js` | L1 純計算 | 預調度選窗：一起選最多兩個循環，支援每循環最低價差；由計畫推出建議價格 | `segment_length_for`, `select_best_plan`, `suggest_price_thresholds` | `nem_time` |
| `src/threshold_dispatch.js` | L1 純計算 | 自訂價格門檻的逐時段模擬 | `simulate_threshold_dispatch` | `nem_time` |
| `src/price_simulation.js` | L1 純計算 | 情境工具的每日電價多路徑模擬 | `DEFAULT_PATH_COUNT`, `DEFAULT_RANDOM_SEED`, `create_seeded_random`, `simulate_price_paths`, `summarize_hourly_percentiles` | `day_shape`, `scenario_presets` |
| `src/spread_strategy.js` | L1 純計算 | 價差標準策略評估、掃描、建議標準、判斷燈號 | `evaluate_spread_strategy`, `summarize_first_day`, `sweep_spread_standards`, `choose_best_standard`, `decide_verdict` | `scenario_presets` |
| `src/history_calibration.js` | L1 純計算 | 歷史電價解析與日型態校準 | `parse_history_csv`, `select_calibration_region`, `calibrate_from_history`, `fit_day_shape` | `csv_line`, `day_shape`, `scenario_presets` |
| `src/dashboard_source.js` | L2 資料來源 | 呼叫 AEMO 儀表板 API 並驗證回應 | `DASHBOARD_REPORT_URL`, `fetch_dashboard_report`, `parse_dashboard_report` | `http_request`, `nem_time` |
| `src/upload_parser.js` | L2 資料來源 | 解析手動上傳的 NEMWeb 預調度 CSV | `parse_predispatch_csv` | `csv_line`, `nem_time` |
| `src/special_date_notes.js` | L2 資料來源 | 以 GitHub Issues 讀取特殊日期備註、產生新增備註網址 | `NOTES_REPOSITORY`, `NOTE_LABEL`, `NOTE_TEMPLATE_FILE`, `NOTE_FIELD_HEADINGS`, `fetch_special_date_notes`, `parse_note_issue`, `parse_issue_form_body`, `build_new_note_url`, `collect_excluded_dates` | `http_request` |
| `src/page_render.js` | L3 顯示 | 預調度工具：計畫卡片、KPI、兩張圖（Chart.js） | `format_aud`, `render_plan_steps`, `render_kpi_row`, `draw_price_chart`, `draw_sweep_chart` | `nem_time`, `number_format` |
| `src/scenario_render.js` | L3 顯示 | 情境工具：欄位、燈號、KPI、兩張圖、校準統計、備註表 | `build_field_html`, `render_verdict`, `render_kpis`, `draw_hourly_chart`, `draw_standard_chart`, `render_calibration_stats`, `render_notes_table` | `number_format`, `scenario_presets` |
| `src/app.js` | L4 進入點 | 預調度工具（`index.html`）：讀資料、收集輸入、呼叫計算與顯示、自動更新 | — | `dashboard_source`, `nem_time`, `page_render`, `threshold_dispatch`, `upload_parser`, `window_selection` |
| `src/scenario_app.js` | L4 進入點 | 情境工具（`scenario/index.html`）：模擬、校準、讀備註 | — | `history_calibration`, `price_simulation`, `scenario_presets`, `scenario_render`, `special_date_notes`, `spread_strategy` |

外部函式庫由兩個 HTML 從 cdnjs 以全域變數載入：JSZip 3.10.1（預調度工具解壓上傳的 zip）、Chart.js 4.4.1（兩個工具畫圖）。
