import assert from "node:assert/strict";
import { test } from "node:test";

import { TransientFetchError, fetch_dashboard_report, parse_dashboard_report } from "../src/dashboard_source.js";

/** 依儀表板 API 實際回應欄位組一列。 */
function build_report_row(row_fields) {
  return { REGIONID: "NSW1", SETTLEMENTDATE: "2026-10-19T19:00:00", RRP: 120.5, PERIODTYPE: "FORECAST", ...row_fields };
}

/** 依序回傳指定 HTTP 狀態的假 fetch，並記錄呼叫次數。 */
function build_sequenced_fetch(status_sequence) {
  const call_record = { call_count: 0 };
  const fake_fetch = async () => {
    const status_code = status_sequence[Math.min(call_record.call_count, status_sequence.length - 1)];
    call_record.call_count++;
    return { status: status_code, ok: status_code < 400, json: async () => ({ "5MIN": [build_report_row({})] }) };
  };
  return { fake_fetch, call_record };
}

const skip_sleep = async () => {};

test("parse_dashboard_report: 只取預測列並依時間排序", () => {
  const report_payload = {
    "5MIN": [
      build_report_row({ SETTLEMENTDATE: "2026-10-19T19:30:00", RRP: 90 }),
      build_report_row({ SETTLEMENTDATE: "2026-10-19T19:00:00", RRP: 80 }),
      build_report_row({ SETTLEMENTDATE: "2026-10-19T18:25:00", PERIODTYPE: "ACTUAL" }),
      build_report_row({ REGIONID: "QLD1" }),
    ],
  };

  const region_forecasts = parse_dashboard_report(report_payload);

  assert.deepEqual(region_forecasts.NSW1.map((price_point) => price_point.price), [80, 90]);
  assert.equal(region_forecasts.QLD1.length, 1);
});

test("parse_dashboard_report: 缺少 5MIN 陣列時拋出錯誤", () => {
  assert.throws(() => parse_dashboard_report({}), /5MIN/);
});

test("parse_dashboard_report: RRP 不是數值時指出列號與欄位", () => {
  assert.throws(() => parse_dashboard_report({ "5MIN": [build_report_row({ RRP: "abc" })] }), /第 1 列的 RRP/);
});

test("parse_dashboard_report: 未知的 PERIODTYPE 拋出錯誤", () => {
  assert.throws(() => parse_dashboard_report({ "5MIN": [build_report_row({ PERIODTYPE: "OTHER" })] }), /PERIODTYPE/);
});

test("parse_dashboard_report: 沒有預測列時拋出錯誤", () => {
  assert.throws(() => parse_dashboard_report({ "5MIN": [build_report_row({ PERIODTYPE: "ACTUAL" })] }), /FORECAST/);
});

test("fetch_dashboard_report: 遇到 503 重試後成功", async () => {
  const { fake_fetch, call_record } = build_sequenced_fetch([503, 200]);

  const report_payload = await fetch_dashboard_report({ fetch_function: fake_fetch, sleep_function: skip_sleep });

  assert.equal(call_record.call_count, 2);
  assert.equal(report_payload["5MIN"].length, 1);
});

test("fetch_dashboard_report: 遇到 400 不重試", async () => {
  const { fake_fetch, call_record } = build_sequenced_fetch([400]);

  await assert.rejects(fetch_dashboard_report({ fetch_function: fake_fetch, sleep_function: skip_sleep }), /HTTP 400/);
  assert.equal(call_record.call_count, 1);
});

test("fetch_dashboard_report: 一直 429 時最多試三次", async () => {
  const { fake_fetch, call_record } = build_sequenced_fetch([429]);

  await assert.rejects(
    fetch_dashboard_report({ fetch_function: fake_fetch, sleep_function: skip_sleep }),
    TransientFetchError,
  );
  assert.equal(call_record.call_count, 3);
});

test("fetch_dashboard_report: 逾時視為可重試的錯誤", async () => {
  const hanging_fetch = (request_url, request_init) =>
    new Promise((_resolve_request, reject_request) => {
      request_init.signal.addEventListener("abort", () => reject_request(new Error("aborted")));
    });

  await assert.rejects(
    fetch_dashboard_report({ fetch_function: hanging_fetch, sleep_function: skip_sleep, timeout_milliseconds: 5 }),
    TransientFetchError,
  );
});
