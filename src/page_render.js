/**
 * 把計算結果畫到頁面上：建議計畫卡片、KPI、電價圖、價差掃描圖。只負責顯示，不做計算。
 *
 * 圖表使用全域的 Chart.js（由 index.html 從 cdnjs 載入）。
 */

import { format_nem_label, interval_start_minute } from "./nem_time.js";
import { format_number } from "./number_format.js";

const CHART_VALUE_PADDING = 10;
const PRICE_DATASET_INDEX = 4;
const SWEEP_MAXIMUM_TICKS = 9;
const PRICE_MAXIMUM_TICKS = 10;
const MARKER_ROW_HEIGHT = 16;
const MARKER_MAXIMUM_ROWS = 2;
const MARKER_TEXT_GAP = 4;
const MARKER_KIND_TEXT = Object.freeze({ day_end: "當日結束", horizon_end: "預測期末" });

/**
 * 澳幣金額，負數以「−」開頭。
 *
 * @param {number} numeric_value 金額
 * @returns {string} 例如 `A$1,234`
 */
export function format_aud(numeric_value) {
  return `${numeric_value < 0 ? "−" : ""}A$${format_number(Math.abs(numeric_value))}`;
}

/**
 * 讀取 CSS 色彩變數，讓圖表跟著淺色或深色主題。
 *
 * @param {string} token_name 變數名稱，例如 `--charge`
 * @returns {string} 色彩值
 */
function read_css_token(token_name) {
  return getComputedStyle(document.documentElement).getPropertyValue(token_name).trim();
}

/**
 * 畫建議充放電計畫的卡片。
 *
 * @param {HTMLElement} plan_container 卡片容器
 * @param {{segment_length: number, energy_mwh: number, cycles: object[]}} plan_result 建議計畫
 * @param {{interval_end_minute: number, price: number}[]} price_points 預測電價
 */
export function render_plan_steps(plan_container, plan_result, price_points) {
  if (plan_result.cycles.length === 0) {
    plan_container.innerHTML = `<div class="step d"><div class="t">建議</div><div class="v">預測期間內不建議充放電</div><div class="s">沒有任何一組充放電的價差為正，且不低於每循環最低價差。</div></div>`;
    return;
  }
  plan_container.innerHTML = plan_result.cycles
    .map((planned_cycle, cycle_index) => build_cycle_html(planned_cycle, cycle_index, plan_result, price_points))
    .join("");
}

/**
 * 一個循環的三張卡片（開始充電、開始放電、預估淨收益）。
 *
 * @param {object} planned_cycle 循環
 * @param {number} cycle_index 第幾個循環（從 0 起算）
 * @param {{segment_length: number, energy_mwh: number}} plan_result 建議計畫
 * @param {{interval_end_minute: number, price: number}[]} price_points 預測電價
 * @returns {string} HTML
 */
function build_cycle_html(planned_cycle, cycle_index, plan_result, price_points) {
  const cycle_number = cycle_index + 1;
  const charge_window = describe_window(price_points, planned_cycle.charge_start_index, plan_result.segment_length);
  const discharge_window = describe_window(price_points, planned_cycle.discharge_start_index, plan_result.segment_length);
  const price_spread = planned_cycle.discharge_average_price - planned_cycle.charge_average_price;
  return `<div class="step"><div class="t">第 ${cycle_number} 次｜開始充電</div><div class="v">${charge_window.start_label}</div><div class="s">至 ${charge_window.end_label}，均價 ${format_aud(planned_cycle.charge_average_price)}；建議充電價格上限 ${format_aud(Math.ceil(charge_window.highest_price))}</div></div>
    <div class="step d"><div class="t">第 ${cycle_number} 次｜開始放電</div><div class="v">${discharge_window.start_label}</div><div class="s">至 ${discharge_window.end_label}，均價 ${format_aud(planned_cycle.discharge_average_price)}；建議放電價格下限 ${format_aud(Math.floor(discharge_window.lowest_price))}</div></div>
    <div class="step" style="border-left-color:var(--ink-3)"><div class="t">第 ${cycle_number} 次｜預估淨收益</div><div class="v">${format_aud(planned_cycle.net_value)}</div><div class="s">價差 ${format_aud(price_spread)}/MWh，放電 ${format_number(plan_result.energy_mwh, 1)} MWh</div></div>`;
}

/**
 * 窗口的起訖標籤與最高、最低價。
 *
 * @param {{interval_end_minute: number, price: number}[]} price_points 預測電價
 * @param {number} start_index 窗口第一個時段
 * @param {number} segment_length 窗口時段數
 * @returns {{start_label: string, end_label: string, highest_price: number, lowest_price: number}}
 */
function describe_window(price_points, start_index, segment_length) {
  const window_points = price_points.slice(start_index, start_index + segment_length);
  const window_prices = window_points.map((price_point) => price_point.price);
  return {
    start_label: format_nem_label(interval_start_minute(window_points[0].interval_end_minute)),
    end_label: format_nem_label(window_points.at(-1).interval_end_minute),
    highest_price: Math.max(...window_prices),
    lowest_price: Math.min(...window_prices),
  };
}

/**
 * 畫 KPI 列。
 *
 * @param {HTMLElement} kpi_container KPI 容器
 * @param {import("./threshold_dispatch.js").DispatchResult} dispatch_result 自訂條件的模擬結果
 * @param {number} suggested_total_value 建議計畫的預估淨收益
 */
export function render_kpi_row(kpi_container, dispatch_result, suggested_total_value) {
  const kpi_items = [
    { label: "自訂條件預估淨收益", value: format_aud(dispatch_result.net_value), detail: `放電收入 ${format_aud(dispatch_result.discharge_revenue)}，充電成本 ${format_aud(dispatch_result.charge_cost)}` },
    { label: "建議計畫預估淨收益", value: format_aud(suggested_total_value), detail: `差異 ${format_aud(dispatch_result.net_value - suggested_total_value)}` },
    { label: "充電／放電電量", value: `${format_number(dispatch_result.charged_energy_mwh, 1)} / ${format_number(dispatch_result.discharged_energy_mwh, 1)} MWh`, detail: "來回效率 100%，不計損耗" },
    { label: "預測期末電量", value: `${format_number(dispatch_result.final_soc_fraction * 100)}%`, detail: dispatch_result.final_soc_fraction > 0.05 ? "仍有電量等待之後的高價" : "已放完" },
  ];
  kpi_container.innerHTML = kpi_items
    .map((kpi_item) => `<div class="panel kpi"><div class="k">${kpi_item.label}</div><div class="v">${kpi_item.value}</div><div class="s">${kpi_item.detail}</div></div>`)
    .join("");
}

/**
 * 畫預調度電價圖，含自訂條件下的充放電區間、兩條門檻線，以及當日結束與預測期末仍有電時的剩餘電量。
 *
 * @param {HTMLCanvasElement} chart_canvas 畫布
 * @param {object | null} previous_chart 上一次的圖表，會先銷毀
 * @param {{price_points: object[], interval_energy_mwh: number[], charge_price_cap: number, discharge_price_floor: number, remaining_markers: import("./threshold_dispatch.js").RemainingEnergyMarker[]}} chart_input 資料
 * @returns {object} 新的 Chart.js 圖表
 */
export function draw_price_chart(chart_canvas, previous_chart, chart_input) {
  const price_values = chart_input.price_points.map((price_point) => price_point.price);
  const axis_minimum = Math.min(...price_values, chart_input.charge_price_cap) - CHART_VALUE_PADDING;
  const axis_maximum = Math.max(...price_values, chart_input.discharge_price_floor) + CHART_VALUE_PADDING;
  const action_bars = (direction_sign, bar_color) => ({
    type: "bar",
    data: chart_input.interval_energy_mwh.map((energy_change) => (direction_sign * energy_change > 0 ? [Math.min(0, axis_minimum), axis_maximum] : null)),
    backgroundColor: bar_color, barPercentage: 1, categoryPercentage: 1, grouped: false, inflateAmount: 0, order: 3,
  });
  const threshold_line = (threshold_value, line_color) => ({
    data: price_values.map(() => threshold_value), borderColor: line_color, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, order: 2,
  });
  const chart_configuration = {
    type: "line",
    data: {
      labels: chart_input.price_points.map((price_point) => format_nem_label(interval_start_minute(price_point.interval_end_minute))),
      datasets: [
        action_bars(1, read_css_token("--charge-soft")),
        action_bars(-1, read_css_token("--discharge-soft")),
        threshold_line(chart_input.charge_price_cap, read_css_token("--charge")),
        threshold_line(chart_input.discharge_price_floor, read_css_token("--discharge")),
        { data: price_values, borderColor: read_css_token("--line"), borderWidth: 2, pointRadius: 0, stepped: "before", order: 1 },
      ],
    },
    options: build_price_chart_options(axis_minimum, axis_maximum, chart_input.remaining_markers),
    plugins: [REMAINING_ENERGY_PLUGIN],
  };
  previous_chart?.destroy();
  return new window.Chart(chart_canvas, chart_configuration);
}

/**
 * 剩餘電量標籤文字。
 *
 * @param {import("./threshold_dispatch.js").RemainingEnergyMarker} remaining_marker 標示點
 * @returns {string} 例如「當日結束 剩餘 5.0 MWh（25%）」
 */
export function format_remaining_energy_label(remaining_marker) {
  return `${MARKER_KIND_TEXT[remaining_marker.marker_kind]} 剩餘 ${format_number(remaining_marker.stored_energy_mwh, 1)} MWh（${format_number(remaining_marker.stored_fraction * 100)}%）`;
}

/** Chart.js 外掛：在時段結束處畫虛線，並在圖表上方的保留帶寫剩餘電量；標籤重疊時往上一列。 */
const REMAINING_ENERGY_PLUGIN = Object.freeze({
  id: "remaining_energy_markers",
  afterDatasetsDraw(chart_instance, _draw_arguments, plugin_options) {
    const remaining_markers = plugin_options.markers ?? [];
    if (remaining_markers.length === 0) return;
    const drawing_context = chart_instance.ctx;
    const chart_area = chart_instance.chartArea;
    const category_width = chart_instance.scales.x.width / chart_instance.data.labels.length;
    const placed_boxes = [];
    drawing_context.save();
    drawing_context.font = plugin_options.font_text;
    drawing_context.textBaseline = "bottom";
    for (const remaining_marker of remaining_markers) {
      const marker_x = chart_instance.scales.x.getPixelForValue(remaining_marker.interval_index) + category_width / 2;
      draw_marker_line(drawing_context, chart_area, marker_x, plugin_options.line_color);
      const label_box = place_marker_label(drawing_context, chart_area, marker_x, format_remaining_energy_label(remaining_marker), placed_boxes);
      drawing_context.fillStyle = plugin_options.text_color;
      drawing_context.fillText(label_box.label_text, label_box.left_x, label_box.bottom_y);
      placed_boxes.push(label_box);
    }
    drawing_context.restore();
  },
});

/**
 * 在時段結束處畫一條垂直虛線。
 *
 * @param {CanvasRenderingContext2D} drawing_context 畫布
 * @param {{top: number, bottom: number}} chart_area 繪圖區
 * @param {number} marker_x 橫座標
 * @param {string} line_color 線色
 */
function draw_marker_line(drawing_context, chart_area, marker_x, line_color) {
  drawing_context.strokeStyle = line_color;
  drawing_context.lineWidth = 1;
  drawing_context.setLineDash([3, 3]);
  drawing_context.beginPath();
  drawing_context.moveTo(marker_x, chart_area.top - MARKER_TEXT_GAP);
  drawing_context.lineTo(marker_x, chart_area.bottom);
  drawing_context.stroke();
  drawing_context.setLineDash([]);
}

/**
 * 決定標籤位置：靠右邊界時改放在虛線左側；和已放的標籤重疊就往上一列。
 *
 * @param {CanvasRenderingContext2D} drawing_context 畫布（用來量字寬）
 * @param {{top: number, left: number, right: number}} chart_area 繪圖區
 * @param {number} marker_x 虛線橫座標
 * @param {string} label_text 文字
 * @param {{left_x: number, right_x: number, row_index: number}[]} placed_boxes 已放的標籤
 * @returns {{label_text: string, left_x: number, right_x: number, bottom_y: number, row_index: number}} 標籤位置
 */
function place_marker_label(drawing_context, chart_area, marker_x, label_text, placed_boxes) {
  const text_width = drawing_context.measureText(label_text).width;
  const fits_on_right = marker_x + MARKER_TEXT_GAP + text_width <= chart_area.right;
  const left_x = fits_on_right ? marker_x + MARKER_TEXT_GAP : Math.max(chart_area.left, marker_x - MARKER_TEXT_GAP - text_width);
  const right_x = left_x + text_width;
  let row_index = 0;
  const overlaps_row = (candidate_row) => placed_boxes.some((placed_box) => placed_box.row_index === candidate_row && left_x < placed_box.right_x + MARKER_TEXT_GAP && placed_box.left_x < right_x + MARKER_TEXT_GAP);
  while (row_index < MARKER_MAXIMUM_ROWS - 1 && overlaps_row(row_index)) row_index++;
  return { label_text, left_x, right_x, bottom_y: chart_area.top - MARKER_TEXT_GAP - row_index * MARKER_ROW_HEIGHT, row_index };
}

/**
 * 電價圖的座標軸與提示框設定。
 *
 * @param {number} axis_minimum 縱軸下限
 * @param {number} axis_maximum 縱軸上限
 * @param {import("./threshold_dispatch.js").RemainingEnergyMarker[]} remaining_markers 剩餘電量標示點
 * @returns {object} Chart.js options
 */
function build_price_chart_options(axis_minimum, axis_maximum, remaining_markers) {
  const tick_color = read_css_token("--ink-3");
  const marker_rows = Math.min(remaining_markers.length, MARKER_MAXIMUM_ROWS);
  return {
    responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
    layout: { padding: { top: marker_rows * MARKER_ROW_HEIGHT + MARKER_TEXT_GAP } },
    plugins: {
      legend: { display: false },
      remaining_energy_markers: {
        markers: remaining_markers,
        line_color: read_css_token("--ink-3"),
        text_color: read_css_token("--ink-2"),
        font_text: `500 12px ${getComputedStyle(document.body).fontFamily}`,
      },
      tooltip: { filter: (tooltip_item) => tooltip_item.datasetIndex === PRICE_DATASET_INDEX, callbacks: { label: (tooltip_item) => `電價 ${format_aud(tooltip_item.parsed.y)}/MWh` } },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: tick_color, maxRotation: 0, autoSkip: true, maxTicksLimit: PRICE_MAXIMUM_TICKS } },
      y: { min: axis_minimum, max: axis_maximum, grid: { color: read_css_token("--rule") }, ticks: { color: tick_color }, title: { display: true, text: "AUD/MWh", color: tick_color } },
    },
  };
}

/**
 * 畫「價差 vs 預估淨收益」掃描圖，並標出目前設定。
 *
 * @param {HTMLCanvasElement} chart_canvas 畫布
 * @param {object | null} previous_chart 上一次的圖表，會先銷毀
 * @param {{price_spread: number, net_value: number}[]} sweep_points 掃描結果
 * @param {number} current_spread 目前的價差設定
 * @returns {object} 新的 Chart.js 圖表
 */
export function draw_sweep_chart(chart_canvas, previous_chart, sweep_points, current_spread) {
  const nearest_index = sweep_points.reduce(
    (best_index, sweep_point, point_index) =>
      Math.abs(sweep_point.price_spread - current_spread) < Math.abs(sweep_points[best_index].price_spread - current_spread) ? point_index : best_index,
    0,
  );
  const tick_color = read_css_token("--ink-3");
  const net_values = sweep_points.map((sweep_point) => sweep_point.net_value);
  const chart_configuration = {
    type: "line",
    data: {
      labels: sweep_points.map((sweep_point) => format_number(sweep_point.price_spread)),
      datasets: [
        { data: net_values, borderColor: read_css_token("--charge"), borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { data: net_values.map((net_value, point_index) => (point_index === nearest_index ? net_value : null)), pointRadius: 6, pointStyle: "rectRot", pointBackgroundColor: read_css_token("--discharge"), showLine: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { title: (tooltip_items) => `價差 A$${tooltip_items[0].label}`, label: (tooltip_item) => `${tooltip_item.datasetIndex ? "目前設定" : "預估淨收益"} ${format_aud(tooltip_item.parsed.y)}` } } },
      scales: {
        x: { title: { display: true, text: "高低價差（AUD/MWh）", color: tick_color }, grid: { display: false }, ticks: { color: tick_color, maxTicksLimit: SWEEP_MAXIMUM_TICKS, maxRotation: 0 } },
        y: { grid: { color: read_css_token("--rule") }, ticks: { color: tick_color }, title: { display: true, text: "預估淨收益（AUD）", color: tick_color } },
      },
    },
  };
  previous_chart?.destroy();
  return new window.Chart(chart_canvas, chart_configuration);
}
