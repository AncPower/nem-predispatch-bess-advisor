/**
 * 特殊日期備註：存在本 repo 的 GitHub Issues（標籤 `special-date`），以 issue 表單新增。
 *
 * 讀取用 GitHub REST API（允許任何網域讀取；未登入時每個 IP 每小時 60 次）。
 * issue 內文是任何人都能寫的外部輸入：逐欄解析，只當純文字顯示。
 */

import { HttpStatusError, fetch_json_with_retry } from "./http_request.js";

export const NOTES_REPOSITORY = "AncPower/nem-predispatch-bess-advisor";
export const NOTE_LABEL = "special-date";
export const NOTE_TEMPLATE_FILE = "special_date.yml";

const ISSUES_API_URL = `https://api.github.com/repos/${NOTES_REPOSITORY}/issues?labels=${NOTE_LABEL}&state=open&per_page=100`;
const NEW_ISSUE_URL = `https://github.com/${NOTES_REPOSITORY}/issues/new`;
const ISSUE_URL_PREFIX = `https://github.com/${NOTES_REPOSITORY}/issues/`;
const HTTP_FORBIDDEN = 403;
const EMPTY_FIELD_TEXT = "_No response_";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EXCLUDE_CHECKED_PATTERN = /^- \[x\]/im;

/** issue 表單各欄位的標題，必須與 `.github/ISSUE_TEMPLATE/special_date.yml` 的 label 相同。 */
export const NOTE_FIELD_HEADINGS = Object.freeze({
  note_date: "日期",
  note_time: "時間",
  note_market: "市場或區域",
  note_category: "類別",
  note_text: "補充資訊",
  note_exclude: "校準",
});

/**
 * @typedef {object} SpecialDateNote
 * @property {number} issue_number issue 編號
 * @property {string} issue_url issue 網址
 * @property {string | null} note_date 日期（YYYY-MM-DD），格式不符時為 null
 * @property {string} raw_date_text 原始日期文字
 * @property {string} note_time 時間
 * @property {string} market_name 市場或區域
 * @property {string} category_name 類別
 * @property {string} note_text 補充資訊
 * @property {boolean} exclude_from_calibration 是否在校準時排除
 */

/**
 * 讀取所有未關閉的特殊日期備註。
 *
 * @param {Partial<import("./http_request.js").RequestOptions>} [request_options] 可替換的 fetch、等待與逾時
 * @returns {Promise<SpecialDateNote[]>} 備註，依日期新到舊
 * @throws {Error} 讀取失敗；HTTP 403 時說明可能是每小時次數上限
 */
export async function fetch_special_date_notes(request_options = {}) {
  let issue_payload;
  try {
    issue_payload = await fetch_json_with_retry(
      ISSUES_API_URL,
      { method: "GET", headers: { Accept: "application/vnd.github+json" }, cache: "no-store" },
      { source_label: "GitHub API", ...request_options },
    );
  } catch (request_error) {
    if (request_error instanceof HttpStatusError && request_error.http_status === HTTP_FORBIDDEN) {
      throw new Error("GitHub API 拒絕讀取，多半是這個網路每小時 60 次的未登入上限已用完，請稍後再試", { cause: request_error });
    }
    throw request_error;
  }
  if (!Array.isArray(issue_payload)) throw new Error("GitHub API 回應不是 issue 陣列");
  return issue_payload
    .filter((issue_item) => !issue_item?.pull_request)
    .map((issue_item, item_index) => parse_note_issue(issue_item, item_index))
    .sort((left_note, right_note) => (right_note.raw_date_text + right_note.note_time).localeCompare(left_note.raw_date_text + left_note.note_time));
}

/**
 * 把一個 issue 解析成備註。
 *
 * @param {unknown} issue_item GitHub issue 物件
 * @param {number} item_index 在回應中的位置（錯誤訊息用）
 * @returns {SpecialDateNote} 備註
 * @throws {Error} issue 缺少編號或網址不屬於本 repo 時
 */
export function parse_note_issue(issue_item, item_index) {
  const item_label = `GitHub 回應第 ${item_index + 1} 筆 issue`;
  if (!Number.isInteger(issue_item?.number)) throw new Error(`${item_label}缺少編號`);
  if (typeof issue_item.html_url !== "string" || !issue_item.html_url.startsWith(ISSUE_URL_PREFIX)) {
    throw new Error(`${item_label}的網址不屬於 ${NOTES_REPOSITORY}`);
  }
  const form_fields = parse_issue_form_body(typeof issue_item.body === "string" ? issue_item.body : "");
  const raw_date_text = form_fields.get(NOTE_FIELD_HEADINGS.note_date) ?? "";
  return {
    issue_number: issue_item.number,
    issue_url: issue_item.html_url,
    note_date: DATE_PATTERN.test(raw_date_text) ? raw_date_text : null,
    raw_date_text,
    note_time: form_fields.get(NOTE_FIELD_HEADINGS.note_time) ?? "",
    market_name: form_fields.get(NOTE_FIELD_HEADINGS.note_market) ?? "",
    category_name: form_fields.get(NOTE_FIELD_HEADINGS.note_category) ?? "",
    note_text: form_fields.get(NOTE_FIELD_HEADINGS.note_text) ?? "",
    exclude_from_calibration: EXCLUDE_CHECKED_PATTERN.test(form_fields.get(NOTE_FIELD_HEADINGS.note_exclude) ?? ""),
  };
}

/**
 * 解析 GitHub issue 表單產生的內文：每欄是「### 標題」接一段內容，未填的欄位是 `_No response_`。
 *
 * @param {string} issue_body issue 內文
 * @returns {Map<string, string>} 標題 → 內容（去頭尾空白；未填為空字串）
 */
export function parse_issue_form_body(issue_body) {
  const form_fields = new Map();
  const body_sections = issue_body.replace(/\r\n/g, "\n").split(/^### /m).slice(1);
  for (const body_section of body_sections) {
    const heading_end = body_section.indexOf("\n");
    const heading_text = (heading_end < 0 ? body_section : body_section.slice(0, heading_end)).trim();
    const field_value = heading_end < 0 ? "" : body_section.slice(heading_end + 1).trim();
    form_fields.set(heading_text, field_value === EMPTY_FIELD_TEXT ? "" : field_value);
  }
  return form_fields;
}

/**
 * 預先填好欄位的新增備註網址（issue 表單以欄位 id 帶入）。
 *
 * @param {{note_date: string, note_time: string, note_market: string, note_text: string}} note_fields 頁面上填的欄位
 * @returns {string} GitHub 新 issue 網址
 */
export function build_new_note_url(note_fields) {
  const query_parameters = new URLSearchParams({
    template: NOTE_TEMPLATE_FILE,
    labels: NOTE_LABEL,
    title: `[特殊日期] ${note_fields.note_date} ${note_fields.note_market}`.trim(),
    note_date: note_fields.note_date,
    note_time: note_fields.note_time,
    note_market: note_fields.note_market,
    note_text: note_fields.note_text,
  });
  return `${NEW_ISSUE_URL}?${query_parameters.toString()}`;
}

/**
 * 標記「校準時排除」且日期有效的日期集合。
 *
 * @param {SpecialDateNote[]} special_date_notes 備註
 * @returns {Set<string>} 日期（YYYY-MM-DD）
 */
export function collect_excluded_dates(special_date_notes) {
  return new Set(special_date_notes.filter((special_note) => special_note.exclude_from_calibration && special_note.note_date).map((special_note) => special_note.note_date));
}
