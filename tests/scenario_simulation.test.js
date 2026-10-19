import assert from "node:assert/strict";
import { test } from "node:test";

import { summarize_day_windows } from "../src/day_shape.js";
import { simulate_price_paths, summarize_hourly_percentiles } from "../src/price_simulation.js";
import { MARKET_PRESETS, NEWS_ADJUSTMENTS, clamp_to_field_limits, default_parameters } from "../src/scenario_presets.js";
import { choose_best_standard, decide_verdict, evaluate_spread_strategy, summarize_first_day } from "../src/spread_strategy.js";

const SMALL_RUN = Object.freeze({ path_count: 20 });

/** 4 小時窗用的一天電價：0–3 時 10、4–7 時 20、其餘 50，16–19 時 200。 */
function build_example_day() {
  return Array.from({ length: 24 }, (_unused, hour_value) => {
    if (hour_value < 4) return 10;
    if (hour_value >= 16 && hour_value < 20) return 200;
    return 50;
  });
}

/** 依（路徑、天）摘要值組出一個最小的模擬結果。 */
function build_fixed_simulation(day_summaries) {
  const cell_count = day_summaries.length;
  return {
    path_count: 1, day_count: cell_count, hourly_prices: new Float32Array(cell_count * 24),
    low_average: Float32Array.from(day_summaries.map((day_summary) => day_summary.low_average)),
    low_start_hour: Int8Array.from(day_summaries.map(() => 0)),
    high_after_average: Float32Array.from(day_summaries.map((day_summary) => day_summary.high_after_average)),
    high_after_start_hour: Int8Array.from(day_summaries.map(() => 4)),
    high_any_average: Float32Array.from(day_summaries.map((day_summary) => day_summary.high_any_average)),
  };
}

test("summarize_day_windows: 找出最低窗與其後最高窗", () => {
  const day_summary = summarize_day_windows(build_example_day(), 4);

  assert.equal(day_summary.low_start_hour, 0);
  assert.equal(day_summary.high_after_start_hour, 16);
  assert.equal(day_summary.high_after_average - day_summary.low_average, 190);
});

test("summarize_day_windows: 最低窗在最後時其後放不下窗", () => {
  const day_prices = Array.from({ length: 24 }, (_unused, hour_value) => (hour_value >= 20 ? 0 : 100));

  const day_summary = summarize_day_windows(day_prices, 4);

  assert.equal(day_summary.high_after_start_hour, -1);
  assert.equal(day_summary.high_after_average, Number.NEGATIVE_INFINITY);
});

test("summarize_day_windows: 含 NaN 的窗不會被選為其後最高窗", () => {
  const day_prices = build_example_day();
  day_prices[17] = Number.NaN;

  const day_summary = summarize_day_windows(day_prices, 4);

  assert.ok(day_summary.high_after_start_hour < 14 || day_summary.high_after_start_hour > 17);
});

test("simulate_price_paths: 同樣輸入與種子得到同樣結果", () => {
  const parameters = default_parameters(MARKET_PRESETS.nsw);

  const first_run = simulate_price_paths(parameters, MARKET_PRESETS.nsw, SMALL_RUN);
  const second_run = simulate_price_paths(parameters, MARKET_PRESETS.nsw, SMALL_RUN);

  assert.deepEqual(first_run.hourly_prices, second_run.hourly_prices);
  assert.equal(first_run.hourly_prices.length, 20 * 30 * 24);
});

test("simulate_price_paths: 電價夾在價格上下限之間", () => {
  const parameters = { ...default_parameters(MARKET_PRESETS.nsw), price_cap: 120, price_floor: 30, spike_probability: 30 };

  const simulation = simulate_price_paths(parameters, MARKET_PRESETS.nsw, SMALL_RUN);

  assert.ok(simulation.hourly_prices.every((hour_price) => hour_price >= 30 && hour_price <= 120));
});

test("summarize_hourly_percentiles: P10 ≤ 中位數 ≤ P90", () => {
  const simulation = simulate_price_paths(default_parameters(MARKET_PRESETS.nsw), MARKET_PRESETS.nsw, SMALL_RUN);

  const hourly_percentiles = summarize_hourly_percentiles(simulation, 7);

  hourly_percentiles.p50_values.forEach((median_price, hour_value) => {
    assert.ok(hourly_percentiles.p10_values[hour_value] <= median_price && median_price <= hourly_percentiles.p90_values[hour_value]);
  });
  assert.equal(hourly_percentiles.used_days, 7);
});

test("evaluate_spread_strategy: 當日達標就放電，效率 100% 不計損耗", () => {
  const simulation = build_fixed_simulation([{ low_average: 10, high_after_average: 110, high_any_average: 110 }]);

  const strategy_outcome = evaluate_spread_strategy(simulation, { power_mw: 5, maximum_wait_days: 3 }, 50);

  assert.equal(strategy_outcome.mean_value, 20 * 100);
  assert.equal(strategy_outcome.average_cycles, 1);
});

test("evaluate_spread_strategy: 一直未達標時等滿天數強制放電", () => {
  const flat_day = { low_average: 10, high_after_average: 20, high_any_average: 30 };
  const simulation = build_fixed_simulation([flat_day, flat_day, flat_day]);

  const strategy_outcome = evaluate_spread_strategy(simulation, { power_mw: 5, maximum_wait_days: 2 }, 50);

  assert.equal(strategy_outcome.average_forced, 1);
  assert.equal(strategy_outcome.mean_value, 20 * 20);
  assert.equal(strategy_outcome.average_wait_days, 2);
});

test("summarize_first_day: 達標機率與最常見時段", () => {
  const simulation = build_fixed_simulation([{ low_average: 10, high_after_average: 110, high_any_average: 110 }]);

  const first_day = summarize_first_day(simulation, 100);

  assert.equal(first_day.hit_probability, 1);
  assert.equal(first_day.common_charge_hour, 0);
  assert.equal(first_day.common_discharge_hour, 4);
});

test("choose_best_standard: 在最高收益 1% 內取最高的標準", () => {
  const sweep_points = [
    { spread_standard: 0, mean_value: 900 },
    { spread_standard: 10, mean_value: 1000 },
    { spread_standard: 20, mean_value: 995 },
    { spread_standard: 30, mean_value: 500 },
  ];

  assert.equal(choose_best_standard(sweep_points).spread_standard, 20);
});

test("decide_verdict: 三種燈號", () => {
  assert.equal(decide_verdict(0.6, 100, 50), "discharge");
  assert.equal(decide_verdict(0.3, 55, 50), "wait");
  assert.equal(decide_verdict(0.3, 80, 50), "lower");
  assert.equal(decide_verdict(0.1, 50, 50), "lower");
});

test("clamp_to_field_limits: 新聞事件疊加後拉回欄位上下限", () => {
  const parameters = default_parameters(MARKET_PRESETS.nsw);
  const heat_wave = NEWS_ADJUSTMENTS.find((news_adjustment) => news_adjustment.label_text === "熱浪或寒流");
  for (let repeat_index = 0; repeat_index < 10; repeat_index++) heat_wave.apply_adjustment(parameters);

  clamp_to_field_limits(parameters, MARKET_PRESETS.nsw);

  assert.equal(parameters.demand_change, 30);
  assert.equal(parameters.spike_probability, 30);
});

test("default_parameters: 電池預設 5 MW", () => {
  assert.equal(default_parameters(MARKET_PRESETS.nsw).power_mw, 5);
});
