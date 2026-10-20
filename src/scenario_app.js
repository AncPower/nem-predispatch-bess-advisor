/**
 * 情境工具的進入點：收集輸入、模擬與評估、歷史校準、讀取事件清單與每日摘要，交給 scenario_render 顯示；
 * 價差標準檢討（#32）讀共用設定，計算交給 spread_review、顯示交給 spread_review_render；
 * 試算標準、效率與損耗只在畫面上，不寫入設定檔。
 */

import { fetch_daily_summary } from "./daily_summary.js";
import {
  EVENT_VIEWS, annotate_days_with_events, collect_event_dates, collect_excluded_dates, filter_days_by_event_view, group_events_by_date,
} from "./event_days.js";
import { calibrate_from_history, parse_history_csv, select_calibration_region } from "./history_calibration.js";
import { simulate_price_paths, summarize_hourly_percentiles } from "./price_simulation.js";
import { INTERVAL_HOURS } from "./nem_time.js";
import { format_number } from "./number_format.js";
import { MARKET_PRESETS, NEWS_ADJUSTMENTS, build_field_definitions, clamp_to_field_limits, default_parameters } from "./scenario_presets.js";
import {
  build_field_html, draw_daily_revenue_chart, draw_hourly_chart, draw_standard_chart, render_calibration_stats, render_kpis, render_special_dates_table, render_verdict,
} from "./scenario_render.js";
import { fetch_battery_configuration, fetch_spread_standard } from "./shared_configuration.js";
import { fetch_special_dates } from "./special_dates.js";
import {
  parse_trial_degradation, parse_trial_efficiency, parse_trial_standard, reprice_days, review_spread_standards, select_period_days, summarize_break_even_spreads,
} from "./spread_review.js";
import { describe_spread_review, draw_spread_review_chart, render_spread_review } from "./spread_review_render.js";
import { choose_best_standard, decide_verdict, evaluate_spread_strategy, summarize_first_day, sweep_spread_standards } from "./spread_strategy.js";
import { break_even_spread, segment_length_for } from "./window_selection.js";

const CALIBRATED_PRESET_KEY = "hist";
const RENDER_DELAY_MILLISECONDS = 120;
const SWEEP_STEP_COUNT = 24;
const CHART_DAY_LIMIT = 7;
const LOG_DISPLAY_COUNT = 4;
const LARGE_UNIT_THRESHOLD = 1000;
const LARGE_UNIT_ROUNDING = 50;
const REVIEW_INPUT_IDS = Object.freeze(["review_trial_standard", "review_trial_efficiency", "review_trial_degradation"]);

const element_by_id = (element_id) => document.getElementById(element_id);

const page_state = {
  market_presets: { ...MARKET_PRESETS },
  preset_key: "nsw",
  parameters: default_parameters(MARKET_PRESETS.nsw),
  applied_news: [],
  history_rows: null,
  history_name: "",
  special_dates: [],
  special_dates_loaded: false,
  daily_summary: null,
  spread_standard: null,
  battery_configuration: null,
  battery_error: "",
  render_timer: null,
  hourly_chart: null,
  standard_chart: null,
  daily_chart: null,
  review_chart: null,
};

/**
 * 目前的市場預設。
 *
 * @returns {import("./scenario_presets.js").MarketPreset} 市場預設
 */
function current_preset() {
  return page_state.market_presets[page_state.preset_key];
}

/**
 * 顯示狀態訊息（純文字）。
 *
 * @param {string} element_id 狀態元素
 * @param {string} status_message 訊息
 * @param {boolean} [is_error] 是否為錯誤
 */
function set_status(element_id, status_message, is_error = false) {
  const status_element = element_by_id(element_id);
  status_element.textContent = status_message;
  status_element.className = is_error ? "status err" : "status";
}

/** 依目前市場重建市場選單與三組欄位。 */
function build_controls() {
  const market_select = element_by_id("market_select");
  market_select.replaceChildren(...Object.entries(page_state.market_presets).map(([preset_key, market_preset]) => {
    const market_option = document.createElement("option");
    market_option.value = preset_key;
    market_option.textContent = `${market_preset.market_name}（${market_preset.currency_code}）`;
    return market_option;
  }));
  market_select.value = page_state.preset_key;
  element_by_id("market_note").textContent = current_preset().market_note;
  const field_groups = build_field_definitions(current_preset());
  const group_containers = { scenario_fields: "scenario_fields", weather_fields: "weather_fields", strategy_fields: "strategy_fields" };
  for (const [group_name, container_id] of Object.entries(group_containers)) {
    element_by_id(container_id).innerHTML = field_groups[group_name]
      .map((field_definition) => build_field_html(field_definition, page_state.parameters[field_definition.parameter_key]))
      .join("");
  }
  element_by_id("number_price_floor").value = String(page_state.parameters.price_floor);
  element_by_id("number_price_cap").value = String(page_state.parameters.price_cap);
}

/** 把參數寫回所有欄位。 */
function sync_inputs() {
  for (const [parameter_key, parameter_value] of Object.entries(page_state.parameters)) {
    const range_input = element_by_id(`range_${parameter_key}`);
    const number_input = element_by_id(`number_${parameter_key}`);
    if (range_input) range_input.value = String(parameter_value);
    if (number_input) number_input.value = String(parameter_value);
  }
}

/**
 * 切換市場並回到該市場預設值。
 *
 * @param {string} preset_key 市場代碼
 */
function switch_market(preset_key) {
  page_state.preset_key = preset_key;
  page_state.parameters = default_parameters(current_preset());
  page_state.applied_news = [];
  element_by_id("news_log").textContent = "";
  build_controls();
  render_results();
}

/** 合併短時間內的多次輸入，只重算一次。 */
function schedule_render() {
  clearTimeout(page_state.render_timer);
  page_state.render_timer = setTimeout(render_results, RENDER_DELAY_MILLISECONDS);
}

/** 模擬、評估並更新燈號、KPI 與兩張圖。 */
function render_results() {
  const market_preset = current_preset();
  const parameters = page_state.parameters;
  const simulation = simulate_price_paths(parameters, market_preset);
  const first_day = summarize_first_day(simulation, parameters.spread_standard);
  const strategy_settings = { power_mw: parameters.power_mw, maximum_wait_days: parameters.maximum_wait_days };
  const high_spread = first_day.sorted_spreads[Math.floor(simulation.path_count * 0.95)];
  const maximum_standard = Math.max(parameters.spread_standard * 1.6, high_spread * 1.1, 1);
  const sweep_points = sweep_spread_standards(simulation, strategy_settings, maximum_standard, SWEEP_STEP_COUNT);
  const best_standard = choose_best_standard(sweep_points);
  const current_outcome = evaluate_spread_strategy(simulation, strategy_settings, parameters.spread_standard);
  const rounding_step = market_preset.base_price > LARGE_UNIT_THRESHOLD ? LARGE_UNIT_ROUNDING : 1;
  const suggested_standard = Math.round(best_standard.spread_standard / rounding_step) * rounding_step;
  render_verdict(
    { lamp_element: element_by_id("verdict_lamp"), title_element: element_by_id("verdict_title"), text_element: element_by_id("verdict_text") },
    {
      verdict_kind: decide_verdict(first_day.hit_probability, parameters.spread_standard, best_standard.spread_standard),
      first_day, current_standard: parameters.spread_standard, suggested_standard,
      maximum_wait_days: parameters.maximum_wait_days, currency_code: market_preset.currency_code,
    },
  );
  render_kpis(element_by_id("kpi_row"), current_outcome, { suggested_standard, suggested_mean: best_standard.mean_value }, {
    evaluation_days: parameters.evaluation_days, power_mw: parameters.power_mw, currency_code: market_preset.currency_code,
  });
  const hourly_percentiles = summarize_hourly_percentiles(simulation, CHART_DAY_LIMIT);
  element_by_id("price_subtitle").textContent = `${market_preset.market_name}，單位 ${market_preset.currency_code}/MWh；以模擬的前 ${hourly_percentiles.used_days} 天、${simulation.path_count} 條路徑統計`;
  page_state.hourly_chart = draw_hourly_chart(element_by_id("hourly_chart"), page_state.hourly_chart, hourly_percentiles, first_day);
  page_state.standard_chart = draw_standard_chart(element_by_id("standard_chart"), page_state.standard_chart, sweep_points, {
    best_index: best_standard.point_index, current_standard: parameters.spread_standard, currency_code: market_preset.currency_code,
  });
}

/**
 * 套用一則新聞事件。
 *
 * @param {number} news_index 新聞事件索引
 */
function apply_news(news_index) {
  const news_adjustment = NEWS_ADJUSTMENTS[news_index];
  news_adjustment.apply_adjustment(page_state.parameters);
  clamp_to_field_limits(page_state.parameters, current_preset());
  page_state.applied_news.push(news_adjustment.log_text);
  element_by_id("news_log").textContent = `已套用：${page_state.applied_news.slice(-LOG_DISPLAY_COUNT).join("；")}`;
  sync_inputs();
  render_results();
}

/**
 * 讀入歷史電價檔並校準。
 *
 * @param {File} history_file 上傳的檔案
 */
async function load_history(history_file) {
  try {
    const history_rows = parse_history_csv(await history_file.text());
    const region_choice = select_calibration_region(history_rows);
    page_state.history_rows = region_choice.region_rows;
    page_state.history_name = history_file.name;
    run_calibration(region_choice.region_count > 1 ? `檔案含 ${region_choice.region_count} 個區域，使用 ${region_choice.region_id}。` : "");
  } catch (load_error) {
    set_status("calibration_status", `無法讀取歷史電價：${load_error.message}`, true);
  }
}

/**
 * 以目前的歷史資料與預設排除的事件日校準，市場切到「歷史校準」。
 *
 * @param {string} [region_message] 區域選擇的說明
 */
function run_calibration(region_message = "") {
  if (!page_state.history_rows) return;
  const base_key = page_state.preset_key === CALIBRATED_PRESET_KEY ? page_state.market_presets[CALIBRATED_PRESET_KEY].source_preset_key : page_state.preset_key;
  try {
    const calibration_result = calibrate_from_history(
      page_state.history_rows, collect_excluded_dates(page_state.special_dates), MARKET_PRESETS[base_key], page_state.history_name,
    );
    page_state.market_presets[CALIBRATED_PRESET_KEY] = { ...calibration_result.calibrated_preset, source_preset_key: base_key };
    render_calibration_stats(element_by_id("calibration_stats"), calibration_result.calibration_stats);
    set_status("calibration_status", `${region_message}已依 ${page_state.history_name} 校準，市場切換為「歷史校準」。`);
    switch_market(CALIBRATED_PRESET_KEY);
  } catch (calibration_error) {
    set_status("calibration_status", calibration_error.message, true);
  }
}

/** 讀取 `data/special_dates.csv`，更新事件表；有歷史資料時依新的排除日期重新校準。 */
async function load_special_dates() {
  set_status("events_status", "正在讀取事件清單…");
  try {
    page_state.special_dates = await fetch_special_dates();
    page_state.special_dates_loaded = true;
    render_special_dates_table(element_by_id("events_body"), page_state.special_dates, "事件清單目前沒有任何事件。");
    const excluded_count = collect_excluded_dates(page_state.special_dates).size;
    set_status("events_status", `共 ${page_state.special_dates.length} 筆事件，其中 ${excluded_count} 個日期在校準時預設排除。`);
    render_daily_revenue();
    render_spread_review_section();
    if (page_state.history_rows) run_calibration();
  } catch (events_error) {
    set_status("events_status", `無法讀取事件清單：${events_error.message}`, true);
  }
}

/** 依每日摘要與目前的事件清單畫每日收益圖；摘要還沒讀到時不畫。 */
function render_daily_revenue() {
  const daily_summary = page_state.daily_summary;
  if (!daily_summary) return;
  const annotated_days = annotate_days_with_events(daily_summary.days, group_events_by_date(page_state.special_dates));
  const days_in_period = new Set(daily_summary.days.map((summary_day) => summary_day.date));
  const event_day_count = [...collect_event_dates(page_state.special_dates)].filter((event_date) => days_in_period.has(event_date)).length;
  const excluded_day_count = daily_summary.days.filter((summary_day) => summary_day.excluded).length;
  const first_date = daily_summary.days[0].date;
  const last_date = daily_summary.days.at(-1).date;
  element_by_id("daily_subtitle").textContent =
    `${daily_summary.region_id}，${first_date} 至 ${last_date}，共 ${daily_summary.days.length} 天；資料不完整而排除 ${excluded_day_count} 天（圖上留空），期間內事件日 ${event_day_count} 天。`;
  page_state.daily_chart = draw_daily_revenue_chart(element_by_id("daily_chart"), page_state.daily_chart, annotated_days);
}

/** 讀取 `data/daily_summary.json` 並畫每日收益圖；失敗時只在這張圖顯示錯誤。 */
async function load_daily_summary() {
  set_status("daily_status", "正在讀取每日摘要…");
  try {
    page_state.daily_summary = await fetch_daily_summary();
    set_status("daily_status", "");
    render_daily_revenue();
    initialize_review_period();
    render_spread_review_section();
  } catch (summary_error) {
    set_status("daily_status", `無法讀取每日摘要：${summary_error.message}`, true);
  }
}

/** 價差標準檢討的期間欄位：範圍限定在每日摘要內，預設為整段期間。 */
function initialize_review_period() {
  const summary_days = page_state.daily_summary.days;
  const first_date = summary_days[0].date;
  const last_date = summary_days.at(-1).date;
  for (const [element_id, default_date] of [["review_start_date", first_date], ["review_end_date", last_date]]) {
    const date_input = element_by_id(element_id);
    date_input.min = first_date;
    date_input.max = last_date;
    if (date_input.value === "") date_input.value = default_date;
  }
}

/** 依期間、事件檢視與目前（或試算）標準重算並更新價差標準檢討；每日摘要或價差標準還沒讀到時不畫。 */
function render_spread_review_section() {
  const { daily_summary, spread_standard } = page_state;
  if (!daily_summary || !spread_standard) return;
  const view_key = element_by_id("review_event_view").value;
  if (view_key !== "include_events" && !page_state.special_dates_loaded) {
    clear_spread_review("事件清單尚未讀到，無法套用這個事件檢視。");
    return;
  }
  try {
    const start_date = element_by_id("review_start_date").value;
    const end_date = element_by_id("review_end_date").value;
    const period_days = select_period_days(daily_summary.days, start_date, end_date);
    const view_days = filter_days_by_event_view(period_days, collect_event_dates(page_state.special_dates), view_key);
    const kept_dates = new Set(view_days.map((summary_day) => summary_day.date));
    const trial_standard = parse_trial_standard(element_by_id("review_trial_standard").value);
    const is_trial = trial_standard !== null;
    const { battery_configuration, configured_battery, review_days } = apply_cost_trial(view_days);
    const spread_review = review_spread_standards(review_days, is_trial ? trial_standard : spread_standard.spread_standard_aud_per_mwh);
    const cost_summary = battery_configuration
      ? summarize_break_even_spreads(review_days, (charge_average_price) => break_even_spread(charge_average_price, battery_configuration))
      : null;
    const review_description = describe_spread_review(spread_review, {
      start_date, end_date, event_view_label: EVENT_VIEWS[view_key],
      event_removed_dates: period_days.filter((summary_day) => !kept_dates.has(summary_day.date)).map((summary_day) => summary_day.date),
      spread_standard, battery_configuration, battery_error: page_state.battery_error, cost_summary, is_trial, configured_battery,
    });
    render_spread_review({
      title_element: element_by_id("review_title"), text_element: element_by_id("review_text"),
      kpi_container: element_by_id("review_kpis"), notes_list: element_by_id("review_notes"),
    }, review_description);
    page_state.review_chart = draw_spread_review_chart(element_by_id("review_chart"), page_state.review_chart, spread_review, is_trial);
    set_status("review_status", "");
  } catch (review_error) {
    clear_spread_review(`無法完成價差標準檢討：${review_error.message}`);
  }
}

/**
 * 套用試算效率與損耗：兩欄都留空時原樣回傳；有任一欄時以試算參數沿用原本時段重算每天的淨收益。
 *
 * @param {readonly import("./daily_summary.js").DailySummaryDay[]} view_days 依期間與事件檢視篩選後的每日資料
 * @returns {{battery_configuration: import("./shared_configuration.js").BatteryConfiguration | null, configured_battery: import("./shared_configuration.js").BatteryConfiguration | null, review_days: readonly object[]}}
 *   `battery_configuration` 為計算用的設備參數（試算後），`configured_battery` 只在試算時為設定檔原值
 * @throws {Error} 輸入不合法，或要試算但設備參數讀不到時
 */
function apply_cost_trial(view_days) {
  const trial_efficiency = parse_trial_efficiency(element_by_id("review_trial_efficiency").value);
  const trial_degradation = parse_trial_degradation(element_by_id("review_trial_degradation").value);
  const configured_battery = page_state.battery_configuration;
  if (trial_efficiency === null && trial_degradation === null) {
    return { battery_configuration: configured_battery, configured_battery: null, review_days: view_days };
  }
  if (!configured_battery) throw new Error(`設備參數讀不到，無法試算效率與損耗：${page_state.battery_error}`);
  const trial_battery = {
    ...configured_battery,
    round_trip_efficiency: trial_efficiency ?? configured_battery.round_trip_efficiency,
    degradation_cost_aud_per_mwh: trial_degradation ?? configured_battery.degradation_cost_aud_per_mwh,
  };
  const energy_mwh = Math.min(trial_battery.capacity_mwh, trial_battery.power_mw * segment_length_for(trial_battery) * INTERVAL_HOURS);
  return { battery_configuration: trial_battery, configured_battery, review_days: reprice_days(view_days, { ...trial_battery, energy_mwh }) };
}

/**
 * 清掉上一次的檢討結果並顯示錯誤，避免舊結論留在畫面上。
 *
 * @param {string} error_message 錯誤訊息
 */
function clear_spread_review(error_message) {
  render_spread_review({
    title_element: element_by_id("review_title"), text_element: element_by_id("review_text"),
    kpi_container: element_by_id("review_kpis"), notes_list: element_by_id("review_notes"),
  }, { title_text: "", body_text: "", kpi_items: [], note_lines: [] });
  page_state.review_chart?.destroy();
  page_state.review_chart = null;
  set_status("review_status", error_message, true);
}

/** 讀取價差標準與設備參數；設備參數讀不到時檢討照常進行，只是不顯示損益兩平價差。 */
async function load_review_configuration() {
  set_status("review_status", "正在讀取價差標準…");
  try {
    page_state.spread_standard = await fetch_spread_standard();
    element_by_id("review_trial_standard").placeholder = `目前 ${format_number(page_state.spread_standard.spread_standard_aud_per_mwh, 2)}`;
  } catch (standard_error) {
    set_status("review_status", `無法讀取價差標準：${standard_error.message}`, true);
    return;
  }
  try {
    page_state.battery_configuration = await fetch_battery_configuration();
    element_by_id("review_trial_efficiency").placeholder = `設定值 ${format_number(page_state.battery_configuration.round_trip_efficiency * 100, 1)}`;
    element_by_id("review_trial_degradation").placeholder = `設定值 ${format_number(page_state.battery_configuration.degradation_cost_aud_per_mwh, 2)}`;
  } catch (battery_error) {
    page_state.battery_error = battery_error.message;
  }
  set_status("review_status", "");
  render_spread_review_section();
}

/** 綁定價差標準檢討的期間、事件檢視與三個試算欄。 */
function wire_review_controls() {
  const view_select = element_by_id("review_event_view");
  view_select.replaceChildren(...Object.entries(EVENT_VIEWS).map(([view_key, view_label]) => {
    const view_option = document.createElement("option");
    view_option.value = view_key;
    view_option.textContent = view_label;
    return view_option;
  }));
  for (const element_id of ["review_start_date", "review_end_date", "review_event_view"]) {
    element_by_id(element_id).addEventListener("change", render_spread_review_section);
  }
  for (const element_id of REVIEW_INPUT_IDS) element_by_id(element_id).addEventListener("input", render_spread_review_section);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render_spread_review_section);
}

/** 綁定市場、新聞、重設與三組欄位（以事件委派處理重建後的欄位）。 */
function wire_controls() {
  element_by_id("market_select").addEventListener("change", (change_event) => switch_market(change_event.target.value));
  element_by_id("news_buttons").innerHTML = NEWS_ADJUSTMENTS.map((news_adjustment, news_index) => `<button type="button" data-news-index="${news_index}">${news_adjustment.label_text}</button>`).join("");
  element_by_id("news_buttons").addEventListener("click", (click_event) => {
    const news_button = click_event.target.closest("button");
    if (news_button) apply_news(Number(news_button.dataset.newsIndex));
  });
  element_by_id("reset_button").addEventListener("click", () => switch_market(page_state.preset_key));
  element_by_id("controls_panel").addEventListener("input", (input_event) => {
    const input_match = /^(range|number)_(.+)$/.exec(input_event.target.id ?? "");
    if (!input_match || input_event.target.value === "") return;
    const parameter_key = input_match[2];
    page_state.parameters[parameter_key] = Number(input_event.target.value);
    const twin_input = element_by_id(`${input_match[1] === "range" ? "number" : "range"}_${parameter_key}`);
    if (twin_input) twin_input.value = input_event.target.value;
    schedule_render();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render_results);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render_daily_revenue);
}

/** 綁定歷史電價上傳。 */
function wire_calibration() {
  const drop_zone = element_by_id("calibration_drop");
  const file_input = element_by_id("calibration_file");
  drop_zone.addEventListener("click", () => file_input.click());
  drop_zone.addEventListener("keydown", (key_event) => {
    if (key_event.key !== "Enter" && key_event.key !== " ") return;
    key_event.preventDefault();
    file_input.click();
  });
  drop_zone.addEventListener("dragover", (drag_event) => { drag_event.preventDefault(); drop_zone.classList.add("over"); });
  drop_zone.addEventListener("dragleave", () => drop_zone.classList.remove("over"));
  drop_zone.addEventListener("drop", (drop_event) => {
    drop_event.preventDefault();
    drop_zone.classList.remove("over");
    const dropped_file = drop_event.dataTransfer.files[0];
    if (dropped_file) load_history(dropped_file);
  });
  file_input.addEventListener("change", () => {
    const chosen_file = file_input.files[0];
    if (chosen_file) load_history(chosen_file);
    file_input.value = "";
  });
}

window.Chart.defaults.font.family = '"Noto Sans TC",system-ui,sans-serif';
build_controls();
wire_controls();
wire_calibration();
wire_review_controls();
render_results();
load_special_dates();
load_daily_summary();
load_review_configuration();
