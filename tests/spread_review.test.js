import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parse_daily_summary } from "../src/daily_summary.js";
import { SPREAD_STANDARD_URL, fetch_spread_standard, parse_spread_standard } from "../src/shared_configuration.js";
import {
  MINIMUM_SAMPLE_DAYS, build_candidate_standards, review_spread_standards, select_period_days, summarize_break_even_spreads,
} from "../src/spread_review.js";
import { describe_spread_review, draw_spread_review_chart } from "../src/spread_review_render.js";
import { break_even_spread } from "../src/window_selection.js";

const SCENARIO_PAGE_FILE = new URL("../scenario/index.html", import.meta.url);
const REPOSITORY_SUMMARY_FILE = new URL("../data/daily_summary.json", import.meta.url);
const REPOSITORY_STANDARD_FILE = new URL("../config/spread_standard.json", import.meta.url);
const REVIEW_ELEMENT_IDS = Object.freeze([
  "review_start_date", "review_end_date", "review_event_view", "review_status", "review_title", "review_text", "review_kpis", "review_chart", "review_notes",
]);

/** 一個循環（只含檢討用到的欄位）。 */
function build_cycle(charge_average_price, spread) {
  return { charge_average_price_aud_per_mwh: charge_average_price, discharge_average_price_aud_per_mwh: charge_average_price + spread, spread_aud_per_mwh: spread };
}

/** 有計畫的一天；`cycle_spreads` 的最小值即為當日價差。 */
function planned_day(date, net_value_aud, cycle_spreads, charge_average_price = 20) {
  return {
    date, excluded: false, exclusion_reason: null, net_value_aud,
    best_spread_aud_per_mwh: Math.min(...cycle_spreads),
    cycles: cycle_spreads.map((cycle_spread) => build_cycle(charge_average_price, cycle_spread)),
  };
}

/** 資料完整但沒有正收益組合的一天。 */
function no_plan_day(date) {
  return { date, excluded: false, exclusion_reason: null, net_value_aud: 0, best_spread_aud_per_mwh: null, cycles: [] };
}

/** 資料不完整而排除的一天。 */
function excluded_day(date) {
  return { date, excluded: true, exclusion_reason: "5 分鐘電價只有 276 筆（應為 288 筆）", net_value_aud: null, best_spread_aud_per_mwh: null, cycles: [] };
}

/** 範例期間：價差 30／60（雙循環 60 與 140）／100，各賺 200／600／1200，另有一天沒有計畫、一天排除。 */
function build_example_days() {
  return [
    planned_day("2026-07-01", 200, [30]),
    planned_day("2026-07-02", 600, [140, 60]),
    planned_day("2026-07-03", 1200, [100]),
    no_plan_day("2026-07-04"),
    excluded_day("2026-07-05"),
  ];
}

/** 從 start_date 起連續 day_count 天、每天價差 50 收益 100 的期間。 */
function build_consecutive_days(start_date, day_count) {
  const start_time = Date.parse(`${start_date}T00:00:00Z`);
  return Array.from({ length: day_count }, (_unused, day_index) =>
    planned_day(new Date(start_time + day_index * 86_400_000).toISOString().slice(0, 10), 100, [50]));
}

/** describe_spread_review 需要的其他內容。 */
function build_context(field_overrides = {}) {
  return {
    start_date: "2026-07-01", end_date: "2026-07-05", event_view_label: "含事件日", event_removed_dates: [],
    spread_standard: { spread_standard_aud_per_mwh: 50, effective_date: "2026-10-20", reviewer_name: "營運主管", review_basis: "—" },
    battery_configuration: { power_mw: 5, capacity_mwh: 20, round_trip_efficiency: 0.8, degradation_cost_aud_per_mwh: 10, marginal_loss_factor: 1 },
    battery_error: "", cost_summary: { cycle_count: 4, minimum: 15, median: 15, maximum: 15 },
    ...field_overrides,
  };
}

test("select_period_days: 含起訖兩端；起日晚於迄日或格式不符時報錯", () => {
  const period_days = select_period_days(build_example_days(), "2026-07-02", "2026-07-04");

  assert.deepEqual(period_days.map((day_record) => day_record.date), ["2026-07-02", "2026-07-03", "2026-07-04"]);
  assert.throws(() => select_period_days(build_example_days(), "2026-07-04", "2026-07-02"), /不可晚於迄日/);
  assert.throws(() => select_period_days(build_example_days(), "", "2026-07-02"), /起日必須是 YYYY-MM-DD/);
});

test("build_candidate_standards: 每 1 AUD/MWh 一個，上限取最高價差向上取整與目前標準的較大值", () => {
  assert.equal(build_candidate_standards(99.2, 50).length, 101);
  assert.equal(build_candidate_standards(99.2, 50).at(-1), 100);
  assert.equal(build_candidate_standards(99.2, 150).at(-1), 150);
  const fractional_standards = build_candidate_standards(99.2, 50.5);
  assert.equal(fractional_standards.length, 102);
  assert.deepEqual(fractional_standards.slice(50, 53), [50, 50.5, 51]);
});

test("review_spread_standards: 雙循環兩個都達標才執行；價差等於標準算達標", () => {
  const spread_review = review_spread_standards(build_example_days(), 60);

  assert.equal(spread_review.current_outcome.executed_day_count, 2);
  assert.equal(spread_review.current_outcome.net_value_aud, 1800);
  const above_lower_cycle = spread_review.sweep_points.find((sweep_point) => sweep_point.spread_standard === 61);
  assert.equal(above_lower_cycle.executed_day_count, 1, "標準 61 時，最低循環 60 未達標，整天不做");
  assert.equal(above_lower_cycle.net_value_aud, 1200);
});

test("review_spread_standards: 目前標準 50 時建議下調，並列出錯過的日子與保留 99% 的上限", () => {
  const spread_review = review_spread_standards(build_example_days(), 50);

  assert.equal(spread_review.status, "lower");
  assert.equal(spread_review.valid_day_count, 4);
  assert.equal(spread_review.no_plan_day_count, 1);
  assert.deepEqual(spread_review.data_excluded_days, [{ date: "2026-07-05", reason: "5 分鐘電價只有 276 筆（應為 288 筆）" }]);
  assert.equal(spread_review.maximum_value_aud, 2000);
  assert.equal(spread_review.current_outcome.skipped_day_count, 1);
  assert.equal(spread_review.current_outcome.skipped_value_aud, 200);
  assert.equal(spread_review.current_outcome.retention_ratio, 0.9);
  assert.equal(spread_review.highest_retained_standard, 30);
  assert.equal(spread_review.sweep_points.at(-1).spread_standard, 100);
});

test("review_spread_standards: 目前標準在保留範圍內時維持", () => {
  const spread_review = review_spread_standards(build_example_days(), 30);

  assert.equal(spread_review.status, "keep");
  assert.equal(spread_review.current_outcome.retention_ratio, 1);
});

test("review_spread_standards: 收益隨標準只會相同或下降", () => {
  const net_values = review_spread_standards(build_example_days(), 0).sweep_points.map((sweep_point) => sweep_point.net_value_aud);

  for (let point_index = 1; point_index < net_values.length; point_index++) assert.ok(net_values[point_index] <= net_values[point_index - 1]);
});

test("review_spread_standards: 沒有有效日或沒有正收益時不給建議", () => {
  const empty_review = review_spread_standards([excluded_day("2026-07-05")], 50);
  const zero_review = review_spread_standards([no_plan_day("2026-07-04")], 50);

  assert.equal(empty_review.status, "no_data");
  assert.deepEqual(empty_review.sweep_points, []);
  assert.equal(empty_review.highest_retained_standard, null);
  assert.equal(review_spread_standards([], 50).status, "no_data");
  assert.equal(zero_review.status, "no_revenue");
  assert.equal(zero_review.highest_retained_standard, null);
  assert.equal(zero_review.current_outcome.retention_ratio, null);
});

test("review_spread_standards: 樣本不足與季節限制按有效日計算", () => {
  const short_review = review_spread_standards(build_example_days(), 50);
  const long_single_season = review_spread_standards(build_consecutive_days("2026-06-01", 70), 50);
  const long_two_seasons = review_spread_standards(build_consecutive_days("2026-08-01", 70), 50);

  assert.equal(short_review.warnings.length, 2);
  assert.match(short_review.warnings[0], new RegExp(`少於 ${MINIMUM_SAMPLE_DAYS} 天`));
  assert.match(short_review.warnings[1], /冬季/);
  assert.equal(long_single_season.warnings.length, 1);
  assert.match(long_single_season.warnings[0], /季節限制/);
  assert.deepEqual(long_two_seasons.warnings, []);
});

test("review_spread_standards: 目前標準不合法或資料互相矛盾時報錯", () => {
  assert.throws(() => review_spread_standards(build_example_days(), -1), /0 以上的數值/);
  assert.throws(() => review_spread_standards([{ ...no_plan_day("2026-07-04"), net_value_aud: 50 }], 0), /淨收益卻不是 0/);
  assert.throws(() => review_spread_standards([{ ...planned_day("2026-07-01", 200, [30]), cycles: [] }], 0), /沒有任何循環/);
});

test("summarize_break_even_spreads: 用共用公式逐循環計算，略過排除日", () => {
  const battery_spec = { round_trip_efficiency: 0.8, degradation_cost_aud_per_mwh: 10, marginal_loss_factor: 1 };
  const day_records = [planned_day("2026-07-01", 200, [30], 20), planned_day("2026-07-02", 600, [60], 100), excluded_day("2026-07-05")];

  const cost_summary = summarize_break_even_spreads(day_records, (charge_average_price) => break_even_spread(charge_average_price, battery_spec));

  assert.equal(cost_summary.cycle_count, 2);
  assert.ok(Math.abs(cost_summary.minimum - 15) < 1e-9);
  assert.ok(Math.abs(cost_summary.maximum - 35) < 1e-9);
  assert.ok(Math.abs(cost_summary.median - 25) < 1e-9);
  assert.equal(summarize_break_even_spreads([no_plan_day("2026-07-04")], () => 0), null);
  assert.throws(() => summarize_break_even_spreads([{ ...planned_day("2026-07-01", 200, [30]), cycles: [{}] }], () => 0), /charge_average_price_aud_per_mwh/);
});

test("describe_spread_review: 建議下調時說明保留率、上限與錯過的收益，並列出排除日期", () => {
  const review_description = describe_spread_review(
    review_spread_standards(build_example_days(), 50),
    build_context({ event_view_label: "排除事件日", event_removed_dates: ["2026-07-06"] }),
  );

  assert.match(review_description.title_text, /^建議下調：目前標準 50 AUD\/MWh 只保留 90\.00%/);
  assert.match(review_description.body_text, /不高於 30 AUD\/MWh/);
  assert.match(review_description.body_text, /不代表實際營運收益最高/);
  assert.deepEqual(review_description.kpi_items.map((kpi_item) => kpi_item.label), ["目前標準", "歷史收益保留率", "執行天數", "錯過的機會", "保留 99% 的門檻上限"]);
  const notes_text = review_description.note_lines.join("\n");
  assert.match(notes_text, /事件檢視「排除事件日」/);
  assert.match(notes_text, /資料不完整而排除 1 天：2026-07-05（5 分鐘電價只有 276 筆/);
  assert.match(notes_text, /依事件檢視排除 1 天：2026-07-06/);
  assert.match(notes_text, /注意：樣本不足/);
  assert.match(notes_text, /這是成本說明，不是門檻/);
});

test("describe_spread_review: 維持與不給建議的文字；設備參數讀不到時說明原因", () => {
  const keep_description = describe_spread_review(review_spread_standards(build_example_days(), 30), build_context());
  const empty_description = describe_spread_review(review_spread_standards([], 30), build_context({ battery_error: "HTTP 404" }));

  assert.match(keep_description.title_text, /^維持：/);
  assert.match(empty_description.title_text, /不提供調整建議/);
  assert.deepEqual(empty_description.kpi_items.map((kpi_item) => kpi_item.label), ["目前標準", "有效天數"]);
  assert.match(empty_description.note_lines.join("\n"), /無法讀取設備參數，未顯示損益兩平價差：HTTP 404/);
});

test("draw_spread_review_chart: 每個候選標準一點、標出目前標準與 99% 線；沒有資料時不畫", () => {
  const color_tokens = { "--charge": "teal", "--discharge": "amber", "--cut": "red", "--ink-3": "grey", "--rule": "silver" };
  const saved_globals = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle, window: globalThis.window };
  const created_charts = [];
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: (token_name) => color_tokens[token_name] ?? "" });
  globalThis.window = { Chart: class { constructor(_chart_canvas, chart_configuration) { this.chart_configuration = chart_configuration; created_charts.push(this); } } };
  try {
    let destroy_count = 0;
    const previous_chart = { destroy: () => { destroy_count += 1; } };

    draw_spread_review_chart({}, previous_chart, review_spread_standards(build_example_days(), 50));
    const empty_chart = draw_spread_review_chart({}, previous_chart, review_spread_standards([], 50));

    const [net_series, current_series, retention_series] = created_charts[0].chart_configuration.data.datasets;
    assert.equal(net_series.data.length, 101);
    assert.deepEqual(net_series.data[50], { x: 50, y: 1800 });
    assert.deepEqual(current_series.data, [{ x: 50, y: 1800 }]);
    assert.deepEqual(retention_series.data, [{ x: 0, y: 1980 }, { x: 100, y: 1980 }]);
    assert.equal(empty_chart, null);
    assert.equal(destroy_count, 2);
  } finally {
    Object.assign(globalThis, saved_globals);
  }
});

test("fetch_spread_standard: 讀 config/spread_standard.json 並驗證", async () => {
  const requested_urls = [];
  const valid_payload = { schema_version: 1, spread_standard_aud_per_mwh: 40, effective_date: "2026-10-20", reviewer_name: "營運主管", review_basis: "初始值" };
  const fake_fetch = async (request_url) => {
    requested_urls.push(request_url);
    return { status: 200, ok: true, json: async () => valid_payload };
  };
  const invalid_fetch = async () => ({ status: 200, ok: true, json: async () => ({ ...valid_payload, spread_standard_aud_per_mwh: -1 }) });
  const broken_fetch = async () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("Unexpected token"); } });

  const spread_standard = await fetch_spread_standard({ fetch_function: fake_fetch });

  assert.deepEqual(requested_urls, [SPREAD_STANDARD_URL]);
  assert.ok(SPREAD_STANDARD_URL.endsWith("/config/spread_standard.json"));
  assert.equal(spread_standard.spread_standard_aud_per_mwh, 40);
  await assert.rejects(fetch_spread_standard({ fetch_function: invalid_fetch }), /0 以上/);
  await assert.rejects(fetch_spread_standard({ fetch_function: broken_fetch }), /config\/spread_standard\.json 不是合法的 JSON/);
});

test("repo 的每日摘要與價差標準可以直接完成檢討與成本說明", () => {
  const daily_summary = parse_daily_summary(JSON.parse(readFileSync(REPOSITORY_SUMMARY_FILE, "utf8")));
  const spread_standard = parse_spread_standard(JSON.parse(readFileSync(REPOSITORY_STANDARD_FILE, "utf8")));
  const battery_spec = { round_trip_efficiency: 0.85, degradation_cost_aud_per_mwh: 8, marginal_loss_factor: 1 };

  const spread_review = review_spread_standards(daily_summary.days, spread_standard.spread_standard_aud_per_mwh);
  const cost_summary = summarize_break_even_spreads(daily_summary.days, (charge_average_price) => break_even_spread(charge_average_price, battery_spec));

  assert.ok(["keep", "lower"].includes(spread_review.status), spread_review.status);
  assert.equal(spread_review.sweep_points[0].net_value_aud, spread_review.maximum_value_aud);
  assert.ok(cost_summary.cycle_count > 0);
});

test("scenario/index.html: 價差標準檢討用到的元素都存在", () => {
  const page_html = readFileSync(SCENARIO_PAGE_FILE, "utf8");

  for (const element_id of REVIEW_ELEMENT_IDS) assert.match(page_html, new RegExp(`id="${element_id}"`), element_id);
});
