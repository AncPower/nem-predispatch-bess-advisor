import assert from "node:assert/strict";
import { test } from "node:test";

import { format_nem_label, interval_start_minute, parse_nem_timestamp } from "../src/nem_time.js";

test("parse_nem_timestamp: 儀表板與 MMS 兩種格式結果相同", () => {
  assert.equal(parse_nem_timestamp("2026-10-19T18:30:00"), parse_nem_timestamp("2026/10/19 18:30:00"));
});

test("format_nem_label: 依 NEM 時間顯示，不受瀏覽器時區影響", () => {
  assert.equal(format_nem_label(parse_nem_timestamp("2026-10-19T18:30:00")), "10/19 18:30");
});

test("interval_start_minute: 結束時間往前 30 分鐘", () => {
  const end_minute = parse_nem_timestamp("2026-10-20T00:00:00");

  assert.equal(format_nem_label(interval_start_minute(end_minute)), "10/19 23:30");
});

test("parse_nem_timestamp: 格式不符時拋出錯誤並帶原字串", () => {
  assert.throws(() => parse_nem_timestamp("19/10/2026"), /19\/10\/2026/);
});
