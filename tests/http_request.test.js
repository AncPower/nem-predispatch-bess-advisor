import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpStatusError, TransientFetchError, fetch_json_with_retry } from "../src/http_request.js";

const skip_sleep = async () => {};

/** 依序回傳指定 HTTP 狀態的假 fetch。 */
function build_status_fetch(status_sequence) {
  const call_record = { call_count: 0 };
  const fake_fetch = async () => {
    const status_code = status_sequence[Math.min(call_record.call_count, status_sequence.length - 1)];
    call_record.call_count++;
    return { status: status_code, ok: status_code < 400, json: async () => ({ answer_value: 42 }) };
  };
  return { fake_fetch, call_record };
}

test("fetch_json_with_retry: 403 不重試並帶狀態碼", async () => {
  const { fake_fetch, call_record } = build_status_fetch([403]);

  await assert.rejects(
    fetch_json_with_retry("https://example.test", {}, { source_label: "測試 API", fetch_function: fake_fetch, sleep_function: skip_sleep }),
    (request_error) => request_error instanceof HttpStatusError && request_error.http_status === 403 && /測試 API 回應 HTTP 403/.test(request_error.message),
  );
  assert.equal(call_record.call_count, 1);
});

test("fetch_json_with_retry: 退避等待 2 秒、4 秒", async () => {
  const { fake_fetch } = build_status_fetch([500, 500, 200]);
  const waited_milliseconds = [];

  const response_payload = await fetch_json_with_retry("https://example.test", {}, {
    source_label: "測試 API", fetch_function: fake_fetch, sleep_function: async (milliseconds) => { waited_milliseconds.push(milliseconds); },
  });

  assert.deepEqual(waited_milliseconds, [2000, 4000]);
  assert.equal(response_payload.answer_value, 42);
});

test("fetch_json_with_retry: 網路錯誤視為可重試", async () => {
  const failing_fetch = async () => { throw new TypeError("Failed to fetch"); };

  await assert.rejects(
    fetch_json_with_retry("https://example.test", {}, { source_label: "測試 API", fetch_function: failing_fetch, sleep_function: skip_sleep }),
    (request_error) => request_error instanceof TransientFetchError && /連線 測試 API 失敗/.test(request_error.message),
  );
});
