import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { HttpStatusError } from "../src/http_request.js";
import {
  BATTERY_CONFIGURATION_URL,
  fetch_battery_configuration,
  parse_battery_configuration,
  parse_spread_standard,
} from "../src/shared_configuration.js";

const BATTERY_FILE = new URL("../config/battery.json", import.meta.url);
const SPREAD_STANDARD_FILE = new URL("../config/spread_standard.json", import.meta.url);
const PREDISPATCH_PAGE_FILE = new URL("../index.html", import.meta.url);
const CONFIGURED_INPUT_IDS = Object.freeze(["power_input", "capacity_input", "loss_factor_input"]);

/** 讀 repo 裡的設定檔。 */
function read_repository_json(file_url) {
  return JSON.parse(readFileSync(file_url, "utf8"));
}

/** 合法的設備參數，可用 override_fields 覆寫或加欄位。 */
function build_battery_payload(override_fields = {}) {
  return {
    schema_version: 1,
    power_mw: 5,
    capacity_mwh: 20,
    round_trip_efficiency: 0.85,
    degradation_cost_aud_per_mwh: 8,
    marginal_loss_factor: 0.98,
    ...override_fields,
  };
}

/** 合法的價差標準，可用 override_fields 覆寫或加欄位。 */
function build_spread_payload(override_fields = {}) {
  return {
    schema_version: 1,
    spread_standard_aud_per_mwh: 40,
    effective_date: "2026-10-20",
    reviewer_name: "營運主管",
    review_basis: "2026-07-01 至 2026-09-30 檢討，維持",
    ...override_fields,
  };
}

/** 刪掉一個欄位的副本。 */
function without_field(configuration_payload, field_name) {
  const { [field_name]: _removed_value, ...remaining_fields } = configuration_payload;
  return remaining_fields;
}

test("shared_configuration: repo 的 config/battery.json 格式正確", () => {
  const battery_configuration = parse_battery_configuration(read_repository_json(BATTERY_FILE));

  assert.equal(battery_configuration.power_mw, 5);
  assert.equal(battery_configuration.capacity_mwh, 20);
});

test("shared_configuration: repo 的 config/spread_standard.json 格式正確", () => {
  const spread_standard = parse_spread_standard(read_repository_json(SPREAD_STANDARD_FILE));

  assert.ok(spread_standard.spread_standard_aud_per_mwh >= 0);
});

test("parse_battery_configuration: 合法內容原樣取出五個欄位", () => {
  assert.deepEqual(parse_battery_configuration(build_battery_payload()), {
    power_mw: 5,
    capacity_mwh: 20,
    round_trip_efficiency: 0.85,
    degradation_cost_aud_per_mwh: 8,
    marginal_loss_factor: 0.98,
  });
});

test("parse_battery_configuration: 效率剛好 1、損耗剛好 0 是合法邊界", () => {
  const battery_configuration = parse_battery_configuration(
    build_battery_payload({ round_trip_efficiency: 1, degradation_cost_aud_per_mwh: 0 }),
  );

  assert.equal(battery_configuration.round_trip_efficiency, 1);
  assert.equal(battery_configuration.degradation_cost_aud_per_mwh, 0);
});

test("parse_battery_configuration: 缺欄位時報錯並列出欄名，不套預設值", () => {
  assert.throws(() => parse_battery_configuration(without_field(build_battery_payload(), "marginal_loss_factor")), /缺少欄位：marginal_loss_factor/);
});

test("parse_battery_configuration: 多出未知欄位時報錯（避免打錯欄名被忽略）", () => {
  assert.throws(() => parse_battery_configuration(build_battery_payload({ efficiency: 0.9 })), /未知欄位：efficiency/);
});

test("parse_battery_configuration: schema_version 不符時報錯", () => {
  assert.throws(() => parse_battery_configuration(build_battery_payload({ schema_version: 2 })), /schema_version/);
});

test("parse_battery_configuration: 超出範圍或非數值時報錯", () => {
  const invalid_overrides = [
    { power_mw: 0 },
    { capacity_mwh: -1 },
    { round_trip_efficiency: 0 },
    { round_trip_efficiency: 1.01 },
    { degradation_cost_aud_per_mwh: -0.5 },
    { marginal_loss_factor: 0 },
    { power_mw: "5" },
    { capacity_mwh: null },
  ];
  for (const override_fields of invalid_overrides) {
    assert.throws(() => parse_battery_configuration(build_battery_payload(override_fields)), /必須是/, JSON.stringify(override_fields));
  }
});

test("parse_battery_configuration: 不是 JSON 物件時報錯", () => {
  for (const configuration_payload of [null, [], "config", 5]) {
    assert.throws(() => parse_battery_configuration(configuration_payload), /必須是 JSON 物件/);
  }
});

test("parse_spread_standard: 合法內容取出四個欄位，文字去除前後空白", () => {
  assert.deepEqual(parse_spread_standard(build_spread_payload({ reviewer_name: "  營運主管 " })), {
    spread_standard_aud_per_mwh: 40,
    effective_date: "2026-10-20",
    reviewer_name: "營運主管",
    review_basis: "2026-07-01 至 2026-09-30 檢討，維持",
  });
});

test("parse_spread_standard: 價差標準為負時報錯，0 合法", () => {
  assert.throws(() => parse_spread_standard(build_spread_payload({ spread_standard_aud_per_mwh: -1 })), /0 以上/);
  assert.equal(parse_spread_standard(build_spread_payload({ spread_standard_aud_per_mwh: 0 })).spread_standard_aud_per_mwh, 0);
});

test("parse_spread_standard: 日期格式不符或不存在時報錯", () => {
  for (const effective_date of ["2026/10/20", "2026-10-20T00:00:00Z", "2026-02-30", "2026-13-01", ""]) {
    assert.throws(() => parse_spread_standard(build_spread_payload({ effective_date })), /YYYY-MM-DD/, effective_date);
  }
});

test("parse_spread_standard: 檢討人或檢討依據空白時報錯", () => {
  assert.throws(() => parse_spread_standard(build_spread_payload({ reviewer_name: "   " })), /reviewer_name/);
  assert.throws(() => parse_spread_standard(build_spread_payload({ review_basis: 3 })), /review_basis/);
});

test("fetch_battery_configuration: 讀 config/battery.json 並驗證", async () => {
  const requested_urls = [];
  const fake_fetch = async (request_url) => {
    requested_urls.push(request_url);
    return { status: 200, ok: true, json: async () => build_battery_payload() };
  };

  const battery_configuration = await fetch_battery_configuration({ fetch_function: fake_fetch });

  assert.deepEqual(requested_urls, [BATTERY_CONFIGURATION_URL]);
  assert.ok(BATTERY_CONFIGURATION_URL.endsWith("/config/battery.json"));
  assert.equal(battery_configuration.round_trip_efficiency, 0.85);
});

test("fetch_battery_configuration: 檔案不存在（HTTP 404）時直接報錯", async () => {
  const fake_fetch = async () => ({ status: 404, ok: false, json: async () => ({}) });

  await assert.rejects(fetch_battery_configuration({ fetch_function: fake_fetch }), HttpStatusError);
});

test("fetch_battery_configuration: 內容不合法時報錯", async () => {
  const fake_fetch = async () => ({ status: 200, ok: true, json: async () => build_battery_payload({ power_mw: 0 }) });

  await assert.rejects(fetch_battery_configuration({ fetch_function: fake_fetch }), /power_mw/);
});

test("index.html: 功率、容量、MLF 欄位唯讀且不寫死數值，值只來自 config/battery.json", () => {
  const page_html = readFileSync(PREDISPATCH_PAGE_FILE, "utf8");

  for (const input_id of CONFIGURED_INPUT_IDS) {
    const input_tag = page_html.match(new RegExp(`<input[^>]*id="${input_id}"[^>]*>`))?.[0] ?? "";
    assert.match(input_tag, /\breadonly\b/, input_id);
    assert.doesNotMatch(input_tag, /\bvalue=/, input_id);
  }
});

test("fetch_battery_configuration: 檔案不是合法 JSON 時，錯誤訊息指出檔名", async () => {
  const fake_fetch = async () => ({ status: 200, ok: true, json: async () => JSON.parse("{power_mw: 5}") });

  await assert.rejects(fetch_battery_configuration({ fetch_function: fake_fetch }), /config\/battery\.json 不是合法的 JSON/);
});
