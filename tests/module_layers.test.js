import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const SOURCE_DIRECTORY = new URL("../src/", import.meta.url);
const MODULE_LAYERS = Object.freeze({
  "nem_time.js": 0,
  "csv_line.js": 0,
  "http_request.js": 0,
  "number_format.js": 0,
  "day_shape.js": 0,
  "scenario_presets.js": 0,
  "window_selection.js": 1,
  "threshold_dispatch.js": 1,
  "data_freshness.js": 1,
  "wait_streak.js": 1,
  "price_simulation.js": 1,
  "spread_strategy.js": 1,
  "history_calibration.js": 1,
  "event_days.js": 1,
  "spread_review.js": 1,
  "dashboard_source.js": 2,
  "upload_parser.js": 2,
  "special_dates.js": 2,
  "daily_summary.js": 2,
  "shared_configuration.js": 2,
  "page_render.js": 3,
  "scenario_render.js": 3,
  "spread_review_render.js": 3,
  "app.js": 4,
  "scenario_app.js": 4,
});
const IMPORT_PATTERN = /from\s+"\.\/([\w.]+)"/g;

/** 讀出模組匯入的本地模組名稱。 */
function read_local_imports(module_name) {
  const module_text = readFileSync(new URL(module_name, SOURCE_DIRECTORY), "utf8");
  return [...module_text.matchAll(IMPORT_PATTERN)].map((import_match) => import_match[1]);
}

test("module_layers: src/ 每個模組都登記了層級", () => {
  const source_files = readdirSync(SOURCE_DIRECTORY).filter((file_name) => file_name.endsWith(".js")).sort();

  assert.deepEqual(source_files, Object.keys(MODULE_LAYERS).sort());
});

test("module_layers: 只能匯入較低層的模組", () => {
  for (const [module_name, module_layer] of Object.entries(MODULE_LAYERS)) {
    for (const imported_name of read_local_imports(module_name)) {
      assert.ok(MODULE_LAYERS[imported_name] < module_layer, `${module_name}（L${module_layer}）匯入了 ${imported_name}`);
    }
  }
});
