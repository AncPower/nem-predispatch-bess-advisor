import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { fetch_daily_summary, parse_daily_summary } from "../src/daily_summary.js";
import { annotate_days_with_events, group_events_by_date } from "../src/event_days.js";
import { build_event_tooltip_lines, draw_daily_revenue_chart } from "../src/scenario_render.js";

const REPOSITORY_SUMMARY_URL = new URL("../data/daily_summary.json", import.meta.url);

/** 一天的輸出，可覆寫欄位。 */
function build_day(date, field_overrides = {}) {
  return { date, excluded: false, exclusion_reason: null, net_value_aud: 1200, best_spread_aud_per_mwh: 80, cycles: [], ...field_overrides };
}

/** 一份合法的每日摘要，可覆寫欄位。 */
function build_summary(field_overrides = {}) {
  return {
    schema_version: 1,
    generated_at: "2026-10-20T00:00:00Z",
    region_id: "NSW1",
    days: [
      build_day("2026-06-11"),
      build_day("2026-06-12", { net_value_aud: 45000 }),
      build_day("2026-06-13", { excluded: true, exclusion_reason: "沒有電價資料", net_value_aud: null, best_spread_aud_per_mwh: null }),
    ],
    ...field_overrides,
  };
}

/** 事件（只含這裡用到的欄位）。 */
function build_event(field_overrides = {}) {
  return { start_date: "2026-06-12", end_date: "2026-06-12", category: "extreme_weather", event_name: "熱浪", exclude_by_default: false, ...field_overrides };
}

test("data/daily_summary.json: repo 內的檔案通過格式檢查", () => {
  const daily_summary = parse_daily_summary(JSON.parse(readFileSync(REPOSITORY_SUMMARY_URL, "utf8")));

  assert.equal(daily_summary.region_id, "NSW1");
  assert.ok(daily_summary.days.length > 0);
});

test("parse_daily_summary: 合法內容保留日期順序與數值", () => {
  const daily_summary = parse_daily_summary(build_summary());

  assert.deepEqual(daily_summary.days.map((summary_day) => summary_day.date), ["2026-06-11", "2026-06-12", "2026-06-13"]);
  assert.equal(daily_summary.days[1].net_value_aud, 45000);
  assert.equal(daily_summary.days[2].net_value_aud, null);
});

const INVALID_SUMMARY_CASES = [
  ["不是物件", [], /必須是 JSON 物件/],
  ["版本不符", build_summary({ schema_version: 2 }), /schema_version 必須是 1/],
  ["缺少區域", build_summary({ region_id: "" }), /region_id 必須是非空白文字/],
  ["days 為空", build_summary({ days: [] }), /days 必須是非空陣列/],
  ["日期格式不符", build_summary({ days: [build_day("2026/06/11")] }), /date 必須是 YYYY-MM-DD/],
  ["日期沒有遞增", build_summary({ days: [build_day("2026-06-12"), build_day("2026-06-11")] }), /必須依日期遞增排列/],
  ["日期重複", build_summary({ days: [build_day("2026-06-12"), build_day("2026-06-12")] }), /必須依日期遞增排列/],
  ["excluded 不是布林", build_summary({ days: [build_day("2026-06-11", { excluded: "no" })] }), /excluded 必須是 true 或 false/],
  ["排除日沒有原因", build_summary({ days: [build_day("2026-06-11", { excluded: true, net_value_aud: null })] }), /必須寫明 exclusion_reason/],
  ["排除日仍有收益", build_summary({ days: [build_day("2026-06-11", { excluded: true, exclusion_reason: "缺資料" })] }), /net_value_aud 必須是 null/],
  ["未排除卻有原因", build_summary({ days: [build_day("2026-06-11", { exclusion_reason: "缺資料" })] }), /exclusion_reason 必須是 null/],
  ["收益不是數值", build_summary({ days: [build_day("2026-06-11", { net_value_aud: "1200" })] }), /net_value_aud 必須是數值/],
  ["價差不是數值", build_summary({ days: [build_day("2026-06-11", { best_spread_aud_per_mwh: Number.NaN })] }), /best_spread_aud_per_mwh 必須是數值或 null/],
  ["cycles 不是陣列", build_summary({ days: [build_day("2026-06-11", { cycles: null })] }), /cycles 必須是陣列/],
];

for (const [case_name, summary_payload, error_pattern] of INVALID_SUMMARY_CASES) {
  test(`parse_daily_summary: ${case_name}時報錯`, () => {
    assert.throws(() => parse_daily_summary(summary_payload), error_pattern);
  });
}

test("fetch_daily_summary: 讀取 data/daily_summary.json 並驗證；不是 JSON 時說明檔名", async () => {
  let requested_url = "";
  const fake_fetch = async (request_url) => {
    requested_url = request_url;
    return { status: 200, ok: true, json: async () => build_summary() };
  };
  const broken_fetch = async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("Unexpected token"); } });

  const daily_summary = await fetch_daily_summary({ fetch_function: fake_fetch, sleep_function: async () => {} });

  assert.equal(daily_summary.days.length, 3);
  assert.match(requested_url, /data\/daily_summary\.json$/);
  await assert.rejects(fetch_daily_summary({ fetch_function: broken_fetch }), /data\/daily_summary\.json 不是合法的 JSON/);
});

test("group_events_by_date: 跨日事件在每一天都出現", () => {
  const multi_day_event = build_event({ end_date: "2026-06-13" });
  const single_day_event = build_event({ event_name: "機組跳脫", category: "unit_or_network_outage" });

  const events_by_date = group_events_by_date([multi_day_event, single_day_event]);

  assert.deepEqual([...events_by_date.keys()], ["2026-06-12", "2026-06-13"]);
  assert.deepEqual(events_by_date.get("2026-06-12"), [multi_day_event, single_day_event]);
  assert.deepEqual(events_by_date.get("2026-06-13"), [multi_day_event]);
});

test("annotate_days_with_events: 沒有事件、一般事件與含預設排除事件的日子", () => {
  const day_records = parse_daily_summary(build_summary()).days;
  const events_by_date = group_events_by_date([build_event(), build_event({ start_date: "2026-06-13", end_date: "2026-06-13", exclude_by_default: true })]);

  const annotated_days = annotate_days_with_events(day_records, events_by_date);

  assert.deepEqual(annotated_days.map((annotated_day) => annotated_day.marker_kind), ["none", "event", "excluded_event"]);
  assert.equal(annotated_days[1].day_events[0].event_name, "熱浪");
  assert.equal(annotated_days[2].net_value_aud, null);
});

test("build_event_tooltip_lines: 每筆事件一行，預設排除加註", () => {
  const tooltip_lines = build_event_tooltip_lines({
    day_events: [build_event(), build_event({ category: "data_anomaly", event_name: "價格缺漏", exclude_by_default: true })],
  });

  assert.deepEqual(tooltip_lines, ["極端天氣｜熱浪", "資料異常｜價格缺漏（預設排除）"]);
  assert.deepEqual(build_event_tooltip_lines({ day_events: [] }), []);
});

test("draw_daily_revenue_chart: 依標注上色，排除日沒有長條，提示框帶事件", () => {
  const color_tokens = { "--charge": "teal", "--discharge": "amber", "--cut": "red", "--ink-3": "grey", "--rule": "silver" };
  const saved_globals = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, window: globalThis.window };
  const created_charts = [];
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: (token_name) => color_tokens[token_name] ?? "" });
  globalThis.window = { Chart: class { constructor(chart_canvas, chart_configuration) { this.chart_configuration = chart_configuration; created_charts.push(this); } } };
  try {
    const day_records = parse_daily_summary(build_summary()).days;
    const annotated_days = annotate_days_with_events(day_records, group_events_by_date([build_event()]));
    let destroyed = false;

    draw_daily_revenue_chart({}, { destroy: () => { destroyed = true; } }, annotated_days);

    const chart_configuration = created_charts[0].chart_configuration;
    const chart_dataset = chart_configuration.data.datasets[0];
    assert.equal(destroyed, true);
    assert.deepEqual(chart_configuration.data.labels, ["2026-06-11", "2026-06-12", "2026-06-13"]);
    assert.deepEqual(chart_dataset.data, [1200, 45000, null]);
    assert.deepEqual(chart_dataset.backgroundColor, ["teal", "amber", "teal"]);
    assert.deepEqual(chart_configuration.options.plugins.tooltip.callbacks.afterBody([{ dataIndex: 1 }]), ["極端天氣｜熱浪"]);
  } finally {
    Object.assign(globalThis, saved_globals);
  }
});
