import assert from "node:assert/strict";
import { test } from "node:test";

import { simulate_threshold_dispatch } from "../src/threshold_dispatch.js";
import { break_even_spread, segment_length_for, select_best_plan, suggest_price_thresholds } from "../src/window_selection.js";

const LOSSLESS_COSTS = Object.freeze({ round_trip_efficiency: 1, degradation_cost_aud_per_mwh: 0 });
const FOUR_HOUR_BATTERY = Object.freeze({ power_mw: 5, capacity_mwh: 20, marginal_loss_factor: 1, ...LOSSLESS_COSTS });
const ONE_INTERVAL_BATTERY = Object.freeze({ power_mw: 2, capacity_mwh: 1, marginal_loss_factor: 1, ...LOSSLESS_COSTS });
const TWO_INTERVAL_BATTERY = Object.freeze({ power_mw: 2, capacity_mwh: 2, marginal_loss_factor: 1, ...LOSSLESS_COSTS });

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

test("select_best_plan: 來回效率 0.8 時放電量為充電量的 0.8 倍，淨收益扣掉效率損失", () => {
  const plan_result = select_best_plan([10, 110], { ...ONE_INTERVAL_BATTERY, round_trip_efficiency: 0.8 });

  assert.equal(plan_result.energy_mwh, 1);
  assert.equal(plan_result.discharge_energy_mwh, 0.8);
  assert.ok(Math.abs(plan_result.total_value - 78) < 1e-9);
});

test("select_best_plan: 損耗成本讓小價差循環變成虧損時不排", () => {
  const price_values = [50, 60, 0, 100];

  const lossless_plan = select_best_plan(price_values, ONE_INTERVAL_BATTERY);
  const costly_plan = select_best_plan(price_values, { ...ONE_INTERVAL_BATTERY, degradation_cost_aud_per_mwh: 15 });

  assert.equal(lossless_plan.cycles.length, 2);
  assert.deepEqual(
    costly_plan.cycles.map((planned_cycle) => [planned_cycle.charge_start_index, planned_cycle.discharge_start_index]),
    [[2, 3]],
  );
  assert.equal(costly_plan.total_value, 85);
});

test("select_best_plan: 價差剛好等於損益兩平價差時淨收益為 0，不排", () => {
  const battery_spec = { ...ONE_INTERVAL_BATTERY, round_trip_efficiency: 0.8, degradation_cost_aud_per_mwh: 5 };

  assert.equal(break_even_spread(100, battery_spec), 30);
  assert.deepEqual(select_best_plan([100, 130], battery_spec).cycles, []);
  assert.equal(select_best_plan([100, 131], battery_spec).cycles.length, 1);
});

test("select_best_plan: 來回效率不在 (0, 1] 或損耗成本為負、缺漏時拋出錯誤", () => {
  assert.throws(() => select_best_plan([0, 100], { ...ONE_INTERVAL_BATTERY, round_trip_efficiency: 0 }), /來回效率/);
  assert.throws(() => select_best_plan([0, 100], { ...ONE_INTERVAL_BATTERY, round_trip_efficiency: 1.01 }), /來回效率/);
  assert.throws(() => select_best_plan([0, 100], { power_mw: 2, capacity_mwh: 1, marginal_loss_factor: 1 }), /來回效率/);
  assert.throws(() => select_best_plan([0, 100], { ...ONE_INTERVAL_BATTERY, degradation_cost_aud_per_mwh: -1 }), /損耗成本/);
});

test("break_even_spread: 充電均價 ×（1 ÷ 效率 − 1）＋ 損耗成本 ÷ MLF", () => {
  assert.equal(break_even_spread(100, ONE_INTERVAL_BATTERY), 0);
  assert.equal(break_even_spread(100, { ...ONE_INTERVAL_BATTERY, round_trip_efficiency: 0.8 }), 25);
  assert.equal(break_even_spread(100, { ...ONE_INTERVAL_BATTERY, degradation_cost_aud_per_mwh: 9, marginal_loss_factor: 0.9 }), 10);
  assert.equal(break_even_spread(-40, { ...ONE_INTERVAL_BATTERY, round_trip_efficiency: 0.8 }), -10);
});

test("suggest_price_thresholds: 充電上限取充電段最高價、價差到放電段最低價", () => {
  const price_values = [10, 20, 200, 150];
  const plan_result = select_best_plan(price_values, TWO_INTERVAL_BATTERY);

  const price_thresholds = suggest_price_thresholds(price_values, plan_result);

  assert.deepEqual(price_thresholds, { charge_price_cap: 20, price_spread: 130 });
});

test("suggest_price_thresholds: 放電段最低價低於充電上限時價差為 0", () => {
  const price_values = [0, 60, 50, 200];
  const plan_result = select_best_plan(price_values, TWO_INTERVAL_BATTERY);

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

test("select_best_plan: 小循環的價差低於門檻時只排一個", () => {
  const price_values = [100, 102, 0, 300];

  const plan_result = select_best_plan(price_values, ONE_INTERVAL_BATTERY, 10);

  assert.deepEqual(
    plan_result.cycles.map((planned_cycle) => [planned_cycle.charge_start_index, planned_cycle.discharge_start_index]),
    [[2, 3]],
  );
  assert.equal(plan_result.total_value, 300);
});

test("select_best_plan: 價差剛好等於門檻時仍排入", () => {
  const plan_result = select_best_plan([100, 102, 0, 300], ONE_INTERVAL_BATTERY, 2);

  assert.equal(plan_result.cycles.length, 2);
});

test("select_best_plan: 門檻高於所有價差時不排", () => {
  const plan_result = select_best_plan([0, 100], ONE_INTERVAL_BATTERY, 101);

  assert.deepEqual(plan_result.cycles, []);
});

test("select_best_plan: 門檻為負或非數值時拋出錯誤", () => {
  assert.throws(() => select_best_plan([0, 100], ONE_INTERVAL_BATTERY, -1), /最低價差/);
  assert.throws(() => select_best_plan([0, 100], ONE_INTERVAL_BATTERY, Number.NaN), /最低價差/);
});

/** 固定種子的亂數，讓比對測試可重現。 */
function create_seeded_random(seed_value) {
  let random_state = seed_value;
  return () => {
    random_state = (random_state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return random_state / 2_147_483_648;
  };
}

/** 暴力列舉所有一與兩循環組合的最高總價差（每段價格總和差）。 */
function brute_force_best_score(price_values, segment_length, minimum_cycle_spread) {
  const segment_sum = (start_index) => price_values.slice(start_index, start_index + segment_length).reduce((left, right) => left + right, 0);
  const last_start = price_values.length - segment_length;
  const valid_cycles = [];
  for (let charge_start = 0; charge_start <= last_start; charge_start++) {
    for (let discharge_start = charge_start + segment_length; discharge_start <= last_start; discharge_start++) {
      const cycle_score = segment_sum(discharge_start) - segment_sum(charge_start);
      if (cycle_score > 0 && cycle_score >= minimum_cycle_spread * segment_length) valid_cycles.push({ charge_start, discharge_start, cycle_score });
    }
  }
  let best_score = 0;
  for (const first_cycle of valid_cycles) {
    best_score = Math.max(best_score, first_cycle.cycle_score);
    for (const second_cycle of valid_cycles) {
      if (second_cycle.charge_start >= first_cycle.discharge_start + segment_length) {
        best_score = Math.max(best_score, first_cycle.cycle_score + second_cycle.cycle_score);
      }
    }
  }
  return best_score;
}

test("select_best_plan: 隨機電價下與暴力解的最佳總價差相同", () => {
  const next_random = create_seeded_random(20261019);
  for (let case_index = 0; case_index < 200; case_index++) {
    const price_values = Array.from({ length: 6 + Math.floor(next_random() * 14) }, () => Math.round(next_random() * 400 - 100));
    const minimum_cycle_spread = Math.round(next_random() * 60);

    const plan_result = select_best_plan(price_values, TWO_INTERVAL_BATTERY, minimum_cycle_spread);

    const expected_score = brute_force_best_score(price_values, 2, minimum_cycle_spread);
    assert.equal(plan_result.total_value, expected_score, `case ${case_index}: ${price_values}`);
  }
});

/** 暴力列舉所有一與兩循環組合的最高淨收益（每時段 1 MWh 充電、效率 × 1 MWh 放電、每 MWh 放電扣損耗）。 */
function brute_force_best_net_value(price_values, segment_length, battery_spec) {
  const segment_sum = (start_index) => price_values.slice(start_index, start_index + segment_length).reduce((left, right) => left + right, 0);
  const last_start = price_values.length - segment_length;
  const efficiency = battery_spec.round_trip_efficiency;
  const valid_cycles = [];
  for (let charge_start = 0; charge_start <= last_start; charge_start++) {
    for (let discharge_start = charge_start + segment_length; discharge_start <= last_start; discharge_start++) {
      const charge_sum = segment_sum(charge_start);
      const discharge_sum = segment_sum(discharge_start);
      const net_value = efficiency * discharge_sum - charge_sum - efficiency * segment_length * battery_spec.degradation_cost_aud_per_mwh;
      if (discharge_sum > charge_sum && net_value > 1e-9) valid_cycles.push({ charge_start, discharge_start, net_value });
    }
  }
  let best_value = 0;
  for (const first_cycle of valid_cycles) {
    best_value = Math.max(best_value, first_cycle.net_value);
    for (const second_cycle of valid_cycles) {
      if (second_cycle.charge_start >= first_cycle.discharge_start + segment_length) {
        best_value = Math.max(best_value, first_cycle.net_value + second_cycle.net_value);
      }
    }
  }
  return best_value;
}

test("select_best_plan: 隨機電價、效率與損耗下與暴力解的最佳淨收益相同", () => {
  const next_random = create_seeded_random(20261020);
  for (let case_index = 0; case_index < 200; case_index++) {
    const price_values = Array.from({ length: 6 + Math.floor(next_random() * 14) }, () => Math.round(next_random() * 400 - 100));
    const battery_spec = {
      ...TWO_INTERVAL_BATTERY,
      round_trip_efficiency: 0.5 + Math.round(next_random() * 50) / 100,
      degradation_cost_aud_per_mwh: Math.round(next_random() * 30),
    };

    const plan_result = select_best_plan(price_values, battery_spec);

    const expected_value = brute_force_best_net_value(price_values, 2, battery_spec);
    assert.ok(Math.abs(plan_result.total_value - expected_value) < 1e-6, `case ${case_index}: ${price_values}`);
  }
});

test("suggest_price_thresholds: 小數電價時充電上限進位、放電下限捨去", () => {
  const price_values = [57.4, 68.3, 299.98, 367.2];
  const plan_result = select_best_plan(price_values, TWO_INTERVAL_BATTERY);

  const price_thresholds = suggest_price_thresholds(price_values, plan_result);

  assert.deepEqual(price_thresholds, { charge_price_cap: 69, price_spread: 230 });
});

test("suggest_price_thresholds: 用建議門檻模擬時，充滿與放完的時段正好是主循環的窗", () => {
  const price_values = [
    120, 118, 64.0, 61.1, 60.9, 57.4, 57.4, 57.4, 61.4, 68.3, 75, 90,
    367.2, 299.98, 299.95, 599.0, 495.4, 323.8, 302.1, 494.3, 240, 290,
  ];
  const plan_result = select_best_plan(price_values, { ...FOUR_HOUR_BATTERY });
  const main_cycle = plan_result.cycles.reduce((best_cycle, planned_cycle) => (planned_cycle.net_value > best_cycle.net_value ? planned_cycle : best_cycle));
  const price_thresholds = suggest_price_thresholds(price_values, plan_result);

  const dispatch_result = simulate_threshold_dispatch(price_values, { ...FOUR_HOUR_BATTERY, initial_soc_fraction: 0 }, {
    charge_price_cap: price_thresholds.charge_price_cap,
    discharge_price_floor: price_thresholds.charge_price_cap + price_thresholds.price_spread,
  });

  const charge_indexes = dispatch_result.interval_energy_mwh.flatMap((energy_change, interval_index) => (energy_change > 0 ? [interval_index] : []));
  const discharge_indexes = dispatch_result.interval_energy_mwh.flatMap((energy_change, interval_index) => (energy_change < 0 ? [interval_index] : []));
  const window_indexes = (start_index) => Array.from({ length: plan_result.segment_length }, (_unused, offset) => start_index + offset);
  assert.deepEqual(charge_indexes, window_indexes(main_cycle.charge_start_index));
  assert.deepEqual(discharge_indexes, window_indexes(main_cycle.discharge_start_index));
  assert.equal(dispatch_result.final_soc_fraction, 0);
});
