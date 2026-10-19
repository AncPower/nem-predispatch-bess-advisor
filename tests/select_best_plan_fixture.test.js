import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { select_best_plan } from "../src/window_selection.js";

// 同一份案例也由 analysis/tests/test_arbitrage_revenue.py 讀取，確認 Python 版與 JS 版結果一致。
const FIXTURE_CASES = JSON.parse(readFileSync(new URL("./fixtures/select_best_plan_cases.json", import.meta.url), "utf8"));

for (const fixture_case of FIXTURE_CASES) {
  test(`select_best_plan 共用案例：${fixture_case.case_name}`, () => {
    const plan_result = select_best_plan(fixture_case.price_values, fixture_case.battery_spec, fixture_case.minimum_cycle_spread);

    assert.deepEqual(plan_result, fixture_case.expected_plan);
  });
}
