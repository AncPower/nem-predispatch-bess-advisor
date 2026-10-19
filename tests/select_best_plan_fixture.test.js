import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { select_best_plan } from "../src/window_selection.js";

const FIXTURE_FILE = new URL("./fixtures/select_best_plan_cases.json", import.meta.url);
const FIXTURE_CASES = JSON.parse(readFileSync(FIXTURE_FILE, "utf8")).cases;

test("select_best_plan_fixture: 共用案例至少有一筆", () => {
  assert.ok(FIXTURE_CASES.length > 0);
});

for (const fixture_case of FIXTURE_CASES) {
  test(`select_best_plan_fixture: ${fixture_case.case_name}（${fixture_case.description}）`, () => {
    const plan_result = select_best_plan(
      fixture_case.price_values,
      fixture_case.battery_specification,
      fixture_case.minimum_cycle_spread,
    );

    assert.deepEqual(plan_result, fixture_case.expected);
  });
}
