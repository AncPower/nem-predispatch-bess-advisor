# 模組地圖

每個模組的層級、職責與依賴。匯入只能由高層流向低層，不得循環。新增、改名或刪除模組時，同一個 commit 更新本檔與 `tests/module_layers.test.js` 的層級表。

| 模組 | 層級 | 職責 | 對外介面 | 依賴 |
|---|---|---|---|---|
| `src/nem_time.js` | L0 基礎 | NEM 時間字串解析與格式化 | `INTERVAL_MINUTES`, `INTERVAL_HOURS`, `parse_nem_timestamp`, `format_nem_label`, `interval_start_minute` | — |
| `src/csv_line.js` | L0 基礎 | CSV 單列拆欄 | `split_csv_line` | — |
| `src/http_request.js` | L0 基礎 | JSON API 與靜態文字檔請求：逾時、暫時性錯誤退避重試、HTTP 狀態錯誤 | `TransientFetchError`, `HttpStatusError`, `fetch_json_with_retry`, `fetch_text_with_retry` | — |
| `src/number_format.js` | L0 基礎 | 數字與金額顯示格式 | `format_number`, `format_money` | — |
| `src/day_shape.js` | L0 基礎 | 鐘形權重與連續 N 小時窗摘要 | `bell_weight`, `summarize_day_windows` | — |
| `src/scenario_presets.js` | L0 基礎 | 情境工具的市場預設、新聞事件、欄位定義 | `BATTERY_DURATION_HOURS`, `MARKET_PRESETS`, `NEWS_ADJUSTMENTS`, `default_parameters`, `build_field_definitions`, `clamp_to_field_limits` | — |
| `src/window_selection.js` | L1 純計算 | 預調度選窗：一起選最多兩個循環，支援每循環最低價差；由計畫推出建議價格 | `segment_length_for`, `select_best_plan`, `suggest_price_thresholds` | `nem_time` |
| `src/threshold_dispatch.js` | L1 純計算 | 自訂價格門檻的逐時段模擬 | `simulate_threshold_dispatch` | `nem_time` |
| `src/price_simulation.js` | L1 純計算 | 情境工具的每日電價多路徑模擬 | `DEFAULT_PATH_COUNT`, `DEFAULT_RANDOM_SEED`, `create_seeded_random`, `simulate_price_paths`, `summarize_hourly_percentiles` | `day_shape`, `scenario_presets` |
| `src/spread_strategy.js` | L1 純計算 | 價差標準策略評估、掃描、建議標準、判斷燈號 | `evaluate_spread_strategy`, `summarize_first_day`, `sweep_spread_standards`, `choose_best_standard`, `decide_verdict` | `scenario_presets` |
| `src/history_calibration.js` | L1 純計算 | 歷史電價解析與日型態校準 | `parse_history_csv`, `select_calibration_region`, `calibrate_from_history`, `fit_day_shape` | `csv_line`, `day_shape`, `scenario_presets` |
| `src/event_days.js` | L1 純計算 | 特殊事件的類別與影響方向代碼表、把事件展開成日期、每日收益圖的事件標注、含事件日／排除事件日／只看事件日三種檢視篩選（#31，供 #32、#33 使用） | `EVENT_CATEGORY_LABELS`, `IMPACT_DIRECTION_LABELS`, `EVENT_VIEWS`, `list_event_dates`, `collect_event_dates`, `collect_excluded_dates`, `filter_days_by_event_view`, `group_events_by_date`, `annotate_days_with_events` | — |
| `src/spread_review.js` | L1 純計算 | 價差標準檢討（#32、roadmap L2）：對每日摘要的既有計畫逐日套用候選標準（每 1 AUD/MWh，上限為最高每日價差向上取整與目前標準的較大值），算執行天數、淨收益、錯過的機會與歷史收益保留率；保留 99% 的範圍、維持或建議下調；樣本與季節提示；各循環損益兩平價差摘要（只作說明）；解析試算輸入（標準、效率、損耗）；以試算效率與損耗沿用原本時段重算每日淨收益 | `STANDARD_STEP_AUD_PER_MWH`, `RETENTION_TARGET`, `MINIMUM_SAMPLE_DAYS`, `SEASON_LABELS`, `select_period_days`, `parse_trial_input`, `parse_trial_standard`, `parse_trial_efficiency`, `parse_trial_degradation`, `reprice_days`, `build_candidate_standards`, `review_spread_standards`, `summarize_break_even_spreads` | — |
| `src/dashboard_source.js` | L2 資料來源 | 呼叫 AEMO 儀表板 API 並驗證回應 | `DASHBOARD_REPORT_URL`, `fetch_dashboard_report`, `parse_dashboard_report` | `http_request`, `nem_time` |
| `src/upload_parser.js` | L2 資料來源 | 解析手動上傳的 NEMWeb 預調度 CSV | `parse_predispatch_csv` | `csv_line`, `nem_time` |
| `src/special_dates.js` | L2 資料來源 | 讀取並逐列驗證事件清單 `data/special_dates.csv`；標題列、日期、時間、代碼、來源網址或審核人不合法時報錯並指出行號 | `SPECIAL_DATES_URL`, `SPECIAL_DATE_FIELD_NAMES`, `fetch_special_dates`, `parse_special_dates_csv`, `parse_special_date_row` | `csv_line`, `event_days`, `http_request` |
| `src/daily_summary.js` | L2 資料來源 | 讀取並驗證離線分析層輸出的 `data/daily_summary.json`（版本、日期遞增、排除日與收益欄位）；不合法時報錯 | `SUPPORTED_SCHEMA_VERSION`, `DAILY_SUMMARY_URL`, `fetch_daily_summary`, `parse_daily_summary` | `http_request` |
| `src/shared_configuration.js` | L2 資料來源 | 讀取並驗證共用設定檔 `config/battery.json`、`config/spread_standard.json`；欄位缺漏、未知欄位或數值不合理時報錯 | `SUPPORTED_SCHEMA_VERSION`, `BATTERY_CONFIGURATION_URL`, `SPREAD_STANDARD_URL`, `fetch_battery_configuration`, `fetch_spread_standard`, `parse_battery_configuration`, `parse_spread_standard` | `http_request` |
| `src/page_render.js` | L3 顯示 | 預調度工具：計畫卡片、KPI、兩張圖（Chart.js） | `format_aud`, `render_plan_steps`, `render_kpi_row`, `draw_price_chart`, `draw_sweep_chart` | `nem_time`, `number_format` |
| `src/scenario_render.js` | L3 顯示 | 情境工具：欄位、燈號、KPI、三張圖（含每日收益與事件標注）、校準統計、事件表 | `build_field_html`, `render_verdict`, `render_kpis`, `draw_hourly_chart`, `draw_standard_chart`, `draw_daily_revenue_chart`, `build_event_tooltip_lines`, `render_calibration_stats`, `render_special_dates_table`, `format_event_period` | `event_days`, `number_format`, `scenario_presets` |
| `src/spread_review_render.js` | L3 顯示 | 價差標準檢討的結論、KPI、說明清單（期間、排除日期、提示、成本說明）與「標準 vs 歷史淨收益」圖；試算時改標「試算」並說明試算設備參數的限制 | `describe_spread_review`, `render_spread_review`, `draw_spread_review_chart` | `number_format`, `spread_review` |
| `src/app.js` | L4 進入點 | 預調度工具（`index.html`）：先讀設備參數，再讀資料、收集輸入、呼叫計算與顯示、自動更新 | — | `dashboard_source`, `nem_time`, `number_format`, `page_render`, `shared_configuration`, `threshold_dispatch`, `upload_parser`, `window_selection` |
| `src/scenario_app.js` | L4 進入點 | 情境工具（`scenario/index.html`）：模擬、校準、讀事件清單與每日摘要、讀共用設定做價差標準檢討（含試算標準、效率與損耗） | — | `daily_summary`, `event_days`, `history_calibration`, `nem_time`, `number_format`, `price_simulation`, `scenario_presets`, `scenario_render`, `shared_configuration`, `special_dates`, `spread_review`, `spread_review_render`, `spread_strategy`, `window_selection` |

外部函式庫由兩個 HTML 從 cdnjs 以全域變數載入：JSZip 3.10.1（預調度工具解壓上傳的 zip）、Chart.js 4.4.1（兩個工具畫圖）。

## 離線分析層 `analysis/`（Python）

以 uv 管理，只在本機批次執行，網頁不載入。層級規則同上，由 `analysis/tests/test_module_layers.py` 檢查；新增、改名或刪除模組時，同一個 commit 更新本表與該測試的層級表。

| 模組 | 層級 | 職責 | 對外介面 | 依賴 |
|---|---|---|---|---|
| `analysis/nem_day.py` | L0 基礎 | NEM 時間解析、交易日判斷、5 分鐘對應 30 分鐘時段 | `FIVE_MINUTE_INTERVAL`, `HALF_HOUR_INTERVAL`, `INTERVAL_HOURS`, `HALF_HOURS_PER_DAY`, `FIVE_MINUTE_INTERVALS_PER_HALF_HOUR`, `FIVE_MINUTE_INTERVALS_PER_DAY`, `parse_mms_timestamp`, `trading_date_for`, `half_hour_end_for`, `list_calendar_dates` | — |
| `analysis/mms_csv.py` | L0 基礎 | AEMO MMS CSV 依欄名串流解析，支援檔案中途換版本；每列附上檔案與實體行號 | `MmsTableName`, `MmsRecord`, `NumberedRow`, `LineNumberedReader`, `number_reader_rows`, `parse_mms_records`, `iterate_mms_file` | — |
| `analysis/record_fields.py` | L0 基礎 | 資料列欄位的讀取與數值、日期轉換，錯誤訊息帶位置與欄名 | `read_record_field`, `parse_finite_field`, `parse_iso_date_field` | — |
| `analysis/input_fingerprint.py` | L0 基礎 | 分析程式、外部資料與原始檔的 sha256 指紋 | `SourceFingerprint`, `RawFileEntry`, `compute_file_sha256`, `list_code_files`, `digest_files`, `combine_digests`, `compute_source_fingerprint`, `build_raw_manifest` | — |
| `analysis/arbitrage_plan.py` | L1 演算法 | `select_best_plan` 的 Python 版，與 `src/window_selection.js` 以共用案例驗證一致 | `BatterySpecification`, `PlannedCycle`, `ArbitragePlan`, `round_half_up`, `segment_length_for`, `select_best_plan` | `nem_day` |
| `analysis/region_factors.py` | L1 演算法 | P5MIN 區域解的四個日因素：日均需求、晚間尖峰、最小供給餘裕、日均淨進出口 | `RegionSnapshot`, `RegionDayFactors`, `RegionFactorResult`, `collect_region_snapshots`, `compute_region_day_factors` | `mms_csv`, `nem_day`, `record_fields` |
| `analysis/external_factors.py` | L1 演算法 | `data/external/` 的天然氣事前價與電池放電功率月底值 | `BatteryUnitRecord`, `read_csv_records`, `parse_gas_prices`, `parse_battery_units`, `month_end_for`, `battery_power_at`, `daily_battery_power` | `record_fields` |
| `analysis/weight_solver.py` | L1 演算法 | 標準化、相關方向、HiGHS 非負 L1 迴歸、權重與擬合品質 | `StandardizedMatrix`, `StandardizedTarget`, `FactorDirections`, `LinearFit`, `FitQuality`, `FactorFit`, `WeightSolution`, `standardize_columns`, `standardize_target`, `compute_directions`, `solve_l1_nonnegative`, `compute_scale`, `evaluate_fit`, `solve_factor_weights` | — |
| `analysis/daily_revenue.py` | L2 彙整與設定 | 合併多檔 5 分鐘電價、平均成 30 分鐘、算每個交易日的最佳計畫與套利收益、統計每日 5 分鐘電價筆數 | `DailyRevenueResult`, `DailyPlanResult`, `SourcedPrice`, `merge_interval_prices`, `average_half_hour_prices`, `count_five_minute_prices_by_trading_date`, `group_prices_by_trading_date`, `compute_daily_plans`, `compute_daily_revenue` | `arbitrage_plan`, `mms_csv`, `nem_day`, `record_fields` |
| `analysis/battery_configuration.py` | L2 彙整與設定 | 讀取並驗證 `config/battery.json`，規則與 `src/shared_configuration.js` 相同 | `BATTERY_CONFIGURATION_RELATIVE_PATH`, `SUPPORTED_SCHEMA_VERSION`, `BATTERY_FIELD_NAMES`, `UTF8_WITH_OPTIONAL_BOM`, `read_battery_specification`, `parse_battery_specification`, `check_field_names`, `read_number_field`, `is_finite_number` | `arbitrage_plan` |
| `analysis/factor_dataset.py` | L3 資料集 | 對齊每日收益與六個因素，決定擬合期間、記錄排除日 | `FactorDefinition`, `DailyFactorValues`, `FACTOR_DEFINITIONS`, `FactorSources`, `ExcludedDay`, `FactorDataset`, `span_source_dates`, `build_factor_dataset` | `daily_revenue`, `nem_day`, `region_factors` |
| `analysis/factor_weights_report.py` | L4 輸出組裝 | 組出 `data/factor_weights.json` 的內容（月份基準、最近值、待加入因素、指紋） | `SCHEMA_VERSION`, `PENDING_FACTORS`, `LatestValue`, `ReportMetadata`, `format_utc_timestamp`, `compute_monthly_baseline`, `compute_latest_value`, `build_fingerprint_section`, `build_report_document` | `arbitrage_plan`, `factor_dataset`, `input_fingerprint`, `weight_solver` |
| `analysis/build_factor_weights.py` | L5 進入點 | 讀 `NEM_INPUT_DIRECTORY`、`data/external/` 與 `config/battery.json`，跑完整條流程並寫出 JSON | `main`, `build_document`, `find_raw_input_files`, `iterate_records`, `write_report_document`, `configure_logging`, `EXTERNAL_INPUT_RELATIVE_PATHS`, `OUTPUT_RELATIVE_PATH`, `REGENERATE_COMMAND` | `arbitrage_plan`, `battery_configuration`, `daily_revenue`, `external_factors`, `factor_dataset`, `factor_weights_report`, `input_fingerprint`, `mms_csv`, `region_factors`, `weight_solver` |
| `analysis/daily_summary_report.py` | L5 輸出組裝 | 組出 `data/daily_summary.json` 的內容（每日最佳計畫、各循環價差、排除日與原因、指紋）；沒有匯入 `build_factor_weights`，所以與它同層 | `SCHEMA_VERSION`, `SUMMARY_START_DATE`, `SummarySources`, `SummaryMetadata`, `find_exclusion_reason`, `format_interval_start`, `build_summary_document` | `arbitrage_plan`, `daily_revenue`, `factor_weights_report`, `input_fingerprint`, `nem_day` |
| `analysis/build_daily_summary.py` | L6 進入點 | 讀 `NEM_INPUT_DIRECTORY` 的電價檔與 `config/battery.json`，寫出 `data/daily_summary.json`；讀檔與寫檔沿用 `build_factor_weights` | `main`, `build_document`, `EXTERNAL_INPUT_RELATIVE_PATHS`, `OUTPUT_RELATIVE_PATH`, `REGENERATE_COMMAND` | `battery_configuration`, `build_factor_weights`, `daily_revenue`, `daily_summary_report`, `input_fingerprint` |

JS 與 Python 共用的測試案例在 `tests/fixtures/select_best_plan_cases.json`，由 `tests/select_best_plan_fixture.test.js` 與 `analysis/tests/test_arbitrage_plan.py` 讀取。外部依賴：`numpy`（矩陣運算）、`highspy`（HiGHS 線性規劃求解器）。
