import assert from "node:assert/strict";
import { test } from "node:test";

import { format_remaining_energy_label } from "../src/page_render.js";

test("format_remaining_energy_label: 當日結束與預測期末的文字與單位", () => {
  assert.equal(
    format_remaining_energy_label({ interval_index: 9, marker_kind: "day_end", stored_energy_mwh: 5, stored_fraction: 0.25 }),
    "當日結束 剩餘 5.0 MWh（25%）",
  );
  assert.equal(
    format_remaining_energy_label({ interval_index: 64, marker_kind: "horizon_end", stored_energy_mwh: 12.5, stored_fraction: 0.625 }),
    "預測期末 剩餘 12.5 MWh（63%）",
  );
});
