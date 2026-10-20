/**
 * 情境工具的畫面：欄位、判斷燈號、KPI、兩張圖、校準統計、事件表。只負責顯示，不做計算。
 *
 * 圖表使用全域的 Chart.js（由 scenario/index.html 從 cdnjs 載入）。事件清單是公開資料，
 * 內容一律以 textContent 寫入；來源網址已由 `special_dates.js` 限定為 http 或 https。
 */

import { EVENT_CATEGORY_LABELS, IMPACT_DIRECTION_LABELS } from "./event_days.js";
import { format_money, format_number } from "./number_format.js";
import { BATTERY_DURATION_HOURS } from "./scenario_presets.js";

const VERDICT_STYLES = Object.freeze({
  discharge: { lamp_text: "放電", color_token: "--go" },
  wait: { lamp_text: "等待", color_token: "--wait" },
  lower: { lamp_text: "下修", color_token: "--cut" },
});
const HOUR_LABELS = Object.freeze(Array.from({ length: 24 }, (_unused, hour_value) => `${hour_value}:00`));
const PERCENTILE_NAMES = Object.freeze(["P10", "P90", "中位數"]);
const SWEEP_SERIES_NAMES = Object.freeze(["期望收益", "建議標準", "目前標準"]);
const EVENT_COLUMN_COUNT = 8;

/**
 * 讀取 CSS 色彩變數，讓圖表跟著淺色或深色主題。
 *
 * @param {string} token_name 變數名稱
 * @returns {string} 色彩值
 */
function read_css_token(token_name) {
  return getComputedStyle(document.documentElement).getPropertyValue(token_name).trim();
}

/**
 * 一個「滑桿＋數字」欄位的 HTML（標籤來自程式內的欄位定義，不含外部輸入）。
 *
 * @param {import("./scenario_presets.js").FieldDefinition} field_definition 欄位定義
 * @param {number} current_value 目前值
 * @returns {string} HTML
 */
export function build_field_html(field_definition, current_value) {
  const field_key = field_definition.parameter_key;
  const range_attributes = `min="${field_definition.minimum_value}" max="${field_definition.maximum_value}" step="${field_definition.step_value}" value="${current_value}"`;
  return `<div class="field"><label for="range_${field_key}"><span>${field_definition.label_text}</span><span>${field_definition.unit_text}</span></label>
  <div class="row"><input type="range" id="range_${field_key}" ${range_attributes}>
  <input type="number" id="number_${field_key}" ${range_attributes} aria-label="${field_definition.label_text}"></div></div>`;
}

/**
 * @typedef {object} VerdictView
 * @property {"discharge" | "wait" | "lower"} verdict_kind 燈號
 * @property {{hit_probability: number, median_spread: number, common_charge_hour: number, common_discharge_hour: number}} first_day 今日摘要
 * @property {number} current_standard 目前價差標準
 * @property {number} suggested_standard 建議價差標準（已四捨五入）
 * @property {number} maximum_wait_days 最長等待天數
 * @property {string} currency_code 幣別
 */

/**
 * 畫判斷燈號與說明。
 *
 * @param {{lamp_element: HTMLElement, title_element: HTMLElement, text_element: HTMLElement}} verdict_elements 元素
 * @param {VerdictView} verdict_view 內容
 */
export function render_verdict(verdict_elements, verdict_view) {
  const verdict_style = VERDICT_STYLES[verdict_view.verdict_kind];
  verdict_elements.lamp_element.style.background = read_css_token(verdict_style.color_token);
  verdict_elements.lamp_element.textContent = verdict_style.lamp_text;
  const verdict_copy = build_verdict_copy(verdict_view);
  verdict_elements.title_element.textContent = verdict_copy.title_text;
  verdict_elements.text_element.textContent = verdict_copy.body_text;
}

/**
 * 燈號的標題與說明文字。
 *
 * @param {VerdictView} verdict_view 內容
 * @returns {{title_text: string, body_text: string}} 文字
 */
function build_verdict_copy(verdict_view) {
  const first_day = verdict_view.first_day;
  const probability_text = `${format_number(first_day.hit_probability * 100)}%`;
  const price_unit = `${verdict_view.currency_code}/MWh`;
  if (verdict_view.verdict_kind === "discharge") {
    const charge_hour = first_day.common_charge_hour;
    const discharge_hour = first_day.common_discharge_hour;
    return {
      title_text: "今日價差可望達標，建議依計畫充放電",
      body_text: `今日四小時價差中位數約 ${format_number(first_day.median_spread)} ${price_unit}，達到標準 ${format_number(verdict_view.current_standard)} 的機率為 ${probability_text}。建議 ${charge_hour}:00–${charge_hour + BATTERY_DURATION_HOURS}:00 充電、${discharge_hour}:00–${discharge_hour + BATTERY_DURATION_HOURS}:00 放電。`,
    };
  }
  if (verdict_view.verdict_kind === "wait") {
    return {
      title_text: "今日達標機率偏低，建議充電後持有，等待下一個高價時段",
      body_text: `達標機率 ${probability_text}，價差中位數約 ${format_number(first_day.median_spread)}。目前標準接近收益最高的區間，等待最多 ${verdict_view.maximum_wait_days} 天仍有利。`,
    };
  }
  return {
    title_text: `建議將價差標準下修至約 ${format_number(verdict_view.suggested_standard)} ${price_unit}`,
    body_text: `在目前情境下，標準 ${format_number(verdict_view.current_standard)} 的今日達標機率只有 ${probability_text}；模擬顯示標準約 ${format_number(verdict_view.suggested_standard)} 時期間收益最高。`,
  };
}

/**
 * 畫 KPI 列（標籤與數字都由程式產生）。
 *
 * @param {HTMLElement} kpi_container 容器
 * @param {import("./spread_strategy.js").StrategyOutcome} current_outcome 目前標準的評估
 * @param {{suggested_standard: number, suggested_mean: number}} suggestion 建議標準與其期望收益
 * @param {{evaluation_days: number, power_mw: number, currency_code: string}} context_values 期間、功率、幣別
 */
export function render_kpis(kpi_container, current_outcome, suggestion, context_values) {
  const currency_code = context_values.currency_code;
  const kpi_items = [
    { label: "預估期間淨收益（期望值）", value: format_money(current_outcome.mean_value, currency_code), detail: `${Math.round(context_values.evaluation_days)} 天，${context_values.power_mw} MW／${context_values.power_mw * BATTERY_DURATION_HOURS} MWh` },
    { label: "收益區間（P10–P90）", value: `${format_money(current_outcome.p10_value, currency_code)} ～`, detail: format_money(current_outcome.p90_value, currency_code) },
    { label: "平均放電次數", value: `${format_number(current_outcome.average_cycles, 1)} 次`, detail: `其中強制放電 ${format_number(current_outcome.average_forced, 1)} 次` },
    { label: "每次放電前平均等待", value: `${format_number(current_outcome.average_wait_days, 1)} 天`, detail: `期間內持有未放電共 ${format_number(current_outcome.average_hold_days, 1)} 天` },
    { label: "建議價差標準", value: `${format_number(suggestion.suggested_standard)} ${currency_code}`, detail: `期望值 ${format_money(suggestion.suggested_mean, currency_code)}` },
  ];
  kpi_container.innerHTML = kpi_items
    .map((kpi_item) => `<div class="kpi"><div class="k">${kpi_item.label}</div><div class="v">${kpi_item.value}</div><div class="s">${kpi_item.detail}</div></div>`)
    .join("");
}

/**
 * 畫 24 小時電價分布（P10–P90 帶、中位數）與最常見的充放電時段。
 *
 * @param {HTMLCanvasElement} chart_canvas 畫布
 * @param {object | null} previous_chart 上一次的圖表
 * @param {{p10_values: number[], p50_values: number[], p90_values: number[]}} hourly_percentiles 百分位
 * @param {{common_charge_hour: number, common_discharge_hour: number}} first_day 今日摘要
 * @returns {object} 新的 Chart.js 圖表
 */
export function draw_hourly_chart(chart_canvas, previous_chart, hourly_percentiles, first_day) {
  const axis_minimum = Math.min(0, ...hourly_percentiles.p10_values);
  const axis_maximum = Math.max(...hourly_percentiles.p90_values) * 1.05;
  const window_bars = (start_hour, bar_color) => ({
    type: "bar",
    data: HOUR_LABELS.map((_label, hour_value) => (hour_value >= start_hour && hour_value < start_hour + BATTERY_DURATION_HOURS ? [axis_minimum, axis_maximum] : null)),
    backgroundColor: bar_color, barPercentage: 1, categoryPercentage: 1, order: 3,
  });
  const tick_color = read_css_token("--ink-3");
  const chart_configuration = {
    type: "line",
    data: {
      labels: HOUR_LABELS,
      datasets: [
        window_bars(first_day.common_charge_hour, read_css_token("--charge-soft")),
        window_bars(first_day.common_discharge_hour, read_css_token("--discharge-soft")),
        { data: hourly_percentiles.p10_values, borderWidth: 0, pointRadius: 0, fill: false, order: 2 },
        { data: hourly_percentiles.p90_values, borderWidth: 0, pointRadius: 0, fill: "-1", backgroundColor: read_css_token("--band"), order: 2 },
        { data: hourly_percentiles.p50_values, borderColor: read_css_token("--line"), borderWidth: 2, pointRadius: 0, tension: 0.3, order: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { filter: (tooltip_item) => tooltip_item.datasetIndex >= 2, callbacks: { label: (tooltip_item) => `${PERCENTILE_NAMES[tooltip_item.datasetIndex - 2]}：${format_number(tooltip_item.parsed.y)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: tick_color, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: { min: axis_minimum, max: axis_maximum, grid: { color: read_css_token("--rule") }, ticks: { color: tick_color } },
      },
    },
  };
  previous_chart?.destroy();
  return new window.Chart(chart_canvas, chart_configuration);
}

/**
 * 畫「價差標準 vs 期望收益」掃描圖，標出建議與目前標準。
 *
 * @param {HTMLCanvasElement} chart_canvas 畫布
 * @param {object | null} previous_chart 上一次的圖表
 * @param {{spread_standard: number, mean_value: number}[]} sweep_points 掃描結果
 * @param {{best_index: number, current_standard: number, currency_code: string}} marker_values 標記
 * @returns {object} 新的 Chart.js 圖表
 */
export function draw_standard_chart(chart_canvas, previous_chart, sweep_points, marker_values) {
  const mean_values = sweep_points.map((sweep_point) => sweep_point.mean_value);
  const current_index = sweep_points.reduce(
    (nearest_index, sweep_point, point_index) =>
      Math.abs(sweep_point.spread_standard - marker_values.current_standard) < Math.abs(sweep_points[nearest_index].spread_standard - marker_values.current_standard) ? point_index : nearest_index,
    0,
  );
  const only_at = (target_index) => mean_values.map((mean_value, point_index) => (point_index === target_index ? mean_value : null));
  const tick_color = read_css_token("--ink-3");
  const currency_code = marker_values.currency_code;
  const chart_configuration = {
    type: "line",
    data: {
      labels: sweep_points.map((sweep_point) => format_number(sweep_point.spread_standard)),
      datasets: [
        { data: mean_values, borderColor: read_css_token("--charge"), borderWidth: 2, pointRadius: 0, tension: 0.25 },
        { data: only_at(marker_values.best_index), pointRadius: 6, pointBackgroundColor: read_css_token("--charge"), showLine: false },
        { data: only_at(current_index), pointRadius: 6, pointStyle: "rectRot", pointBackgroundColor: read_css_token("--discharge"), showLine: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (tooltip_items) => `價差標準 ${tooltip_items[0].label}`, label: (tooltip_item) => `${SWEEP_SERIES_NAMES[tooltip_item.datasetIndex]}：${format_money(tooltip_item.parsed.y, currency_code)}` } } },
      scales: {
        x: { title: { display: true, text: `價差標準（${currency_code}/MWh）`, color: tick_color }, grid: { display: false }, ticks: { color: tick_color, maxTicksLimit: 9, maxRotation: 0 } },
        y: { title: { display: true, text: `期間期望收益（${currency_code}）`, color: tick_color }, grid: { color: read_css_token("--rule") }, ticks: { color: tick_color, callback: (tick_value) => (Math.abs(tick_value) >= 1e6 ? `${format_number(tick_value / 1e6, 1)}M` : format_number(tick_value)) } },
      },
    },
  };
  previous_chart?.destroy();
  return new window.Chart(chart_canvas, chart_configuration);
}

/**
 * 畫校準統計。
 *
 * @param {HTMLElement} stats_container 容器
 * @param {import("./history_calibration.js").CalibrationResult["calibration_stats"]} calibration_stats 統計
 */
export function render_calibration_stats(stats_container, calibration_stats) {
  const stat_items = [
    ["使用天數", `${calibration_stats.used_days} 天`],
    ["排除事件日", `${calibration_stats.excluded_days} 天`],
    ["基準電價", format_number(calibration_stats.base_level)],
    ["午間凹陷", `${format_number(calibration_stats.solar_dip * 100)}%`],
    ["傍晚尖峰", `${format_number(calibration_stats.evening_peak * 100)}%`],
    ["尖峰日比例", `${format_number(calibration_stats.spike_day_share * 100, 1)}%`],
    ["四小時價差中位數", format_number(calibration_stats.median_spread)],
  ];
  stats_container.replaceChildren(...stat_items.map((stat_item) => {
    const stat_element = document.createElement("div");
    const value_element = document.createElement("b");
    stat_element.textContent = stat_item[0];
    value_element.textContent = stat_item[1];
    stat_element.append(value_element);
    return stat_element;
  }));
}

/**
 * 畫事件表，新的事件在上；內容一律以 textContent 寫入。
 *
 * @param {HTMLTableSectionElement} table_body 表身
 * @param {readonly import("./special_dates.js").SpecialDate[]} special_dates 事件（依起日排序）
 * @param {string} empty_message 沒有事件時顯示的文字
 */
export function render_special_dates_table(table_body, special_dates, empty_message) {
  if (special_dates.length === 0) {
    const empty_row = document.createElement("tr");
    const empty_cell = document.createElement("td");
    empty_cell.colSpan = EVENT_COLUMN_COUNT;
    empty_cell.className = "muted";
    empty_cell.textContent = empty_message;
    empty_row.append(empty_cell);
    table_body.replaceChildren(empty_row);
    return;
  }
  table_body.replaceChildren(...[...special_dates].reverse().map(build_special_date_row));
}

/**
 * 事件期間的顯示文字（NEM 時間）。
 *
 * @param {import("./special_dates.js").SpecialDate} special_date 事件
 * @returns {string} 例如「2026-06-12 17:00 至 21:00」
 */
export function format_event_period(special_date) {
  const is_single_day = special_date.start_date === special_date.end_date;
  if (special_date.start_time === "") return is_single_day ? special_date.start_date : `${special_date.start_date} 至 ${special_date.end_date}`;
  const start_text = `${special_date.start_date} ${special_date.start_time}`;
  return is_single_day ? `${start_text} 至 ${special_date.end_time}` : `${start_text} 至 ${special_date.end_date} ${special_date.end_time}`;
}

/**
 * 一筆事件的表格列。
 *
 * @param {import("./special_dates.js").SpecialDate} special_date 事件
 * @returns {HTMLTableRowElement} 表格列
 */
function build_special_date_row(special_date) {
  const event_row = document.createElement("tr");
  const add_text_cell = (cell_text, cell_class) => {
    const table_cell = document.createElement("td");
    table_cell.textContent = cell_text;
    if (cell_class) table_cell.className = cell_class;
    event_row.append(table_cell);
  };
  add_text_cell(format_event_period(special_date));
  add_text_cell(EVENT_CATEGORY_LABELS[special_date.category]);
  add_text_cell(special_date.event_name);
  add_text_cell(special_date.summary, "note-text");
  add_text_cell(IMPACT_DIRECTION_LABELS[special_date.impact_direction]);
  const tag_cell = document.createElement("td");
  const tag_element = document.createElement("span");
  tag_element.className = special_date.exclude_by_default ? "tag ex" : "tag";
  tag_element.textContent = special_date.exclude_by_default ? "預設排除" : "納入";
  tag_cell.append(tag_element);
  const link_cell = document.createElement("td");
  const source_link = document.createElement("a");
  source_link.href = special_date.source_url;
  source_link.target = "_blank";
  source_link.rel = "noopener noreferrer";
  source_link.textContent = new URL(special_date.source_url).hostname;
  link_cell.append(source_link);
  event_row.append(tag_cell, link_cell);
  add_text_cell(`${special_date.added_by} 新增／${special_date.reviewed_by} 審核`);
  return event_row;
}
