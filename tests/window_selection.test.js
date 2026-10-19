import assert from "node:assert/strict";
import { test } from "node:test";

import { segment_length_for, select_best_plan, suggest_price_thresholds } from "../src/window_selection.js";

const FOUR_HOUR_BATTERY = Object.freeze({ power_mw: 5, capacity_mwh: 20, marginal_loss_factor: 1 });
const ONE_INTERVAL_BATTERY = Object.freeze({ power_mw: 2, capacity_mwh: 1, marginal_loss_factor: 1 });

/** 每個值重複 `repeat_count` 次，模擬四小時一個價位。 */
function expand_blocks(block_prices, repeat_count) {
  return block_prices.flatMap((block_price) => Array(repeat_count).fill(block_price));
}

test("segment_length_for: 20 MWh / 5 MW 為 8 個 30 分鐘時段", () => {
  assert.equal(segment_length_for(FOUR_HOUR_BATTERY), 8);
});

test("select_best_plan: 一起選能找到逐步選會漏掉的前一個循環", () => {
  const price_values = expand_blocks([50, 150, 0, 20, 300, 100], 8);

  const plan_result = select_best_plan(price_values, FOUR_HOUR_BATTERY);

  assert.deepEqual(
    plan_result.cycles.map((planned_cycle) => [planned_cycle.charge_start_index, planned_cycle.discharge_start_index]),
    [[0, 8], [16, 32]],
  );
  assert.equal(plan_result.total_value, 8000);
});

test("select_best_plan: 第二個循環不賺錢時只排一個", () => {
  const price_values = [10, 100, 50, 50];

  const plan_result = select_best_plan(price_values, ONE_INTERVAL_BATTERY);

  assert.equal(plan_result.cycles.length, 1);
  assert.equal(plan_result.cycles[0].net_value, 90);
});

test("select_best_plan: 一個與兩個循環同分時取一個", () => {
  const price_values = [0, 100, 100, 100];

  const plan_result = select_best_plan(price_values, ONE_INTERVAL_BATTERY);

  assert.equal(plan_result.cycles.length, 1);
});

test("select_best_plan: 同分時取最早的窗口", () => {
  const price_values = [0, 0, 100];

  const plan_result = select_best_plan(price_values, ONE_INTERVAL_BATTERY);
  const first_cycle = plan_result.cycles[0];

  assert.equal(first_cycle.charge_start_index, 0);
  assert.equal(first_cycle.discharge_start_index, 2);
});

test("select_best_plan: 電價一路下跌時不排任何循環", () => {
  const plan_result = select_best_plan([300, 200, 100, 0], ONE_INTERVAL_BATTERY);

  assert.deepEqual(plan_result.cycles, []);
  assert.equal(plan_result.total_value, 0);
});

test("select_best_plan: 時段數放不下一個循環時不排", () => {
  const plan_result = select_best_plan([0, 100], FOUR_HOUR_BATTERY);

  assert.deepEqual(plan_result.cycles, []);
});

test("select_best_plan: 空的電價序列不排", () => {
  assert.deepEqual(select_best_plan([], FOUR_HOUR_BATTERY).cycles, []);
});

test("select_best_plan: 負電價充電也計入收益", () => {
  const plan_result = select_best_plan([-50, 100], ONE_INTERVAL_BATTERY);

  assert.equal(plan_result.total_value, 150);
});

test("select_best_plan: 損失係數只縮放收益", () => {
  const plan_result = select_best_plan([0, 100], { ...ONE_INTERVAL_BATTERY, marginal_loss_factor: 0.9 });

  assert.equal(plan_result.total_value, 90);
});

test("select_best_plan: 電價含 NaN 時拋出錯誤", () => {
  assert.throws(() => select_best_plan([0, Number.NaN], ONE_INTERVAL_BATTERY), /非數值/);
});

test("suggest_price_thresholds: 充電上限取充電段最高價、價差到放電段最低價", () => {
  const price_values = [10, 20, 200, 150];
  const two_interval_battery = { power_mw: 2, capacity_mwh: 2, marginal_loss_factor: 1 };
  const plan_result = select_best_plan(price_values, two_interval_battery);

  const price_thresholds = suggest_price_thresholds(price_values, plan_result);

  assert.deepEqual(price_thresholds, { charge_price_cap: 20, price_spread: 130 });
});

test("suggest_price_thresholds: 放電段最低價低於充電上限時價差為 0", () => {
  const price_values = [0, 60, 50, 200];
  const two_interval_battery = { power_mw: 2, capacity_mwh: 2, marginal_loss_factor: 1 };
  const plan_result = select_best_plan(price_values, two_interval_battery);

  assert.equal(suggest_price_thresholds(price_values, plan_result).price_spread, 0);
});

test("suggest_price_thresholds: 沒有建議循環時放電下限高於最高價", () => {
  const price_values = [300, 100];
  const plan_result = select_best_plan(price_values, ONE_INTERVAL_BATTERY);

  const price_thresholds = suggest_price_thresholds(price_values, plan_result);

  assert.ok(price_thresholds.charge_price_cap + price_thresholds.price_spread > 300);
});

test("suggest_price_thresholds: 空的電價序列回傳 0", () => {
  assert.deepEqual(suggest_price_thresholds([], { segment_length: 1, cycles: [] }), { charge_price_cap: 0, price_spread: 0 });
});

test("suggest_price_thresholds: 取淨收益最高的循環，不是時間上第一個", () => {
  const price_values = [100, 102, 0, 300];
  const plan_result = select_best_plan(price_values, ONE_INTERVAL_BATTERY);

  const price_thresholds = suggest_price_thresholds(price_values, plan_result);

  assert.equal(plan_result.cycles.length, 2);
  assert.deepEqual(price_thresholds, { charge_price_cap: 0, price_spread: 300 });
});
