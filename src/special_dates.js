/**
 * 特殊事件清單 `data/special_dates.csv`（roadmap L3）：讀取並逐列驗證。
 *
 * 新增事件一律開 PR 修改這個檔，附外部來源，並由新增人以外的人審核後合併；不可只因電價或收益異常就標注。
 * 欄位、代碼或格式不符時直接報錯並指出第幾行，不略過、不補值。CI 以 `tests/special_dates.test.js`
 * 驗證 repo 內的檔案。每筆事件一行，欄位內不可換行。顯示層一律以 textContent 寫入。
 */

import { split_csv_line } from "./csv_line.js";
import { EVENT_CATEGORY_LABELS, IMPACT_DIRECTION_LABELS } from "./event_days.js";
import { fetch_text_with_retry } from "./http_request.js";

export const SPECIAL_DATES_URL = new URL("../data/special_dates.csv", import.meta.url).href;

/** 標題列，順序固定。 */
export const SPECIAL_DATE_FIELD_NAMES = Object.freeze([
  "start_date",
  "end_date",
  "start_time",
  "end_time",
  "category",
  "event_name",
  "summary",
  "impact_direction",
  "source_url",
  "exclude_by_default",
  "added_by",
  "reviewed_by",
]);

const FILE_LABEL = "data/special_dates.csv";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_LENGTH = 10;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const BOOLEAN_TEXT_VALUES = Object.freeze({ true: true, false: false });
const ALLOWED_URL_PROTOCOLS = Object.freeze(["https:", "http:"]);
const REQUIRED_TEXT_FIELDS = Object.freeze(["event_name", "summary", "added_by", "reviewed_by"]);

/**
 * @typedef {object} SpecialDate
 * @property {number} line_number 在檔案中的行號（標題列為第 1 行）
 * @property {string} start_date 起日（YYYY-MM-DD，NEM 時間）
 * @property {string} end_date 迄日（YYYY-MM-DD），不早於起日
 * @property {string} start_time 起時（HH:MM），整天的事件為空字串
 * @property {string} end_time 迄時（HH:MM），整天的事件為空字串
 * @property {keyof typeof EVENT_CATEGORY_LABELS} category 類別代碼
 * @property {string} event_name 事件名稱
 * @property {string} summary 一句話說明
 * @property {keyof typeof IMPACT_DIRECTION_LABELS} impact_direction 影響方向代碼
 * @property {string} source_url 外部來源網址（http 或 https）
 * @property {boolean} exclude_by_default 是否預設排除
 * @property {string} added_by 新增人
 * @property {string} reviewed_by 審核人，不可與新增人相同
 */

/**
 * 讀取並驗證事件清單，遇到暫時性錯誤退避重試（見 `http_request.fetch_text_with_retry`）。
 *
 * @param {Partial<import("./http_request.js").RequestOptions>} [request_options] 可替換的 fetch、等待與逾時
 * @returns {Promise<readonly SpecialDate[]>} 事件，依起日、起時排序
 * @throws {Error} 讀不到檔案或內容不合法時
 */
export async function fetch_special_dates(request_options = {}) {
  const csv_text = await fetch_text_with_retry(SPECIAL_DATES_URL, { cache: "no-store" }, { source_label: FILE_LABEL, ...request_options });
  return parse_special_dates_csv(csv_text);
}

/**
 * 解析並驗證事件清單的 CSV 文字。只有標題列時回傳空陣列。
 *
 * @param {string} csv_text 檔案內容
 * @returns {readonly SpecialDate[]} 事件，依起日、起時、行號排序
 * @throws {Error} 標題列不符、中間有空行，或任何一列不合法時
 */
export function parse_special_dates_csv(csv_text) {
  const text_lines = csv_text.replace(/^\uFEFF/, "").split(/\r?\n/);
  while (text_lines.length > 0 && text_lines.at(-1).trim() === "") text_lines.pop();
  if (text_lines.length === 0) throw new Error(`${FILE_LABEL} 是空的，至少要有標題列`);
  const header_cells = split_csv_line(text_lines[0]).map((header_cell) => header_cell.trim());
  if (header_cells.join(",") !== SPECIAL_DATE_FIELD_NAMES.join(",")) {
    throw new Error(`${FILE_LABEL} 的標題列必須是：${SPECIAL_DATE_FIELD_NAMES.join(",")}`);
  }
  const special_dates = [];
  for (let line_index = 1; line_index < text_lines.length; line_index++) {
    const line_number = line_index + 1;
    if (text_lines[line_index].trim() === "") throw new Error(`${FILE_LABEL} 第 ${line_number} 行是空行`);
    special_dates.push(parse_special_date_row(split_csv_line(text_lines[line_index]), line_number));
  }
  return Object.freeze(special_dates.sort(compare_special_dates));
}

/**
 * 驗證一列事件。
 *
 * @param {string[]} row_cells 拆好的欄位
 * @param {number} line_number 行號
 * @returns {SpecialDate} 事件
 * @throws {Error} 欄位數、日期、時間、代碼、網址、布林值或文字欄位不合法時
 */
export function parse_special_date_row(row_cells, line_number) {
  const row_label = `${FILE_LABEL} 第 ${line_number} 行`;
  if (row_cells.length !== SPECIAL_DATE_FIELD_NAMES.length) {
    throw new Error(`${row_label}有 ${row_cells.length} 個欄位，應為 ${SPECIAL_DATE_FIELD_NAMES.length} 個（含逗號的文字要用雙引號包起來）`);
  }
  const row_values = Object.fromEntries(SPECIAL_DATE_FIELD_NAMES.map((field_name, field_index) => [field_name, row_cells[field_index].trim()]));
  const start_date = read_date_value(row_values, "start_date", row_label);
  const end_date = read_date_value(row_values, "end_date", row_label);
  if (end_date < start_date) throw new Error(`${row_label}的 end_date（${end_date}）早於 start_date（${start_date}）`);
  const event_times = read_time_values(row_values, row_label, start_date === end_date);
  for (const field_name of REQUIRED_TEXT_FIELDS) {
    if (row_values[field_name] === "") throw new Error(`${row_label}的 ${field_name} 不可空白`);
  }
  if (row_values.reviewed_by === row_values.added_by) throw new Error(`${row_label}的 reviewed_by 必須是新增人以外的人`);
  return Object.freeze({
    line_number,
    start_date,
    end_date,
    ...event_times,
    category: read_code_value(row_values, "category", EVENT_CATEGORY_LABELS, row_label),
    event_name: row_values.event_name,
    summary: row_values.summary,
    impact_direction: read_code_value(row_values, "impact_direction", IMPACT_DIRECTION_LABELS, row_label),
    source_url: read_source_url(row_values.source_url, row_label),
    exclude_by_default: read_boolean_value(row_values, "exclude_by_default", row_label),
    added_by: row_values.added_by,
    reviewed_by: row_values.reviewed_by,
  });
}

/**
 * 依起日、起時、行號排序（整天的事件排在同一天有時間的事件之前）。
 *
 * @param {SpecialDate} left_date 事件
 * @param {SpecialDate} right_date 事件
 * @returns {number} 比較結果
 */
function compare_special_dates(left_date, right_date) {
  return left_date.start_date.localeCompare(right_date.start_date)
    || left_date.start_time.localeCompare(right_date.start_time)
    || left_date.line_number - right_date.line_number;
}

/**
 * 取出實際存在的 `YYYY-MM-DD` 日期。
 *
 * @param {Record<string, string>} row_values 欄位
 * @param {string} field_name 欄名
 * @param {string} row_label 錯誤訊息的位置
 * @returns {string} 日期
 * @throws {Error} 格式不符或日期不存在（例如 2026-02-30）時
 */
function read_date_value(row_values, field_name, row_label) {
  const field_value = row_values[field_name];
  const is_real_date = ISO_DATE_PATTERN.test(field_value)
    && !Number.isNaN(Date.parse(field_value))
    && new Date(field_value).toISOString().slice(0, ISO_DATE_LENGTH) === field_value;
  if (!is_real_date) throw new Error(`${row_label}的 ${field_name} 必須是 YYYY-MM-DD 日期：${JSON.stringify(field_value)}`);
  return field_value;
}

/**
 * 起時與迄時：兩個都空白（整天），或兩個都是 HH:MM；同一天時迄時必須晚於起時。
 *
 * @param {Record<string, string>} row_values 欄位
 * @param {string} row_label 錯誤訊息的位置
 * @param {boolean} is_single_day 起日與迄日是否相同
 * @returns {{start_time: string, end_time: string}} 時間
 * @throws {Error} 只填一個、格式不符或順序錯誤時
 */
function read_time_values(row_values, row_label, is_single_day) {
  const { start_time, end_time } = row_values;
  if (start_time === "" && end_time === "") return { start_time, end_time };
  if (start_time === "" || end_time === "") throw new Error(`${row_label}的 start_time 與 end_time 要一起填，或一起留空代表整天`);
  for (const [field_name, field_value] of [["start_time", start_time], ["end_time", end_time]]) {
    if (!TIME_PATTERN.test(field_value)) throw new Error(`${row_label}的 ${field_name} 必須是 HH:MM（00:00 至 23:59）：${JSON.stringify(field_value)}`);
  }
  if (is_single_day && end_time <= start_time) throw new Error(`${row_label}的 end_time（${end_time}）必須晚於 start_time（${start_time}）`);
  return { start_time, end_time };
}

/**
 * 取出代碼欄位。
 *
 * @param {Record<string, string>} row_values 欄位
 * @param {string} field_name 欄名
 * @param {Readonly<Record<string, string>>} code_labels 允許的代碼表
 * @param {string} row_label 錯誤訊息的位置
 * @returns {string} 代碼
 * @throws {Error} 不在代碼表裡時
 */
function read_code_value(row_values, field_name, code_labels, row_label) {
  const field_value = row_values[field_name];
  if (!Object.hasOwn(code_labels, field_value)) {
    throw new Error(`${row_label}的 ${field_name} 必須是 ${Object.keys(code_labels).join("、")} 之一：${JSON.stringify(field_value)}`);
  }
  return field_value;
}

/**
 * 取出外部來源網址；只接受 http 與 https，避免頁面連結執行其他協定。
 *
 * @param {string} field_value 欄位值
 * @param {string} row_label 錯誤訊息的位置
 * @returns {string} 正規化後的網址
 * @throws {Error} 空白、無法解析或協定不允許時
 */
function read_source_url(field_value, row_label) {
  let source_url;
  try {
    source_url = new URL(field_value);
  } catch {
    throw new Error(`${row_label}的 source_url 必須是完整網址：${JSON.stringify(field_value)}`);
  }
  if (!ALLOWED_URL_PROTOCOLS.includes(source_url.protocol)) {
    throw new Error(`${row_label}的 source_url 只接受 http 或 https：${JSON.stringify(field_value)}`);
  }
  return source_url.href;
}

/**
 * 取出 `true`／`false` 欄位。
 *
 * @param {Record<string, string>} row_values 欄位
 * @param {string} field_name 欄名
 * @param {string} row_label 錯誤訊息的位置
 * @returns {boolean} 布林值
 * @throws {Error} 不是 true 或 false 時
 */
function read_boolean_value(row_values, field_name, row_label) {
  const field_value = row_values[field_name];
  if (!Object.hasOwn(BOOLEAN_TEXT_VALUES, field_value)) throw new Error(`${row_label}的 ${field_name} 必須是 true 或 false：${JSON.stringify(field_value)}`);
  return BOOLEAN_TEXT_VALUES[field_value];
}
