import assert from "node:assert/strict";
import { test } from "node:test";

import { build_new_note_url, collect_excluded_dates, fetch_special_date_notes, parse_issue_form_body, parse_note_issue } from "../src/special_date_notes.js";

const ISSUE_URL_BASE = "https://github.com/AncPower/nem-predispatch-bess-advisor/issues/";

/** GitHub issue 表單送出後的內文格式。 */
function build_form_body(field_values) {
  return [
    "### 日期", "", field_values.note_date ?? "2026-10-19", "",
    "### 時間", "", field_values.note_time ?? "_No response_", "",
    "### 市場或區域", "", "NSW1", "",
    "### 類別", "", "極端天氣", "",
    "### 補充資訊", "", field_values.note_text ?? "熱浪，傍晚價格觸頂", "",
    "### 校準", "", field_values.exclude_line ?? "- [x] 校準時排除此日",
  ].join("\n");
}

/** 依（編號、內文）組 issue 物件。 */
function build_issue(issue_number, issue_body) {
  return { number: issue_number, html_url: `${ISSUE_URL_BASE}${issue_number}`, body: issue_body };
}

test("parse_issue_form_body: 依標題取欄位，未填欄位為空字串", () => {
  const form_fields = parse_issue_form_body(build_form_body({}));

  assert.equal(form_fields.get("日期"), "2026-10-19");
  assert.equal(form_fields.get("時間"), "");
  assert.equal(form_fields.get("類別"), "極端天氣");
});

test("parse_note_issue: 勾選排除與未勾選", () => {
  const excluded_note = parse_note_issue(build_issue(7, build_form_body({})), 0);
  const included_note = parse_note_issue(build_issue(8, build_form_body({ exclude_line: "- [ ] 校準時排除此日" })), 1);

  assert.equal(excluded_note.exclude_from_calibration, true);
  assert.equal(included_note.exclude_from_calibration, false);
});

test("parse_note_issue: 日期格式不符時 note_date 為 null 並保留原文", () => {
  const special_note = parse_note_issue(build_issue(9, build_form_body({ note_date: "19/10/2026" })), 0);

  assert.equal(special_note.note_date, null);
  assert.equal(special_note.raw_date_text, "19/10/2026");
});

test("parse_note_issue: 網址不屬於本 repo 時拋出錯誤", () => {
  assert.throws(() => parse_note_issue({ number: 1, html_url: "https://evil.example/1", body: "" }, 0), /網址不屬於/);
});

test("parse_note_issue: HTML 內容原樣保留為文字（由顯示層以 textContent 寫入）", () => {
  const special_note = parse_note_issue(build_issue(10, build_form_body({ note_text: "<img src=x onerror=alert(1)>" })), 0);

  assert.equal(special_note.note_text, "<img src=x onerror=alert(1)>");
});

test("collect_excluded_dates: 只收勾選排除且日期有效的備註", () => {
  const special_date_notes = [
    parse_note_issue(build_issue(1, build_form_body({ note_date: "2026-10-01" })), 0),
    parse_note_issue(build_issue(2, build_form_body({ note_date: "2026-10-02", exclude_line: "- [ ] 校準時排除此日" })), 1),
    parse_note_issue(build_issue(3, build_form_body({ note_date: "bad" })), 2),
  ];

  assert.deepEqual([...collect_excluded_dates(special_date_notes)], ["2026-10-01"]);
});

test("build_new_note_url: 帶入範本、標籤與欄位", () => {
  const note_url = new URL(build_new_note_url({ note_date: "2026-10-19", note_time: "18:30", note_market: "NSW1", note_text: "熱浪 & 斷線" }));

  assert.equal(note_url.searchParams.get("template"), "special_date.yml");
  assert.equal(note_url.searchParams.get("labels"), "special-date");
  assert.equal(note_url.searchParams.get("note_text"), "熱浪 & 斷線");
});

test("fetch_special_date_notes: 略過 pull request 並依日期新到舊排序", async () => {
  const issue_payload = [
    build_issue(1, build_form_body({ note_date: "2026-09-01" })),
    { ...build_issue(2, ""), pull_request: {} },
    build_issue(3, build_form_body({ note_date: "2026-10-01" })),
  ];
  let requested_url = "";
  const fake_fetch = async (request_url) => {
    requested_url = request_url;
    return { status: 200, ok: true, json: async () => issue_payload };
  };

  const special_date_notes = await fetch_special_date_notes({ fetch_function: fake_fetch, sleep_function: async () => {} });

  assert.deepEqual(special_date_notes.map((special_note) => special_note.issue_number), [3, 1]);
  assert.match(requested_url, /labels=special-date&state=open/);
});

test("fetch_special_date_notes: 403 時說明可能是每小時上限", async () => {
  const forbidden_fetch = async () => ({ status: 403, ok: false, json: async () => ({}) });

  await assert.rejects(fetch_special_date_notes({ fetch_function: forbidden_fetch }), /每小時 60 次/);
});
