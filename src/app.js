/**
 * 頁面進入點：讀取資料（自動或手動上傳）、收集輸入、呼叫計算、交給 page_render 顯示。
 */

import { fetch_dashboard_report, parse_dashboard_report } from "./dashboard_source.js";
import { format_nem_label, interval_start_minute } from "./nem_time.js";
import { draw_price_chart, draw_sweep_chart, format_aud, render_kpi_row, render_plan_steps } from "./page_render.js";
import { simulate_threshold_dispatch } from "./threshold_dispatch.js";
import { parse_predispatch_csv } from "./upload_parser.js";
import { select_best_plan, suggest_price_thresholds } from "./window_selection.js";

const AUTO_REFRESH_INTERVAL_MILLISECONDS = 5 * 60_000;
const SWEEP_STEP_COUNT = 30;
const MINIMUM_SWEEP_RANGE = 50;
const MINIMUM_BATTERY_SIZE = 0.1;
const ZIP_FILE_SIGNATURE = Object.freeze([0x50, 0x4b]);
const RESULT_CARD_IDS = Object.freeze(["plan_card", "kpi_row", "price_chart_card", "sweep_chart_card"]);

const element_by_id = (element_id) => document.getElementById(element_id);

const page_state = {
  region_forecasts: null,
  origin_text: "",
  price_points: [],
  plan_result: null,
  thresholds_adjusted: false,
  is_loading: false,
  refresh_timer: null,
  price_chart: null,
  sweep_chart: null,
};

/**
 * 顯示資料狀態。
 *
 * @param {string} status_message 訊息（以純文字寫入）
 * @param {boolean} [is_error] 是否為錯誤
 */
function set_status(status_message, is_error = false) {
  const status_element = element_by_id("source_status");
  status_element.textContent = status_message;
  status_element.className = is_error ? "status err" : "status";
}

/** 從 AEMO 儀表板 API 讀取；失敗時保留上一次成功的資料。 */
async function load_from_dashboard() {
  if (page_state.is_loading) return;
  page_state.is_loading = true;
  set_status("正在連線 AEMO…");
  try {
    const region_forecasts = parse_dashboard_report(await fetch_dashboard_report());
    const read_time = new Date().toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
    apply_region_forecasts(region_forecasts, `來源：AEMO 儀表板 API，讀取時間 ${read_time}（你的電腦時間）`);
  } catch (load_error) {
    const kept_note = page_state.region_forecasts ? "畫面保留上一次成功的資料" : "請改用下方手動上傳";
    set_status(`讀取失敗：${load_error.message}。${kept_note}。`, true);
  } finally {
    page_state.is_loading = false;
  }
}

/**
 * 讀取手動上傳的 ZIP 或 CSV，並暫停自動更新。
 *
 * @param {File} upload_file 上傳的檔案
 */
async function load_from_upload(upload_file) {
  try {
    set_status("讀取中…");
    const region_forecasts = parse_predispatch_csv(await read_upload_text(upload_file));
    set_auto_refresh(false);
    apply_region_forecasts(region_forecasts, `來源：手動上傳 ${upload_file.name}（自動更新已暫停）`);
  } catch (upload_error) {
    set_status(`上傳的檔案無法讀取：${upload_error.message}`, true);
  }
}

/**
 * 取出上傳檔的 CSV 文字；ZIP 檔取第一個 CSV。
 *
 * @param {File} upload_file 上傳的檔案
 * @returns {Promise<string>} CSV 文字
 */
async function read_upload_text(upload_file) {
  const file_head = new Uint8Array(await upload_file.slice(0, 2).arrayBuffer());
  const is_zip_file = file_head[0] === ZIP_FILE_SIGNATURE[0] && file_head[1] === ZIP_FILE_SIGNATURE[1];
  if (!is_zip_file) return upload_file.text();
  if (!window.JSZip) throw new Error("無法載入 ZIP 解壓縮元件，請改上傳解壓後的 CSV");
  const zip_archive = await window.JSZip.loadAsync(upload_file);
  const csv_entry = Object.values(zip_archive.files).find((zip_entry) => /\.csv$/i.test(zip_entry.name));
  if (!csv_entry) throw new Error("ZIP 內沒有 CSV 檔");
  return csv_entry.async("string");
}

/**
 * 存下新資料並重新分析目前區域。
 *
 * @param {import("./dashboard_source.js").RegionForecasts} region_forecasts 各區域預測
 * @param {string} origin_text 資料來源說明
 */
function apply_region_forecasts(region_forecasts, origin_text) {
  page_state.region_forecasts = region_forecasts;
  page_state.origin_text = origin_text;
  analyse_region();
}

/**
 * 讀取電池輸入欄，數值不合理時拉回合法範圍。
 *
 * @returns {import("./threshold_dispatch.js").DispatchBattery} 電池規格
 */
function read_battery_inputs() {
  const read_number = (element_id, fallback_value) => {
    const input_value = Number.parseFloat(element_by_id(element_id).value);
    return Number.isFinite(input_value) ? input_value : fallback_value;
  };
  return {
    power_mw: Math.max(MINIMUM_BATTERY_SIZE, read_number("power_input", 5)),
    capacity_mwh: Math.max(MINIMUM_BATTERY_SIZE, read_number("capacity_input", 20)),
    marginal_loss_factor: read_number("loss_factor_input", 1),
    initial_soc_fraction: Math.min(1, Math.max(0, read_number("soc_input", 0) / 100)),
  };
}

/** 對目前選的區域重算建議計畫並更新畫面。 */
function analyse_region() {
  const region_id = element_by_id("region_select").value;
  const price_points = page_state.region_forecasts?.[region_id];
  if (!price_points?.length) {
    set_status(`資料中沒有 ${region_id} 的預測電價。`, true);
    return;
  }
  const price_values = price_points.map((price_point) => price_point.price);
  page_state.price_points = price_points;
  page_state.plan_result = select_best_plan(price_values, read_battery_inputs());
  set_status(`${page_state.origin_text}。`);
  element_by_id("empty_card").hidden = true;
  RESULT_CARD_IDS.forEach((card_id) => { element_by_id(card_id).hidden = false; });
  element_by_id("plan_subtitle").textContent = build_plan_subtitle(region_id, price_points);
  render_plan_steps(element_by_id("plan_steps"), page_state.plan_result, price_points);
  adjust_slider_ranges(price_values);
  if (!page_state.thresholds_adjusted) apply_suggested_thresholds();
  update_dispatch_view();
}

/**
 * 建議計畫的副標題：區域、預測期間與時段數。
 *
 * @param {string} region_id 區域代碼
 * @param {{interval_end_minute: number}[]} price_points 預測電價
 * @returns {string} 副標題
 */
function build_plan_subtitle(region_id, price_points) {
  const period_start = format_nem_label(interval_start_minute(price_points[0].interval_end_minute));
  const period_end = format_nem_label(price_points.at(-1).interval_end_minute);
  return `${region_id}，預測期間 ${period_start} 至 ${period_end}（NEM 時間），共 ${price_points.length} 個 30 分鐘時段`;
}

/**
 * 依電價範圍調整兩個滑桿的上下限。
 *
 * @param {number[]} price_values 預測電價
 */
function adjust_slider_ranges(price_values) {
  const lowest_price = Math.floor(Math.min(...price_values));
  const highest_price = Math.ceil(Math.max(...price_values));
  element_by_id("charge_cap_range").min = String(Math.min(lowest_price, -50));
  element_by_id("charge_cap_range").max = String(Math.max(highest_price, 100));
  element_by_id("spread_range").max = String(Math.max(MINIMUM_SWEEP_RANGE, highest_price - lowest_price));
}

/** 把自訂價格欄位設回建議值。 */
function apply_suggested_thresholds() {
  const price_values = page_state.price_points.map((price_point) => price_point.price);
  const suggested_thresholds = suggest_price_thresholds(price_values, page_state.plan_result);
  set_slider_pair("charge_cap", suggested_thresholds.charge_price_cap);
  set_slider_pair("spread", suggested_thresholds.price_spread);
  page_state.thresholds_adjusted = false;
}

/**
 * 同步設定滑桿與數字欄。
 *
 * @param {string} field_name `charge_cap` 或 `spread`
 * @param {number} field_value 數值
 */
function set_slider_pair(field_name, field_value) {
  element_by_id(`${field_name}_range`).value = String(field_value);
  element_by_id(`${field_name}_number`).value = String(field_value);
}

/** 依自訂價格重算 KPI 與兩張圖。 */
function update_dispatch_view() {
  if (!page_state.price_points.length) return;
  const battery_spec = read_battery_inputs();
  const price_values = page_state.price_points.map((price_point) => price_point.price);
  const charge_price_cap = Number(element_by_id("charge_cap_number").value) || 0;
  const price_spread = Number(element_by_id("spread_number").value) || 0;
  const discharge_price_floor = charge_price_cap + price_spread;
  element_by_id("discharge_floor_text").textContent = `放電價格下限＝充電上限 + 價差＝${format_aud(discharge_price_floor)}/MWh`;
  const dispatch_result = simulate_threshold_dispatch(price_values, battery_spec, { charge_price_cap, discharge_price_floor });
  render_kpi_row(element_by_id("kpi_row"), dispatch_result, page_state.plan_result.total_value);
  page_state.price_chart = draw_price_chart(element_by_id("price_chart"), page_state.price_chart, {
    price_points: page_state.price_points,
    interval_energy_mwh: dispatch_result.interval_energy_mwh,
    charge_price_cap,
    discharge_price_floor,
  });
  const sweep_points = build_sweep_points(price_values, battery_spec, charge_price_cap, price_spread);
  page_state.sweep_chart = draw_sweep_chart(element_by_id("sweep_chart"), page_state.sweep_chart, sweep_points, price_spread);
}

/**
 * 固定充電上限、改變價差時的預估淨收益。
 *
 * @param {number[]} price_values 預測電價
 * @param {import("./threshold_dispatch.js").DispatchBattery} battery_spec 電池規格
 * @param {number} charge_price_cap 充電上限
 * @param {number} current_spread 目前價差
 * @returns {{price_spread: number, net_value: number}[]} 掃描結果
 */
function build_sweep_points(price_values, battery_spec, charge_price_cap, current_spread) {
  const sweep_range = Math.max(Number(element_by_id("spread_range").max), current_spread * 1.5, MINIMUM_SWEEP_RANGE);
  return Array.from({ length: SWEEP_STEP_COUNT + 1 }, (_unused, step_index) => {
    const price_spread = (sweep_range * step_index) / SWEEP_STEP_COUNT;
    const sweep_result = simulate_threshold_dispatch(price_values, battery_spec, {
      charge_price_cap,
      discharge_price_floor: charge_price_cap + price_spread,
    });
    return { price_spread, net_value: sweep_result.net_value };
  });
}

/**
 * 開關自動更新。
 *
 * @param {boolean} is_enabled 是否啟用
 */
function set_auto_refresh(is_enabled) {
  element_by_id("auto_refresh").checked = is_enabled;
  clearInterval(page_state.refresh_timer);
  page_state.refresh_timer = is_enabled
    ? setInterval(() => { if (!document.hidden) load_from_dashboard(); }, AUTO_REFRESH_INTERVAL_MILLISECONDS)
    : null;
}

/** 綁定上傳區的點選、鍵盤與拖曳。 */
function wire_upload_zone() {
  const drop_zone = element_by_id("drop_zone");
  const file_input = element_by_id("file_input");
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
    if (dropped_file) load_from_upload(dropped_file);
  });
  file_input.addEventListener("change", () => {
    const chosen_file = file_input.files[0];
    if (chosen_file) load_from_upload(chosen_file);
    file_input.value = "";
  });
}

/** 綁定自訂價格的滑桿與數字欄。 */
function wire_threshold_inputs() {
  for (const field_name of ["charge_cap", "spread"]) {
    const range_input = element_by_id(`${field_name}_range`);
    const number_input = element_by_id(`${field_name}_number`);
    range_input.addEventListener("input", () => {
      number_input.value = range_input.value;
      page_state.thresholds_adjusted = true;
      update_dispatch_view();
    });
    number_input.addEventListener("input", () => {
      if (number_input.value === "") return;
      range_input.value = number_input.value;
      page_state.thresholds_adjusted = true;
      update_dispatch_view();
    });
  }
  element_by_id("reset_thresholds").addEventListener("click", () => {
    apply_suggested_thresholds();
    update_dispatch_view();
  });
}

/** 綁定資料來源、區域、電池欄位與主題切換。 */
function wire_source_and_battery_inputs() {
  element_by_id("refresh_button").addEventListener("click", load_from_dashboard);
  element_by_id("auto_refresh").addEventListener("change", (change_event) => {
    set_auto_refresh(change_event.target.checked);
    if (change_event.target.checked) load_from_dashboard();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && element_by_id("auto_refresh").checked) load_from_dashboard();
  });
  element_by_id("region_select").addEventListener("change", () => {
    page_state.thresholds_adjusted = false;
    if (page_state.region_forecasts) analyse_region();
  });
  for (const input_id of ["power_input", "capacity_input", "loss_factor_input"]) {
    element_by_id(input_id).addEventListener("input", () => { if (page_state.region_forecasts) analyse_region(); });
  }
  element_by_id("soc_input").addEventListener("input", update_dispatch_view);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", update_dispatch_view);
}

wire_upload_zone();
wire_threshold_inputs();
wire_source_and_battery_inputs();
set_auto_refresh(true);
load_from_dashboard();
