import assert from "node:assert/strict";
import { test } from "node:test";

import { STALE_AFTER_MINUTES, assess_data_freshness, format_data_freshness } from "../src/data_freshness.js";

const FETCHED_AT_MILLISECONDS = Date.UTC(2026, 9, 20, 15, 0);
const MILLISECONDS_PER_MINUTE = 60_000;
const after_minutes = (elapsed_minutes) => FETCHED_AT_MILLISECONDS + elapsed_minutes * MILLISECONDS_PER_MINUTE;

test("assess_data_freshness: 門檻為 35 分鐘（roadmap D1）", () => {
  assert.equal(STALE_AFTER_MINUTES, 35);
});

test("assess_data_freshness: 剛好 35 分鐘不算過期，超過才算（#29）", () => {
  assert.deepEqual(assess_data_freshness(FETCHED_AT_MILLISECONDS, after_minutes(34) + 59_000), { is_stale: false, elapsed_minutes: 34 });
  assert.deepEqual(assess_data_freshness(FETCHED_AT_MILLISECONDS, after_minutes(35)), { is_stale: false, elapsed_minutes: 35 });
  assert.deepEqual(assess_data_freshness(FETCHED_AT_MILLISECONDS, after_minutes(35) + 1), { is_stale: true, elapsed_minutes: 35 });
  assert.deepEqual(assess_data_freshness(FETCHED_AT_MILLISECONDS, after_minutes(36)), { is_stale: true, elapsed_minutes: 36 });
});

test("assess_data_freshness: 電腦時間倒退時視為剛取得、不算過期", () => {
  assert.deepEqual(assess_data_freshness(FETCHED_AT_MILLISECONDS, after_minutes(-5)), { is_stale: false, elapsed_minutes: 0 });
});

test("assess_data_freshness: 時間不是有限數字時報錯", () => {
  for (const invalid_value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, "0"]) {
    assert.throws(() => assess_data_freshness(invalid_value, FETCHED_AT_MILLISECONDS), /不是有效的數字/);
    assert.throws(() => assess_data_freshness(FETCHED_AT_MILLISECONDS, invalid_value), /不是有效的數字/);
  }
});

test("format_data_freshness: 未過期顯示取得時間與經過時間，過期加上「資料可能過期」", () => {
  assert.equal(format_data_freshness({ is_stale: false, elapsed_minutes: 0 }, "23:00"), "資料取得時間 23:00（你的電腦時間），剛剛");
  assert.equal(format_data_freshness({ is_stale: false, elapsed_minutes: 12 }, "23:00"), "資料取得時間 23:00（你的電腦時間），12 分鐘前");
  assert.equal(
    format_data_freshness({ is_stale: true, elapsed_minutes: 40 }, "23:00"),
    "資料可能過期：取得時間 23:00（你的電腦時間），已 40 分鐘沒有成功更新（超過 35 分鐘）",
  );
});
