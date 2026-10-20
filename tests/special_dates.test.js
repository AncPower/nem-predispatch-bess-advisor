import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  EVENT_CATEGORY_LABELS, IMPACT_DIRECTION_LABELS, collect_event_dates, collect_excluded_dates, filter_days_by_event_view, list_event_dates,
} from "../src/event_days.js";
import { SPECIAL_DATE_FIELD_NAMES, fetch_special_dates, parse_special_dates_csv } from "../src/special_dates.js";

const REPOSITORY_CSV_URL = new URL("../data/special_dates.csv", import.meta.url);
const HEADER_LINE = SPECIAL_DATE_FIELD_NAMES.join(",");
const VALID_ROW = Object.freeze({
  start_date: "2026-06-12",
  end_date: "2026-06-12",
  start_time: "17:00",
  end_time: "21:00",
  category: "unit_or_network_outage",
  event_name: "測試事故",
  summary: "\"兩部機組跳脫，傍晚價格觸頂\"",
  impact_direction: "raise",
  source_url: "https://aemo.com.au/market-notices/12345",
  exclude_by_default: "true",
  added_by: "alice",
  reviewed_by: "bob",
});

/** 依欄位覆寫組一列 CSV。 */
function build_row(field_overrides = {}) {
  const row_values = { ...VALID_ROW, ...field_overrides };
  return SPECIAL_DATE_FIELD_NAMES.map((field_name) => row_values[field_name]).join(",");
}

/** 標題列加上多列。 */
function build_csv(...row_lines) {
  return [HEADER_LINE, ...row_lines].join("\n");
}

test("data/special_dates.csv: repo 內的檔案通過格式檢查", () => {
  const special_dates = parse_special_dates_csv(readFileSync(REPOSITORY_CSV_URL, "utf8"));

  assert.ok(Array.isArray(special_dates));
});

test("parse_special_dates_csv: 只有標題列時回傳空陣列，容許 BOM、CRLF 與結尾空行", () => {
  assert.deepEqual(parse_special_dates_csv(`\uFEFF${HEADER_LINE}\r\n\r\n`), []);
});

test("parse_special_dates_csv: 合法列解析成事件並依起日排序", () => {
  const special_dates = parse_special_dates_csv(build_csv(
    build_row({ start_date: "2026-07-01", end_date: "2026-07-02", start_time: "", end_time: "", exclude_by_default: "false" }),
    build_row(),
  ));

  assert.deepEqual(special_dates.map((special_date) => special_date.start_date), ["2026-06-12", "2026-07-01"]);
  assert.equal(special_dates[0].summary, "兩部機組跳脫，傍晚價格觸頂");
  assert.equal(special_dates[0].exclude_by_default, true);
  assert.equal(special_dates[0].line_number, 3);
  assert.equal(special_dates[1].start_time, "");
  assert.equal(special_dates[1].exclude_by_default, false);
});

test("parse_special_dates_csv: 標題列不符時報錯", () => {
  assert.throws(() => parse_special_dates_csv("date,note\n"), /標題列必須是/);
  assert.throws(() => parse_special_dates_csv(""), /是空的/);
});

test("parse_special_dates_csv: 錯誤訊息指出行號", () => {
  assert.throws(() => parse_special_dates_csv(build_csv(build_row(), build_row({ category: "heatwave" }))), /第 3 行的 category/);
  assert.throws(() => parse_special_dates_csv(build_csv(build_row(), "", build_row())), /第 3 行是空行/);
});

const INVALID_ROW_CASES = [
  ["日期不存在", { start_date: "2026-02-30", end_date: "2026-02-30" }, /start_date 必須是 YYYY-MM-DD/],
  ["迄日早於起日", { end_date: "2026-06-11" }, /早於 start_date/],
  ["只填起時", { end_time: "" }, /要一起填/],
  ["時間格式不符", { start_time: "5pm" }, /start_time 必須是 HH:MM/],
  ["同一天迄時不晚於起時", { start_time: "21:00", end_time: "17:00" }, /必須晚於 start_time/],
  ["類別不在六種之內", { category: "other" }, /category 必須是/],
  ["影響方向不在代碼表", { impact_direction: "up" }, /impact_direction 必須是/],
  ["來源網址空白", { source_url: "" }, /source_url 必須是完整網址/],
  ["來源網址協定不允許", { source_url: "javascript:alert(1)" }, /只接受 http 或 https/],
  ["預設排除不是布林", { exclude_by_default: "yes" }, /exclude_by_default 必須是 true 或 false/],
  ["事件名稱空白", { event_name: " " }, /event_name 不可空白/],
  ["審核人空白", { reviewed_by: "" }, /reviewed_by 不可空白/],
  ["審核人與新增人相同", { reviewed_by: "alice" }, /新增人以外的人/],
  ["欄位數不符（說明含逗號卻沒加引號）", { summary: "跳脫,觸頂" }, /有 13 個欄位，應為 12 個/],
];

for (const [case_name, field_overrides, error_pattern] of INVALID_ROW_CASES) {
  test(`parse_special_dates_csv: ${case_name}時報錯`, () => {
    assert.throws(() => parse_special_dates_csv(build_csv(build_row(field_overrides))), error_pattern);
  });
}

test("parse_special_dates_csv: 跨日事件的迄時可以早於起時", () => {
  const special_dates = parse_special_dates_csv(build_csv(build_row({ end_date: "2026-06-13", start_time: "22:00", end_time: "02:00" })));

  assert.equal(special_dates[0].end_time, "02:00");
});

test("parse_special_dates_csv: HTML 內容原樣保留為文字（由顯示層以 textContent 寫入）", () => {
  const special_dates = parse_special_dates_csv(build_csv(build_row({ summary: "<img src=x onerror=alert(1)>" })));

  assert.equal(special_dates[0].summary, "<img src=x onerror=alert(1)>");
});

test("fetch_special_dates: 讀取文字內容並驗證", async () => {
  let requested_url = "";
  const fake_fetch = async (request_url) => {
    requested_url = request_url;
    return { status: 200, ok: true, text: async () => build_csv(build_row()) };
  };

  const special_dates = await fetch_special_dates({ fetch_function: fake_fetch, sleep_function: async () => {} });

  assert.equal(special_dates.length, 1);
  assert.match(requested_url, /data\/special_dates\.csv$/);
});

test("fetch_special_dates: 404 時錯誤訊息帶檔名", async () => {
  const missing_fetch = async () => ({ status: 404, ok: false, text: async () => "" });

  await assert.rejects(fetch_special_dates({ fetch_function: missing_fetch }), /data\/special_dates\.csv 回應 HTTP 404/);
});

test("event_days: 類別六種、影響方向三種", () => {
  assert.equal(Object.keys(EVENT_CATEGORY_LABELS).length, 6);
  assert.deepEqual(Object.keys(IMPACT_DIRECTION_LABELS), ["raise", "lower", "uncertain"]);
});

test("list_event_dates: 含起迄日，可跨月", () => {
  assert.deepEqual(list_event_dates({ start_date: "2026-01-30", end_date: "2026-02-02" }), ["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  assert.deepEqual(list_event_dates({ start_date: "2026-06-12", end_date: "2026-06-12" }), ["2026-06-12"]);
  assert.throws(() => list_event_dates({ start_date: "2026-06-12", end_date: "2026-06-11" }), /事件期間不合法/);
});

test("collect_excluded_dates: 只收預設排除的事件，collect_event_dates 收全部", () => {
  const special_dates = [
    { start_date: "2026-06-12", end_date: "2026-06-13", exclude_by_default: true },
    { start_date: "2026-07-01", end_date: "2026-07-01", exclude_by_default: false },
  ];

  assert.deepEqual([...collect_excluded_dates(special_dates)], ["2026-06-12", "2026-06-13"]);
  assert.deepEqual([...collect_event_dates(special_dates)], ["2026-06-12", "2026-06-13", "2026-07-01"]);
});

test("filter_days_by_event_view: 三種檢視互補且不改動輸入", () => {
  const day_records = Object.freeze([{ date: "2026-06-11" }, { date: "2026-06-12" }, { date: "2026-06-13" }]);
  const event_dates = new Set(["2026-06-12"]);

  const included_days = filter_days_by_event_view(day_records, event_dates, "include_events");
  const excluded_days = filter_days_by_event_view(day_records, event_dates, "exclude_events");
  const event_only_days = filter_days_by_event_view(day_records, event_dates, "only_events");

  assert.deepEqual(included_days.map((day_record) => day_record.date), ["2026-06-11", "2026-06-12", "2026-06-13"]);
  assert.notEqual(included_days, day_records);
  assert.deepEqual(excluded_days.map((day_record) => day_record.date), ["2026-06-11", "2026-06-13"]);
  assert.deepEqual(event_only_days.map((day_record) => day_record.date), ["2026-06-12"]);
  assert.throws(() => filter_days_by_event_view(day_records, event_dates, "all"), /未知的事件檢視/);
});
