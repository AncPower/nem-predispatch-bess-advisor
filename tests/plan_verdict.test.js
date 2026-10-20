import assert from "node:assert/strict";
import { test } from "node:test";

import { describe_plan_verdict, format_spread } from "../src/page_render.js";
import { PLAN_ACTIONS, decide_plan_action, select_best_plan } from "../src/window_selection.js";

const ONE_INTERVAL_BATTERY = Object.freeze({
  power_mw: 2, capacity_mwh: 1, marginal_loss_factor: 1, round_trip_efficiency: 1, degradation_cost_aud_per_mwh: 0,
});
const LOSSY_BATTERY = Object.freeze({ ...ONE_INTERVAL_BATTERY, round_trip_efficiency: 0.8, degradation_cost_aud_per_mwh: 5 });

test("decide_plan_action: 價差剛好等於標準時執行（#28）", () => {
  const plan_decision = decide_plan_action([0, 100], ONE_INTERVAL_BATTERY, 100);

  assert.equal(plan_decision.action, PLAN_ACTIONS.execute);
  assert.equal(plan_decision.executable_plan.cycles.length, 1);
  assert.equal(plan_decision.executable_plan.total_value, 100);
  assert.equal(plan_decision.spread_gap, null);
});

test("decide_plan_action: 價差比標準低 1 時等待，差距為 1（#28）", () => {
  const plan_decision = decide_plan_action([0, 100], ONE_INTERVAL_BATTERY, 101);

  assert.equal(plan_decision.action, PLAN_ACTIONS.wait);
  assert.deepEqual(plan_decision.executable_plan.cycles, []);
  assert.equal(plan_decision.executable_plan.total_value, 0);
  assert.equal(plan_decision.best_plan.cycles.length, 1);
  assert.equal(plan_decision.best_cycle_spread, 100);
  assert.equal(plan_decision.spread_gap, 1);
});

test("decide_plan_action: 兩個循環只有一個達標時只執行達標的那一個（#28）", () => {
  const price_values = [100, 102, 0, 300];

  const plan_decision = decide_plan_action(price_values, ONE_INTERVAL_BATTERY, 10);

  assert.equal(plan_decision.best_plan.cycles.length, 2);
  assert.equal(plan_decision.action, PLAN_ACTIONS.execute);
  assert.deepEqual(
    plan_decision.executable_plan.cycles.map((planned_cycle) => [planned_cycle.charge_start_index, planned_cycle.discharge_start_index]),
    [[2, 3]],
  );
});

test("decide_plan_action: 沒有任何獲利組合時等待，沒有最佳價差與差距（#28）", () => {
  const plan_decision = decide_plan_action([300, 200, 100, 0], ONE_INTERVAL_BATTERY, 0);

  assert.equal(plan_decision.action, PLAN_ACTIONS.wait);
  assert.deepEqual(plan_decision.best_plan.cycles, []);
  assert.equal(plan_decision.best_cycle_spread, null);
  assert.equal(plan_decision.spread_gap, null);
  assert.equal(plan_decision.highest_break_even_spread, null);
  assert.equal(plan_decision.standard_below_break_even, false);
});

test("decide_plan_action: 標準為 0 時與 select_best_plan 的結果相同（#28）", () => {
  const price_values = [50, 150, 0, 20, 300, 100, 10, 90];

  const plan_decision = decide_plan_action(price_values, LOSSY_BATTERY, 0);

  assert.deepEqual(plan_decision.executable_plan, select_best_plan(price_values, LOSSY_BATTERY));
  assert.equal(plan_decision.action, PLAN_ACTIONS.execute);
});

test("decide_plan_action: 標準低於損益兩平價差時提示（#28、roadmap D3）", () => {
  const plan_decision = decide_plan_action([100, 200], LOSSY_BATTERY, 20);

  assert.equal(plan_decision.action, PLAN_ACTIONS.execute);
  assert.equal(plan_decision.highest_break_even_spread, 30);
  assert.equal(plan_decision.standard_below_break_even, true);
  assert.equal(decide_plan_action([100, 200], LOSSY_BATTERY, 30).standard_below_break_even, false);
});

test("decide_plan_action: 價差標準為負或非數值時拋出錯誤", () => {
  assert.throws(() => decide_plan_action([0, 100], ONE_INTERVAL_BATTERY, -1), /價差標準/);
  assert.throws(() => decide_plan_action([0, 100], ONE_INTERVAL_BATTERY, Number.NaN), /價差標準/);
});

test("format_spread: 兩位小數、負數以「−」開頭", () => {
  assert.equal(format_spread(12.5), "A$12.50/MWh");
  assert.equal(format_spread(-3), "−A$3.00/MWh");
});

test("describe_plan_verdict: 執行時寫出價差標準與預估淨收益（#28）", () => {
  const plan_verdict = describe_plan_verdict(decide_plan_action([0, 100], ONE_INTERVAL_BATTERY, 100), 100, 0);

  assert.equal(plan_verdict.action, PLAN_ACTIONS.execute);
  assert.equal(plan_verdict.headline, "執行：每個循環的價差都達到價差標準 A$100.00/MWh");
  assert.equal(plan_verdict.detail_lines[0], "共 1 個循環，預估淨收益 A$100；各循環價差 A$100.00/MWh。");
  assert.deepEqual(plan_verdict.warning_lines, []);
});

test("describe_plan_verdict: 等待時寫出最佳組合價差與差距（#28）", () => {
  const plan_verdict = describe_plan_verdict(decide_plan_action([0, 100], ONE_INTERVAL_BATTERY, 101), 101, 0);

  assert.equal(plan_verdict.action, PLAN_ACTIONS.wait);
  assert.equal(plan_verdict.headline, "等待：最佳組合的價差 A$100.00/MWh，比價差標準 A$101.00/MWh 低 A$1.00/MWh");
  assert.match(plan_verdict.detail_lines[0], /本次預測期間內沒有每個循環的價差都達到標準、且淨收益為正的組合/);
});

test("describe_plan_verdict: 沒有任何獲利組合時說明原因（#28）", () => {
  const plan_verdict = describe_plan_verdict(decide_plan_action([300, 0], ONE_INTERVAL_BATTERY, 0), 0, 0);

  assert.equal(plan_verdict.headline, "等待：預測期間內沒有獲利的充放電組合");
});

test("describe_plan_verdict: 標準低於損益兩平價差與連續等待都加提示（#28）", () => {
  const below_break_even = describe_plan_verdict(decide_plan_action([100, 200], LOSSY_BATTERY, 20), 20, 0);
  const long_wait = describe_plan_verdict(decide_plan_action([0, 100], ONE_INTERVAL_BATTERY, 101), 101, 3);
  const short_wait = describe_plan_verdict(decide_plan_action([0, 100], ONE_INTERVAL_BATTERY, 101), 101, 2);

  assert.match(below_break_even.warning_lines[0], /價差標準 A\$20\.00\/MWh 低於損益兩平價差 A\$30\.00\/MWh/);
  assert.match(long_wait.warning_lines[0], /已連續 3 天/);
  assert.deepEqual(short_wait.warning_lines, []);
});
