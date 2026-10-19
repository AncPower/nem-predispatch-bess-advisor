import assert from "node:assert/strict";
import { test } from "node:test";

import { simulate_threshold_dispatch } from "../src/threshold_dispatch.js";

const SMALL_BATTERY = Object.freeze({ power_mw: 2, capacity_mwh: 2, marginal_loss_factor: 1, initial_soc_fraction: 0 });
const THRESHOLDS = Object.freeze({ charge_price_cap: 0, discharge_price_floor: 100 });

test("simulate_threshold_dispatch: 低價充、高價放，效率 100% 不計損耗", () => {
  const dispatch_result = simulate_threshold_dispatch([0, 0, 100, 100], SMALL_BATTERY, THRESHOLDS);

  assert.equal(dispatch_result.charged_energy_mwh, 2);
  assert.equal(dispatch_result.discharged_energy_mwh, 2);
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
