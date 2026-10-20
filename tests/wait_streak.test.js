import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WAIT_HISTORY_MAX_DAYS,
  WAIT_STREAK_ALERT_DAYS,
  count_wait_streak,
  nem_date_for,
  parse_wait_history,
  record_plan_action,
  serialize_wait_history,
} from "../src/wait_streak.js";

test("wait_streak: 連續 3 天等待才提示（#28）", () => {
  assert.equal(WAIT_STREAK_ALERT_DAYS, 3);
});

test("nem_date_for: 以 NEM 時間（UTC+10）取日期", () => {
  assert.equal(nem_date_for(Date.UTC(2026, 9, 20, 13, 59)), "2026-10-20");
  assert.equal(nem_date_for(Date.UTC(2026, 9, 20, 14, 0)), "2026-10-21");
});

test("record_plan_action: 同一天只要執行過一次就記為執行，之後的等待不覆蓋", () => {
  let wait_history = record_plan_action({}, "2026-10-20", "wait");
  assert.deepEqual(wait_history, { "2026-10-20": "wait" });
  wait_history = record_plan_action(wait_history, "2026-10-20", "execute");
  wait_history = record_plan_action(wait_history, "2026-10-20", "wait");
  assert.deepEqual(wait_history, { "2026-10-20": "execute" });
});

test("record_plan_action: 只保留最近 14 天", () => {
  let wait_history = {};
  for (let day_number = 1; day_number <= 20; day_number++) {
    wait_history = record_plan_action(wait_history, `2026-10-${String(day_number).padStart(2, "0")}`, "wait");
  }
  assert.equal(Object.keys(wait_history).length, WAIT_HISTORY_MAX_DAYS);
  assert.equal(Object.keys(wait_history).sort()[0], "2026-10-07");
});

test("record_plan_action: 動作不合法時拋出錯誤", () => {
  assert.throws(() => record_plan_action({}, "2026-10-20", "hold"), /動作/);
  assert.throws(() => record_plan_action({}, "2026/10/20", "wait"), /日期/);
});

test("count_wait_streak: 從今天往回數連續等待的天數，跨月也算連續", () => {
  const wait_history = { "2026-09-29": "wait", "2026-09-30": "wait", "2026-10-01": "wait", "2026-09-28": "execute" };

  assert.equal(count_wait_streak(wait_history, "2026-10-01"), 3);
});

test("count_wait_streak: 中間有執行或沒有紀錄的日子就中斷", () => {
  assert.equal(count_wait_streak({ "2026-10-18": "wait", "2026-10-19": "execute", "2026-10-20": "wait" }, "2026-10-20"), 1);
  assert.equal(count_wait_streak({ "2026-10-18": "wait", "2026-10-20": "wait" }, "2026-10-20"), 1);
  assert.equal(count_wait_streak({ "2026-10-19": "wait" }, "2026-10-20"), 0);
});

test("parse_wait_history: 空白、壞掉的 JSON 或不合法的項目一律忽略", () => {
  assert.deepEqual(parse_wait_history(null), {});
  assert.deepEqual(parse_wait_history("{not json"), {});
  assert.deepEqual(parse_wait_history("[1,2]"), {});
  assert.deepEqual(parse_wait_history('{"2026-10-20":"wait","bad":"wait","2026-10-21":"maybe"}'), { "2026-10-20": "wait" });
});

test("serialize_wait_history: 與 parse_wait_history 來回一致", () => {
  const wait_history = { "2026-10-19": "execute", "2026-10-20": "wait" };

  assert.deepEqual(parse_wait_history(serialize_wait_history(wait_history)), wait_history);
});
