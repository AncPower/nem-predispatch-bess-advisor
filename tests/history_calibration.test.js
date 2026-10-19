import assert from "node:assert/strict";
import { test } from "node:test";

import { calibrate_from_history, fit_day_shape, parse_history_csv, select_calibration_region } from "../src/history_calibration.js";
import { bell_weight } from "../src/day_shape.js";
import { MARKET_PRESETS } from "../src/scenario_presets.js";

/** 依已知型態產生小時電價：基準 100、清晨 +0.2、午間凹陷 0.5、傍晚尖峰 0.4。 */
function known_shape_price(hour_value) {
  return 100 * (0.85 + 0.2 * bell_weight(hour_value, 7.5, 1.5) - 0.5 * bell_weight(hour_value, 12.5, 2.6) + 0.4 * bell_weight(hour_value, 19, 1.8));
}

/** 產生多天、每 30 分鐘一筆的 AEMO 月檔格式 CSV。 */
function build_history_csv(day_count, region_ids = ["NSW1"]) {
  const csv_lines = ["REGION,SETTLEMENTDATE,TOTALDEMAND,RRP,PERIODTYPE"];
  for (const region_id of region_ids) {
    for (let day_index = 1; day_index <= day_count; day_index++) {
      for (let half_hour = 0; half_hour < 48; half_hour++) {
        const hour_value = Math.floor(half_hour / 2);
        const minute_text = half_hour % 2 ? "30" : "00";
        const day_text = String(day_index).padStart(2, "0");
        csv_lines.push(`${region_id},2026/09/${day_text} ${String(hour_value).padStart(2, "0")}:${minute_text}:00,7000,${known_shape_price(hour_value).toFixed(4)},TRADE`);
      }
    }
  }
  return csv_lines.join("\n");
}

test("parse_history_csv: 讀出 AEMO 月檔格式", () => {
  const history_rows = parse_history_csv(build_history_csv(2));

  assert.equal(history_rows.length, 96);
  assert.deepEqual({ ...history_rows[1], price_value: undefined }, { date_text: "2026-09-01", hour_value: 0.5, price_value: undefined, region_id: "NSW1" });
});

test("parse_history_csv: 缺電價欄時拋出錯誤", () => {
  assert.throws(() => parse_history_csv("DATE,VALUE\n2026-09-01 00:00,1\n2026-09-01 01:00,2"), /找不到日期時間欄與電價欄/);
});

test("fit_day_shape: 從已知型態還原係數", () => {
  const fitted_shape = fit_day_shape(Array.from({ length: 24 }, (_unused, hour_value) => known_shape_price(hour_value)));

  assert.ok(Math.abs(fitted_shape.base_level - 100) < 1e-6);
  assert.ok(Math.abs(fitted_shape.solar_dip - 0.5) < 1e-6);
  assert.ok(Math.abs(fitted_shape.evening_peak - 0.4) < 1e-6);
});

test("select_calibration_region: 多個區域時優先用 NSW1", () => {
  const region_choice = select_calibration_region(parse_history_csv(build_history_csv(1, ["QLD1", "NSW1"])));

  assert.equal(region_choice.region_id, "NSW1");
  assert.equal(region_choice.region_count, 2);
  assert.ok(region_choice.region_rows.every((history_row) => history_row.region_id === "NSW1"));
});

test("calibrate_from_history: 排除的日期不納入", () => {
  const history_rows = parse_history_csv(build_history_csv(5));

  const calibration_result = calibrate_from_history(history_rows, new Set(["2026-09-01", "2026-09-02"]), MARKET_PRESETS.nsw, "PRICE_AND_DEMAND_202609_NSW1.csv");

  assert.equal(calibration_result.calibration_stats.used_days, 3);
  assert.equal(calibration_result.calibration_stats.excluded_days, 2);
  assert.equal(calibration_result.calibrated_preset.base_price, 100);
  assert.equal(calibration_result.calibrated_preset.currency_code, "AUD");
});

test("calibrate_from_history: 排除後不足 3 天時拋出錯誤", () => {
  const history_rows = parse_history_csv(build_history_csv(3));

  assert.throws(() => calibrate_from_history(history_rows, new Set(["2026-09-01"]), MARKET_PRESETS.nsw, "x.csv"), /少於 3 天/);
});
