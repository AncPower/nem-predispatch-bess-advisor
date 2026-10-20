/**
 * 價差標準檢討（#32）的畫面：結論、KPI、說明清單與「標準 vs 歷史淨收益」圖。只負責顯示，不做計算。
 *
 * 文字一律以 textContent 寫入；圖表使用全域的 Chart.js（由 scenario/index.html 從 cdnjs 載入）。
 */

import { format_money, format_number } from "./number_format.js";
import { RETENTION_TARGET } from "./spread_review.js";

const CURRENCY_CODE = "AUD";
const PRICE_UNIT = "AUD/MWh";
const PERCENT_DECIMALS = 2;
const SPREAD_DECIMALS = 2;
const RETENTION_PERCENT_TEXT = `${RETENTION_TARGET * 100}%`;

/**
 * @typedef {object} ReviewContext
 * @property {string} start_date 起日
 * @property {string} end_date 迄日
 * @property {string} event_view_label 事件檢視的顯示名稱
 * @property {readonly string[]} event_removed_dates 因事件檢視而移除的日期
 * @property {import("./shared_configuration.js").SpreadStandard} spread_standard 目前的價差標準設定
 * @property {import("./shared_configuration.js").BatteryConfiguration | null} battery_configuration 設備參數，讀不到時為 null
 * @property {string} battery_error 設備參數的讀取錯誤，沒有錯誤為空字串
 * @property {ReturnType<typeof import("./spread_review.js").summarize_break_even_spreads>} cost_summary 損益兩平價差摘要
 * @property {boolean} [is_trial] 檢討用的是試算標準（輸入欄），不是設定檔的目前標準
 * @property {import("./shared_configuration.js").BatteryConfiguration | null} [configured_battery] 試算設備參數時，設定檔原本的設備參數；沒有試算時為 null
 */

/**
 * @typedef {object} ReviewDescription
 * @property {string} title_text 結論標題
 * @property {string} body_text 結論說明
 * @property {{label: string, value: string, detail: string}[]} kpi_items KPI
 * @property {string[]} note_lines 期間、排除日期、提示與成本說明
 */

/**
 * 把檢討結果轉成畫面文字（純函式，方便測試）。
 *
 * @param {import("./spread_review.js").SpreadReview} spread_review 檢討結果
 * @param {ReviewContext} review_context 期間、檢視與設定
 * @returns {ReviewDescription} 畫面文字
 */
export function describe_spread_review(spread_review, review_context) {
  const is_trial = review_context.is_trial === true;
  const is_any_trial = is_trial || Boolean(review_context.configured_battery);
  const standard_label = standard_label_for(is_trial);
  const current_text = `${format_standard(spread_review.current_standard)} ${PRICE_UNIT}`;
  const configured_text = `${format_standard(review_context.spread_standard.spread_standard_aud_per_mwh)} ${PRICE_UNIT}`;
  const verdict_copy = build_verdict_copy(spread_review, `${standard_label} ${current_text}`, is_trial, is_any_trial);
  const kpi_items = [{
    label: standard_label,
    value: current_text,
    detail: is_trial ? `未寫入設定；目前標準 ${configured_text}` : `${review_context.spread_standard.effective_date} 生效`,
  }];
  if (spread_review.status === "keep" || spread_review.status === "lower") {
    const current_outcome = spread_review.current_outcome;
    kpi_items.push(
      {
        label: "歷史收益保留率",
        value: format_percent(current_outcome.retention_ratio),
        detail: `${format_money(current_outcome.net_value_aud, CURRENCY_CODE)}／最高 ${format_money(spread_review.maximum_value_aud, CURRENCY_CODE)}`,
      },
      { label: "執行天數", value: `${current_outcome.executed_day_count} 天`, detail: `有效 ${spread_review.valid_day_count} 天` },
      { label: "錯過的機會", value: `${current_outcome.skipped_day_count} 天`, detail: `潛在收益 ${format_money(current_outcome.skipped_value_aud, CURRENCY_CODE)}` },
      {
        label: `保留 ${RETENTION_PERCENT_TEXT} 的門檻上限`,
        value: `${format_standard(spread_review.highest_retained_standard)} ${PRICE_UNIT}`,
        detail: `0 至此值都保留至少 ${RETENTION_PERCENT_TEXT}`,
      },
    );
  } else {
    kpi_items.push({ label: "有效天數", value: `${spread_review.valid_day_count} 天`, detail: "不提供調整建議" });
  }
  return { ...verdict_copy, kpi_items, note_lines: build_note_lines(spread_review, review_context, configured_text) };
}

/**
 * 寫入結論、KPI 與說明清單。
 *
 * @param {{title_element: HTMLElement, text_element: HTMLElement, kpi_container: HTMLElement, notes_list: HTMLElement}} review_elements 元素
 * @param {ReviewDescription} review_description `describe_spread_review` 的結果
 */
export function render_spread_review(review_elements, review_description) {
  review_elements.title_element.textContent = review_description.title_text;
  review_elements.text_element.textContent = review_description.body_text;
  review_elements.kpi_container.replaceChildren(...review_description.kpi_items.map((kpi_item) => {
    const kpi_element = document.createElement("div");
    kpi_element.className = "kpi";
    for (const [class_name, text_value] of [["k", kpi_item.label], ["v", kpi_item.value], ["s", kpi_item.detail]]) {
      const line_element = document.createElement("div");
      line_element.className = class_name;
      line_element.textContent = text_value;
      kpi_element.append(line_element);
    }
    return kpi_element;
  }));
  review_elements.notes_list.replaceChildren(...review_description.note_lines.map((note_line) => {
    const item_element = document.createElement("li");
    item_element.textContent = note_line;
    return item_element;
  }));
}

/**
 * 畫「價差標準 vs 歷史淨收益」：每個候選標準一點，標出目前（或試算）標準與最高值 × `RETENTION_TARGET` 的水平線。
 *
 * @param {HTMLCanvasElement} chart_canvas 畫布
 * @param {object | null} previous_chart 上一次的圖表
 * @param {import("./spread_review.js").SpreadReview} spread_review 檢討結果
 * @param {boolean} [is_trial] 標記的是試算標準
 * @returns {object | null} 新的 Chart.js 圖表；沒有候選標準時不畫，回傳 null
 */
export function draw_spread_review_chart(chart_canvas, previous_chart, spread_review, is_trial = false) {
  previous_chart?.destroy();
  if (spread_review.sweep_points.length === 0) return null;
  const series_names = ["歷史淨收益", standard_label_for(is_trial), `最高值的 ${RETENTION_PERCENT_TEXT}`];
  const tick_color = read_css_token("--ink-3");
  const last_standard = spread_review.sweep_points.at(-1).spread_standard;
  const retention_value = spread_review.maximum_value_aud * RETENTION_TARGET;
  const chart_configuration = {
    type: "line",
    data: {
      datasets: [
        {
          data: spread_review.sweep_points.map((sweep_point) => ({ x: sweep_point.spread_standard, y: sweep_point.net_value_aud })),
          borderColor: read_css_token("--charge"), borderWidth: 2, pointRadius: 0, stepped: "after",
        },
        {
          data: spread_review.current_outcome ? [{ x: spread_review.current_standard, y: spread_review.current_outcome.net_value_aud }] : [],
          pointRadius: 6, pointStyle: "rectRot", pointBackgroundColor: read_css_token("--discharge"), showLine: false,
        },
        {
          data: [{ x: 0, y: retention_value }, { x: last_standard, y: retention_value }],
          borderColor: read_css_token("--cut"), borderWidth: 1, borderDash: [6, 4], pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (tooltip_items) => `價差標準 ${format_standard(tooltip_items[0].parsed.x)} ${PRICE_UNIT}`,
            label: (tooltip_item) => `${series_names[tooltip_item.datasetIndex]}：${format_money(tooltip_item.parsed.y, CURRENCY_CODE)}`,
          },
        },
      },
      scales: {
        x: { type: "linear", min: 0, max: last_standard, title: { display: true, text: `價差標準（${PRICE_UNIT}）`, color: tick_color }, grid: { display: false }, ticks: { color: tick_color, maxTicksLimit: 9, maxRotation: 0 } },
        y: { title: { display: true, text: `期間淨收益（${CURRENCY_CODE}）`, color: tick_color }, grid: { color: read_css_token("--rule") }, ticks: { color: tick_color, callback: (tick_value) => format_number(tick_value) } },
      },
    },
  };
  return new window.Chart(chart_canvas, chart_configuration);
}

/**
 * 結論的標題與說明。
 *
 * @param {import("./spread_review.js").SpreadReview} spread_review 檢討結果
 * @param {string} standard_text 標準名稱與數值，例如「目前標準 50 AUD/MWh」
 * @param {boolean} is_trial 標準是否為試算
 * @param {boolean} is_any_trial 標準或設備參數是否有任何一項是試算
 * @returns {{title_text: string, body_text: string}} 文字
 */
function build_verdict_copy(spread_review, standard_text, is_trial, is_any_trial) {
  if (spread_review.status === "no_data") {
    return { title_text: "選定期間沒有可用的日子，不提供調整建議", body_text: "請調整期間或事件檢視；資料不完整而排除的日子不納入檢討。" };
  }
  if (spread_review.status === "no_revenue") {
    return {
      title_text: "選定期間沒有正收益的日子，不提供調整建議",
      body_text: `有效 ${spread_review.valid_day_count} 天都沒有扣除效率損失與損耗後收益為正的計畫，任何標準的歷史淨收益都是 0。`,
    };
  }
  const outcome = spread_review.current_outcome;
  const highest_text = `${format_standard(spread_review.highest_retained_standard)} ${PRICE_UNIT}`;
  const caveat_text = `這是歷史最佳計畫（事後電價）的保留率，不代表實際營運收益最高。${is_any_trial ? "試算值未寫入設定檔。" : ""}`;
  const prefix_text = is_any_trial ? "試算・" : "";
  if (spread_review.status === "keep") {
    return {
      title_text: `${prefix_text}維持：${standard_text} 保留 ${format_percent(outcome.retention_ratio)} 的歷史可得收益`,
      body_text: `門檻設在 0 至 ${highest_text} 之間都能保留至少 ${RETENTION_PERCENT_TEXT}。${caveat_text}`,
    };
  }
  return {
    title_text: `${prefix_text}建議下調：${standard_text} 只保留 ${format_percent(outcome.retention_ratio)} 的歷史可得收益`,
    body_text: `要保留至少 ${RETENTION_PERCENT_TEXT}，門檻需不高於 ${highest_text}；${standard_label_for(is_trial)}錯過 ${outcome.skipped_day_count} 天，潛在收益 ${format_money(outcome.skipped_value_aud, CURRENCY_CODE)}。${caveat_text}`,
  };
}

/**
 * 說明清單：期間與檢視、排除的日期、樣本提示、判斷規則、成本說明、設定來源。
 *
 * @param {import("./spread_review.js").SpreadReview} spread_review 檢討結果
 * @param {ReviewContext} review_context 期間、檢視與設定
 * @param {string} configured_text 設定檔目前標準的顯示文字
 * @returns {string[]} 文字行
 */
function build_note_lines(spread_review, review_context, configured_text) {
  const data_excluded = spread_review.data_excluded_days;
  const event_removed = review_context.event_removed_dates;
  const spread_standard = review_context.spread_standard;
  return [
    `期間 ${review_context.start_date} 至 ${review_context.end_date}，事件檢視「${review_context.event_view_label}」；有效 ${spread_review.valid_day_count} 天。`,
    data_excluded.length === 0
      ? "資料不完整而排除：無。"
      : `資料不完整而排除 ${data_excluded.length} 天：${data_excluded.map((excluded_day) => `${excluded_day.date}（${excluded_day.reason}）`).join("、")}。`,
    event_removed.length === 0 ? "依事件檢視排除：無。" : `依事件檢視排除 ${event_removed.length} 天：${event_removed.join("、")}。`,
    ...spread_review.warnings.map((warning_text) => `注意：${warning_text}`),
    "判斷規則：當天每個循環的價差都達到標準才執行當天的最佳計畫，否則當天不做；不重新選窗、不跨日持有。",
    `資料完整但扣除效率損失與損耗後沒有正收益組合的日子：${spread_review.no_plan_day_count} 天（任何標準下都不做）。`,
    build_cost_line(review_context),
    ...(review_context.is_trial
      ? [`試算中：結論、指標與圖上標記改用試算標準，清空輸入欄即回到目前標準 ${configured_text}；試算值不會寫入設定檔。`]
      : []),
    ...(review_context.configured_battery ? [build_cost_trial_line(review_context)] : []),
    `目前標準 ${configured_text} 取自 config/spread_standard.json：${spread_standard.effective_date} 生效，檢討人 ${spread_standard.reviewer_name}。頁面不會修改這個檔；要調整請開 PR 並附上這裡的檢討結果。`,
  ];
}

/**
 * 損益兩平價差的成本說明（不是門檻）。
 *
 * @param {ReviewContext} review_context 設備參數與摘要
 * @returns {string} 文字
 */
function build_cost_line(review_context) {
  if (review_context.battery_error) return `無法讀取設備參數，未顯示損益兩平價差：${review_context.battery_error}`;
  const cost_summary = review_context.cost_summary;
  if (!review_context.battery_configuration || !cost_summary) return "損益兩平價差：選定期間沒有任何循環，無法計算。";
  const battery_configuration = review_context.battery_configuration;
  const parameter_text = `來回效率 ${format_number(battery_configuration.round_trip_efficiency * 100, 1)}%、損耗 ${format_number(battery_configuration.degradation_cost_aud_per_mwh, SPREAD_DECIMALS)} ${PRICE_UNIT}、MLF ${format_number(battery_configuration.marginal_loss_factor, 3)}`;
  const range_text = `中位數 ${format_number(cost_summary.median, SPREAD_DECIMALS)}，範圍 ${format_number(cost_summary.minimum, SPREAD_DECIMALS)} 至 ${format_number(cost_summary.maximum, SPREAD_DECIMALS)} ${PRICE_UNIT}`;
  const parameter_label = review_context.configured_battery ? "試算設備參數" : "目前設備參數";
  return `損益兩平價差＝充電均價 ×（1 ÷ 來回效率 − 1）＋ 損耗成本 ÷ MLF。${parameter_label}（${parameter_text}）下，${cost_summary.cycle_count} 個循環的損益兩平價差${range_text}；價差低於這個值，扣除成本後就沒有收益。這是成本說明，不是門檻。`;
}

/**
 * 試算設備參數的說明：列出設定檔原值，並說明沿用原本時段重算的限制。
 *
 * @param {ReviewContext} review_context 設備參數（試算後）與設定檔原值
 * @returns {string} 文字
 */
function build_cost_trial_line(review_context) {
  const configured_battery = review_context.configured_battery;
  const configured_text = `來回效率 ${format_number(configured_battery.round_trip_efficiency * 100, 1)}%、損耗 ${format_number(configured_battery.degradation_cost_aud_per_mwh, SPREAD_DECIMALS)} ${PRICE_UNIT}`;
  return `試算設備參數：設定檔為${configured_text}。淨收益沿用每日摘要原本的充放電時段重算、不重新選窗，所以是新參數下的下限估計；淨收益不為正的循環不做，原本沒有計畫的日子不會因新參數而出現。清空輸入欄即回到設定值；試算值不會寫入 config/battery.json。`;
}

/**
 * 標準的名稱：試算時為「試算標準」，否則為「目前標準」。
 *
 * @param {boolean} is_trial 是否為試算
 * @returns {string} 名稱
 */
function standard_label_for(is_trial) {
  return is_trial ? "試算標準" : "目前標準";
}

/**
 * 價差標準的顯示文字：整數不帶小數，非整數到小數第 2 位。
 *
 * @param {number} standard_value 價差標準（AUD/MWh）
 * @returns {string} 例如「50」「50.50」
 */
function format_standard(standard_value) {
  return Number.isInteger(standard_value) ? format_number(standard_value) : format_number(standard_value, SPREAD_DECIMALS);
}

/**
 * 比例轉百分比文字。
 *
 * @param {number | null} ratio_value 比例
 * @returns {string} 例如「98.75%」；沒有值時為「—」
 */
function format_percent(ratio_value) {
  return ratio_value === null ? "—" : `${format_number(ratio_value * 100, PERCENT_DECIMALS)}%`;
}

/**
 * 讀取 CSS 色彩變數，讓圖表跟著淺色或深色主題。
 *
 * @param {string} token_name 變數名稱
 * @returns {string} 色彩值
 */
function read_css_token(token_name) {
  return getComputedStyle(document.documentElement).getPropertyValue(token_name).trim();
}
