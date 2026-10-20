/**
 * 情境工具的進入點：收集輸入、模擬與評估、歷史校準、讀取事件清單，交給 scenario_render 顯示。
 */

import { collect_excluded_dates } from "./event_days.js";
import { calibrate_from_history, parse_history_csv, select_calibration_region } from "./history_calibration.js";
import { simulate_price_paths, summarize_hourly_percentiles } from "./price_simulation.js";
import { MARKET_PRESETS, NEWS_ADJUSTMENTS, build_field_definitions, clamp_to_field_limits, default_parameters } from "./scenario_presets.js";
import {
  build_field_html, draw_hourly_chart, draw_standard_chart, render_calibration_stats, render_kpis, render_special_dates_table, render_verdict,
} from "./scenario_render.js";
import { fetch_special_dates } from "./special_dates.js";
import { choose_best_standard, decide_verdict, evaluate_spread_strategy, summarize_first_day, sweep_spread_standards } from "./spread_strategy.js";

const CALIBRATED_PRESET_KEY = "hist";
const RENDER_DELAY_MILLISECONDS = 120;
const SWEEP_STEP_COUNT = 24;
const CHART_DAY_LIMIT = 7;
const LOG_DISPLAY_COUNT = 4;
const LARGE_UNIT_THRESHOLD = 1000;
const LARGE_UNIT_ROUNDING = 50;

const element_by_id = (element_id) => document.getElementById(element_id);

const page_state = {
  market_presets: { ...MARKET_PRESETS },
  preset_key: "nsw",
  parameters: default_parameters(MARKET_PRESETS.nsw),
  applied_news: [],
  history_rows: null,
  history_name: "",
  special_dates: [],
  render_timer: null,
  hourly_chart: null,
  standard_chart: null,
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
    render_special_dates_table(element_by_id("events_body"), page_state.special_dates, "事件清單目前沒有任何事件。");
    const excluded_count = collect_excluded_dates(page_state.special_dates).size;
    set_status("events_status", `共 ${page_state.special_dates.length} 筆事件，其中 ${excluded_count} 個日期在校準時預設排除。`);
    if (page_state.history_rows) run_calibration();
  } catch (events_error) {
    set_status("events_status", `無法讀取事件清單：${events_error.message}`, true);
  }
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
render_results();
load_special_dates();
