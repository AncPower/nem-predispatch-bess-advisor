import assert from "node:assert/strict";
import { test } from "node:test";

import { parse_nem_timestamp } from "../src/nem_time.js";
import { find_remaining_energy_markers, simulate_threshold_dispatch } from "../src/threshold_dispatch.js";
import { select_best_plan, suggest_price_thresholds } from "../src/window_selection.js";

const SMALL_BATTERY = Object.freeze({
  power_mw: 2,
  capacity_mwh: 2,
  marginal_loss_factor: 1,
  round_trip_efficiency: 1,
  degradation_cost_aud_per_mwh: 0,
  initial_soc_fraction: 0,
});
const LOSSY_BATTERY = Object.freeze({ ...SMALL_BATTERY, marginal_loss_factor: 0.97, round_trip_efficiency: 0.85, degradation_cost_aud_per_mwh: 8 });
const THRESHOLDS = Object.freeze({ charge_price_cap: 0, discharge_price_floor: 100 });
const VALUE_TOLERANCE_AUD = 1e-9;

test("simulate_threshold_dispatch: 低價充、高價放，效率 1、損耗 0 時與只看價差相同", () => {
  const dispatch_result = simulate_threshold_dispatch([0, 0, 100, 100], SMALL_BATTERY, THRESHOLDS);

  assert.equal(dispatch_result.charged_energy_mwh, 2);
  assert.equal(dispatch_result.discharged_energy_mwh, 2);
  assert.equal(dispatch_result.degradation_cost, 0);
  assert.equal(dispatch_result.net_value, 200);
  assert.equal(dispatch_result.final_soc_fraction, 0);
});

test("simulate_threshold_dispatch: 電池滿了就不再充", () => {
  const dispatch_result = simulate_threshold_dispatch([0, 0, 0], SMALL_BATTERY, THRESHOLDS);

  assert.deepEqual(dispatch_result.interval_energy_mwh, [1, 1, 0]);
});

test("simulate_threshold_dispatch: 空電池遇高價不放", () => {
  const dispatch_result = simulate_threshold_dispatch([100], SMALL_BATTERY, THRESHOLDS);

  assert.deepEqual(dispatch_result.interval_energy_mwh, [0]);
});

test("simulate_threshold_dispatch: 起始電量可以直接放", () => {
  const dispatch_result = simulate_threshold_dispatch([100], { ...SMALL_BATTERY, initial_soc_fraction: 1 }, THRESHOLDS);

  assert.equal(dispatch_result.discharge_revenue, 100);
  assert.equal(dispatch_result.final_soc_fraction, 0.5);
});

test("simulate_threshold_dispatch: 放電入網量＝取出量 × 來回效率，每 MWh 放電扣損耗成本，結算乘 MLF", () => {
  const dispatch_result = simulate_threshold_dispatch([10, 20, 200, 300], LOSSY_BATTERY, { charge_price_cap: 20, discharge_price_floor: 200 });

  assert.equal(dispatch_result.charged_energy_mwh, 2);
  assert.ok(Math.abs(dispatch_result.discharged_energy_mwh - 1.7) < 1e-12);
  assert.deepEqual(dispatch_result.stored_energy_mwh, [1, 2, 1, 0]);
  assert.ok(Math.abs(dispatch_result.charge_cost - 30 * 0.97) < VALUE_TOLERANCE_AUD);
  assert.ok(Math.abs(dispatch_result.discharge_revenue - 0.85 * 500 * 0.97) < VALUE_TOLERANCE_AUD);
  assert.ok(Math.abs(dispatch_result.degradation_cost - 1.7 * 8) < VALUE_TOLERANCE_AUD);
  assert.ok(Math.abs(dispatch_result.net_value - 369.55) < VALUE_TOLERANCE_AUD);
});

test("simulate_threshold_dispatch: 以建議價格從空電池跑單一循環，淨收益與 select_best_plan 一致（效率 0.85、損耗 8、MLF 0.97）", () => {
  const price_values = [10, 20, 50, 200, 300, 40];
  const plan_result = select_best_plan(price_values, LOSSY_BATTERY);
  const suggested_thresholds = suggest_price_thresholds(price_values, plan_result);
  const price_thresholds = {
    charge_price_cap: suggested_thresholds.charge_price_cap,
    discharge_price_floor: suggested_thresholds.charge_price_cap + suggested_thresholds.price_spread,
  };

  const dispatch_result = simulate_threshold_dispatch(price_values, LOSSY_BATTERY, price_thresholds);

  assert.equal(plan_result.cycles.length, 1);
  assert.ok(Math.abs(dispatch_result.net_value - plan_result.total_value) < VALUE_TOLERANCE_AUD);
  assert.ok(Math.abs(dispatch_result.discharged_energy_mwh - plan_result.discharge_energy_mwh) < 1e-12);
  assert.equal(dispatch_result.charged_energy_mwh, plan_result.energy_mwh);
});

test("simulate_threshold_dispatch: 缺來回效率或損耗成本時報錯，不算出 NaN", () => {
  const { round_trip_efficiency: _efficiency, ...missing_efficiency } = SMALL_BATTERY;
  const { degradation_cost_aud_per_mwh: _degradation, ...missing_degradation } = SMALL_BATTERY;

  assert.throws(() => simulate_threshold_dispatch([0], missing_efficiency, THRESHOLDS), /來回效率/);
  assert.throws(() => simulate_threshold_dispatch([0], missing_degradation, THRESHOLDS), /損耗成本/);
  assert.throws(() => simulate_threshold_dispatch([0], { ...SMALL_BATTERY, round_trip_efficiency: 1.2 }, THRESHOLDS), /來回效率/);
});

/** 從某個 NEM 時間起，每 30 分鐘一個時段。 */
function build_price_points(first_end_text, interval_count) {
  const first_end_minute = parse_nem_timestamp(first_end_text);
  return Array.from({ length: interval_count }, (_unused, interval_index) => ({ interval_end_minute: first_end_minute + 30 * interval_index, price: 0 }));
}

test("simulate_threshold_dispatch: 記下每個時段結束時的電量", () => {
  const dispatch_result = simulate_threshold_dispatch([0, 0, 100], SMALL_BATTERY, THRESHOLDS);

  assert.deepEqual(dispatch_result.stored_energy_mwh, [1, 2, 1]);
});

test("find_remaining_energy_markers: 日結束與預測期結束有電時才標示", () => {
  const price_points = build_price_points("2026-10-19T23:30:00", 4);

  const remaining_markers = find_remaining_energy_markers(price_points, [1, 2.5, 2.5, 5], 20);

  assert.deepEqual(remaining_markers, [
    { interval_index: 1, marker_kind: "day_end", stored_energy_mwh: 2.5, stored_fraction: 0.125 },
    { interval_index: 3, marker_kind: "horizon_end", stored_energy_mwh: 5, stored_fraction: 0.25 },
  ]);
});

test("find_remaining_energy_markers: 電池已放完時不標示", () => {
  const price_points = build_price_points("2026-10-19T23:30:00", 3);

  assert.deepEqual(find_remaining_energy_markers(price_points, [5, 0, 0], 20), []);
});

test("find_remaining_energy_markers: 預測期剛好在日結束時只標一次，算預測期結束", () => {
  const price_points = build_price_points("2026-10-19T23:30:00", 2);

  const remaining_markers = find_remaining_energy_markers(price_points, [5, 5], 20);

  assert.deepEqual(remaining_markers.map((remaining_marker) => remaining_marker.marker_kind), ["horizon_end"]);
});
