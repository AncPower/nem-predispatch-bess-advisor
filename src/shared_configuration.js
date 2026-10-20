/**
 * 兩頁與分析層共用的設定檔：`config/battery.json`（設備參數）與 `config/spread_standard.json`（價差標準）。
 *
 * 欄位缺漏、多出未知欄位或數值不合理時直接報錯，不套預設值；要改值就改設定檔並開 PR。
 * Python 端的同一份驗證在 `analysis/battery_configuration.py`。
 */

import { fetch_json_with_retry } from "./http_request.js";

export const SUPPORTED_SCHEMA_VERSION = 1;
export const BATTERY_CONFIGURATION_URL = new URL("../config/battery.json", import.meta.url).href;

const BATTERY_FILE_LABEL = "config/battery.json";
const SPREAD_STANDARD_FILE_LABEL = "config/spread_standard.json";
const BATTERY_FIELD_NAMES = Object.freeze([
  "schema_version",
  "power_mw",
  "capacity_mwh",
  "round_trip_efficiency",
  "degradation_cost_aud_per_mwh",
  "marginal_loss_factor",
]);
const SPREAD_STANDARD_FIELD_NAMES = Object.freeze([
  "schema_version",
  "spread_standard_aud_per_mwh",
  "effective_date",
  "reviewer_name",
  "review_basis",
]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_LENGTH = 10;

/**
 * @typedef {object} BatteryConfiguration
 * @property {number} power_mw 功率（MW），大於 0
 * @property {number} capacity_mwh 容量（MWh），大於 0
 * @property {number} round_trip_efficiency 來回效率，大於 0 且不超過 1
 * @property {number} degradation_cost_aud_per_mwh 每 MWh 放電的損耗成本（AUD），0 以上
 * @property {number} marginal_loss_factor 損失係數（MLF），大於 0
 */

/**
 * @typedef {object} SpreadStandard
 * @property {number} spread_standard_aud_per_mwh 價差標準（AUD/MWh），0 以上
 * @property {string} effective_date 生效日期（YYYY-MM-DD）
 * @property {string} reviewer_name 檢討人
 * @property {string} review_basis 檢討依據
 */

/**
 * 讀取並驗證 `config/battery.json`，遇到暫時性錯誤退避重試（見 `http_request.fetch_json_with_retry`）。
 *
 * @param {Partial<import("./http_request.js").RequestOptions>} [request_options] 可替換的 fetch、等待與逾時
 * @returns {Promise<BatteryConfiguration>} 設備參數
 * @throws {Error} 讀不到檔案、檔案不是合法 JSON，或內容不合法時
 */
export async function fetch_battery_configuration(request_options = {}) {
  let configuration_payload;
  try {
    configuration_payload = await fetch_json_with_retry(
      BATTERY_CONFIGURATION_URL,
      { cache: "no-store" },
      { source_label: BATTERY_FILE_LABEL, ...request_options },
    );
  } catch (request_error) {
    if (!(request_error instanceof SyntaxError)) throw request_error;
    throw new Error(`${BATTERY_FILE_LABEL} 不是合法的 JSON：${request_error.message}`, { cause: request_error });
  }
  return parse_battery_configuration(configuration_payload);
}

/**
 * 驗證設備參數。
 *
 * @param {unknown} configuration_payload `config/battery.json` 的 JSON 內容
 * @returns {BatteryConfiguration} 設備參數
 * @throws {Error} 不是物件、欄位缺漏或多出、版本不符、數值超出範圍時
 */
export function parse_battery_configuration(configuration_payload) {
  check_field_names(configuration_payload, BATTERY_FIELD_NAMES, BATTERY_FILE_LABEL);
  const read_field = (field_name, is_within_range, range_text) =>
    read_number_field(configuration_payload, field_name, BATTERY_FILE_LABEL, is_within_range, range_text);
  return Object.freeze({
    power_mw: read_field("power_mw", (field_value) => field_value > 0, "大於 0"),
    capacity_mwh: read_field("capacity_mwh", (field_value) => field_value > 0, "大於 0"),
    round_trip_efficiency: read_field(
      "round_trip_efficiency",
      (field_value) => field_value > 0 && field_value <= 1,
      "大於 0 且不超過 1",
    ),
    degradation_cost_aud_per_mwh: read_field("degradation_cost_aud_per_mwh", (field_value) => field_value >= 0, "0 以上"),
    marginal_loss_factor: read_field("marginal_loss_factor", (field_value) => field_value > 0, "大於 0"),
  });
}

/**
 * 驗證價差標準。
 *
 * @param {unknown} configuration_payload `config/spread_standard.json` 的 JSON 內容
 * @returns {SpreadStandard} 價差標準
 * @throws {Error} 不是物件、欄位缺漏或多出、版本不符、數值或日期不合法、文字欄位空白時
 */
export function parse_spread_standard(configuration_payload) {
  check_field_names(configuration_payload, SPREAD_STANDARD_FIELD_NAMES, SPREAD_STANDARD_FILE_LABEL);
  return Object.freeze({
    spread_standard_aud_per_mwh: read_number_field(
      configuration_payload,
      "spread_standard_aud_per_mwh",
      SPREAD_STANDARD_FILE_LABEL,
      (field_value) => field_value >= 0,
      "0 以上",
    ),
    effective_date: read_date_field(configuration_payload, "effective_date", SPREAD_STANDARD_FILE_LABEL),
    reviewer_name: read_text_field(configuration_payload, "reviewer_name", SPREAD_STANDARD_FILE_LABEL),
    review_basis: read_text_field(configuration_payload, "review_basis", SPREAD_STANDARD_FILE_LABEL),
  });
}

/**
 * 確認設定是 JSON 物件、欄位恰好是預期的那幾個，且版本相符。
 *
 * @param {unknown} configuration_payload JSON 內容
 * @param {readonly string[]} expected_field_names 預期欄位（含 `schema_version`）
 * @param {string} file_label 檔名，用在錯誤訊息
 * @throws {Error} 不符時
 */
function check_field_names(configuration_payload, expected_field_names, file_label) {
  if (typeof configuration_payload !== "object" || configuration_payload === null || Array.isArray(configuration_payload)) {
    throw new Error(`${file_label} 必須是 JSON 物件`);
  }
  const actual_field_names = Object.keys(configuration_payload);
  const missing_field_names = expected_field_names.filter((field_name) => !actual_field_names.includes(field_name));
  if (missing_field_names.length > 0) throw new Error(`${file_label} 缺少欄位：${missing_field_names.join("、")}`);
  const unknown_field_names = actual_field_names.filter((field_name) => !expected_field_names.includes(field_name));
  if (unknown_field_names.length > 0) throw new Error(`${file_label} 有未知欄位：${unknown_field_names.join("、")}`);
  if (configuration_payload.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`${file_label} 的 schema_version 必須是 ${SUPPORTED_SCHEMA_VERSION}：${JSON.stringify(configuration_payload.schema_version)}`);
  }
}

/**
 * 取出數值欄位並檢查範圍。
 *
 * @param {Record<string, unknown>} configuration_payload JSON 內容
 * @param {string} field_name 欄名
 * @param {string} file_label 檔名
 * @param {(field_value: number) => boolean} is_within_range 範圍判斷
 * @param {string} range_text 範圍說明，用在錯誤訊息
 * @returns {number} 欄位值
 * @throws {Error} 不是有限數值或超出範圍時
 */
function read_number_field(configuration_payload, field_name, file_label, is_within_range, range_text) {
  const field_value = configuration_payload[field_name];
  if (typeof field_value !== "number" || !Number.isFinite(field_value) || !is_within_range(field_value)) {
    throw new Error(`${file_label} 的 ${field_name} 必須是${range_text}的數值：${JSON.stringify(field_value)}`);
  }
  return field_value;
}

/**
 * 取出非空白的文字欄位。
 *
 * @param {Record<string, unknown>} configuration_payload JSON 內容
 * @param {string} field_name 欄名
 * @param {string} file_label 檔名
 * @returns {string} 去除前後空白的文字
 * @throws {Error} 不是文字或空白時
 */
function read_text_field(configuration_payload, field_name, file_label) {
  const field_value = configuration_payload[field_name];
  if (typeof field_value !== "string" || field_value.trim() === "") {
    throw new Error(`${file_label} 的 ${field_name} 必須是非空白文字：${JSON.stringify(field_value)}`);
  }
  return field_value.trim();
}

/**
 * 取出 `YYYY-MM-DD` 日期欄位，並確認是實際存在的日期。
 *
 * @param {Record<string, unknown>} configuration_payload JSON 內容
 * @param {string} field_name 欄名
 * @param {string} file_label 檔名
 * @returns {string} 日期字串
 * @throws {Error} 格式不符或日期不存在時（例如 2026-02-30）
 */
function read_date_field(configuration_payload, field_name, file_label) {
  const field_value = configuration_payload[field_name];
  const is_real_date =
    typeof field_value === "string" &&
    ISO_DATE_PATTERN.test(field_value) &&
    !Number.isNaN(Date.parse(field_value)) &&
    new Date(field_value).toISOString().slice(0, ISO_DATE_LENGTH) === field_value;
  if (!is_real_date) throw new Error(`${file_label} 的 ${field_name} 必須是 YYYY-MM-DD 日期：${JSON.stringify(field_value)}`);
  return field_value;
}
