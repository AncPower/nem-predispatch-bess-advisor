/**
 * 每日摘要 `data/daily_summary.json`（#30、roadmap L1）：讀取並驗證網頁用到的欄位。
 *
 * 檔案由離線分析層 `analysis/build_daily_summary.py` 產生；這裡只檢查格式，不重算。
 * 欄位缺漏、型別不符或日期沒有依序排列時直接報錯，不略過、不補值。
 */

import { fetch_json_with_retry } from "./http_request.js";

export const SUPPORTED_SCHEMA_VERSION = 1;
export const DAILY_SUMMARY_URL = new URL("../data/daily_summary.json", import.meta.url).href;

const FILE_LABEL = "data/daily_summary.json";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {object} DailySummaryDay
 * @property {string} date 交易日（YYYY-MM-DD）
 * @property {boolean} excluded 是否因資料不完整而排除
 * @property {string | null} exclusion_reason 排除原因，未排除為 null
 * @property {number | null} net_value_aud 當天最佳計畫的淨收益（AUD），排除時為 null
 * @property {number | null} best_spread_aud_per_mwh 各循環價差的最小值，沒有循環或排除時為 null
 * @property {readonly object[]} cycles 各循環的原始內容（本模組不驗證內部欄位）
 */

/**
 * @typedef {object} DailySummary
 * @property {string} region_id 區域
 * @property {string} generated_at 產生時間
 * @property {readonly DailySummaryDay[]} days 每日資料，依日期排序
 */

/**
 * 讀取並驗證每日摘要，遇到暫時性錯誤退避重試（見 `http_request.fetch_json_with_retry`）。
 *
 * @param {Partial<import("./http_request.js").RequestOptions>} [request_options] 可替換的 fetch、等待與逾時
 * @returns {Promise<DailySummary>} 每日摘要
 * @throws {Error} 讀不到檔案、不是合法 JSON，或內容不合法時
 */
export async function fetch_daily_summary(request_options = {}) {
  let summary_payload;
  try {
    summary_payload = await fetch_json_with_retry(DAILY_SUMMARY_URL, { cache: "no-store" }, { source_label: FILE_LABEL, ...request_options });
  } catch (request_error) {
    if (!(request_error instanceof SyntaxError)) throw request_error;
    throw new Error(`${FILE_LABEL} 不是合法的 JSON：${request_error.message}`, { cause: request_error });
  }
  return parse_daily_summary(summary_payload);
}

/**
 * 驗證每日摘要。
 *
 * @param {unknown} summary_payload JSON 內容
 * @returns {DailySummary} 每日摘要
 * @throws {Error} 不是物件、版本不符、`days` 為空，或任何一天不合法時
 */
export function parse_daily_summary(summary_payload) {
  if (typeof summary_payload !== "object" || summary_payload === null || Array.isArray(summary_payload)) {
    throw new Error(`${FILE_LABEL} 必須是 JSON 物件`);
  }
  if (summary_payload.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`${FILE_LABEL} 的 schema_version 必須是 ${SUPPORTED_SCHEMA_VERSION}：${JSON.stringify(summary_payload.schema_version)}`);
  }
  for (const field_name of ["region_id", "generated_at"]) {
    if (typeof summary_payload[field_name] !== "string" || summary_payload[field_name] === "") {
      throw new Error(`${FILE_LABEL} 的 ${field_name} 必須是非空白文字`);
    }
  }
  if (!Array.isArray(summary_payload.days) || summary_payload.days.length === 0) throw new Error(`${FILE_LABEL} 的 days 必須是非空陣列`);
  const days = summary_payload.days.map((day_payload, day_index) => parse_day(day_payload, day_index));
  for (let day_index = 1; day_index < days.length; day_index++) {
    if (days[day_index].date <= days[day_index - 1].date) {
      throw new Error(`${FILE_LABEL} 的 days 必須依日期遞增排列：第 ${day_index + 1} 筆 ${days[day_index].date} 不晚於前一筆`);
    }
  }
  return Object.freeze({ region_id: summary_payload.region_id, generated_at: summary_payload.generated_at, days: Object.freeze(days) });
}

/**
 * 驗證一天。
 *
 * @param {unknown} day_payload `days[]` 的一筆
 * @param {number} day_index 位置（錯誤訊息用）
 * @returns {DailySummaryDay} 一天
 * @throws {Error} 欄位不合法時
 */
function parse_day(day_payload, day_index) {
  const day_label = `${FILE_LABEL} 的 days 第 ${day_index + 1} 筆`;
  if (typeof day_payload !== "object" || day_payload === null) throw new Error(`${day_label}必須是物件`);
  const { date, excluded, exclusion_reason, net_value_aud, best_spread_aud_per_mwh, cycles } = day_payload;
  if (typeof date !== "string" || !ISO_DATE_PATTERN.test(date)) throw new Error(`${day_label}的 date 必須是 YYYY-MM-DD：${JSON.stringify(date)}`);
  if (typeof excluded !== "boolean") throw new Error(`${day_label}（${date}）的 excluded 必須是 true 或 false`);
  if (!Array.isArray(cycles)) throw new Error(`${day_label}（${date}）的 cycles 必須是陣列`);
  if (excluded) {
    if (typeof exclusion_reason !== "string" || exclusion_reason === "") throw new Error(`${day_label}（${date}）被排除，必須寫明 exclusion_reason`);
    if (net_value_aud !== null) throw new Error(`${day_label}（${date}）被排除，net_value_aud 必須是 null`);
  } else {
    if (exclusion_reason !== null) throw new Error(`${day_label}（${date}）未排除，exclusion_reason 必須是 null`);
    if (!is_finite_number(net_value_aud)) throw new Error(`${day_label}（${date}）的 net_value_aud 必須是數值：${JSON.stringify(net_value_aud)}`);
  }
  if (best_spread_aud_per_mwh !== null && !is_finite_number(best_spread_aud_per_mwh)) {
    throw new Error(`${day_label}（${date}）的 best_spread_aud_per_mwh 必須是數值或 null`);
  }
  return Object.freeze({ date, excluded, exclusion_reason, net_value_aud, best_spread_aud_per_mwh, cycles: Object.freeze([...cycles]) });
}

/**
 * 是否為有限數值。
 *
 * @param {unknown} field_value 值
 * @returns {boolean} 結果
 */
function is_finite_number(field_value) {
  return typeof field_value === "number" && Number.isFinite(field_value);
}
