import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PREDISPATCH_PAGE_TEXT = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const PREDISPATCH_APP_TEXT = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const README_TEXT = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const STALE_EFFICIENCY_PATTERNS = Object.freeze([/來回效率固定\s*100%/, /仍以來回效率\s*100%/, /效率\s*100%、不計損耗/]);
const OTHER_REGION_IDS = Object.freeze(["QLD1", "VIC1", "SA1", "TAS1"]);
const LITERAL_ELEMENT_ID_PATTERN = /element_by_id\("([\w-]+)"\)/g;
const ELEMENT_ID_LIST_PATTERN = /const \w+_IDS = Object\.freeze\(\[([^\]]*)\]\)/g;
const QUOTED_ID_PATTERN = /"([\w-]+)"/g;

/**
 * 取出 index.html 中某個區塊（從 `id="..."` 到下一個 `</section>`）。
 *
 * @param {string} section_id 區塊 id
 * @returns {string} 區塊文字；找不到時為空字串
 */
function read_section(section_id) {
  const section_start = PREDISPATCH_PAGE_TEXT.indexOf(`id="${section_id}"`);
  if (section_start < 0) return "";
  return PREDISPATCH_PAGE_TEXT.slice(section_start, PREDISPATCH_PAGE_TEXT.indexOf("</section>", section_start));
}

test("page_copy: 預調度頁不再寫建議計畫或試算「效率 100%、不計損耗」（#46）", () => {
  for (const stale_pattern of STALE_EFFICIENCY_PATTERNS) {
    assert.doesNotMatch(PREDISPATCH_PAGE_TEXT, stale_pattern);
  }
  assert.match(PREDISPATCH_PAGE_TEXT, /每 MWh 損耗成本/);
  assert.match(PREDISPATCH_PAGE_TEXT, /來回效率/);
});

test("page_copy: README 的預調度頁與共用設定不再寫計算以效率 100%、不計損耗進行（#46）", () => {
  const predispatch_section = README_TEXT.slice(README_TEXT.indexOf("## 兩頁共用的基礎"), README_TEXT.indexOf("## 情境評估頁"));

  assert.ok(predispatch_section.length > 0);
  assert.doesNotMatch(predispatch_section, /效率\s*100%/);
  assert.doesNotMatch(predispatch_section, /階段 1 預計改為：計入效率與損耗/);
});

test("page_copy: 預調度頁只做 NSW1，沒有區域選單與其他區域選項（#29）", () => {
  assert.doesNotMatch(PREDISPATCH_PAGE_TEXT, /id="region_select"/);
  for (const region_id of OTHER_REGION_IDS) {
    assert.doesNotMatch(PREDISPATCH_PAGE_TEXT, new RegExp(`<option value="${region_id}"`));
  }
  assert.doesNotMatch(PREDISPATCH_APP_TEXT, /region_select/);
  assert.match(PREDISPATCH_APP_TEXT, /const REGION_ID = "NSW1";/);
});

test("page_copy: 建議計畫與電價圖都加註台灣時間換算（#29）", () => {
  assert.match(read_section("price_chart_card"), /台灣時間＝市場時間 − 2 小時/);
  assert.match(PREDISPATCH_APP_TEXT, /台灣時間＝市場時間 − 2 小時/);
});

test("page_copy: 建議計畫卡片內有資料時效欄位（#29）", () => {
  assert.match(read_section("plan_card"), /id="plan_freshness"/);
});

test("page_copy: 自訂價格試算移到建議計畫下方，不在側欄（#29）", () => {
  const plan_position = PREDISPATCH_PAGE_TEXT.indexOf('id="plan_card"');
  const trial_position = PREDISPATCH_PAGE_TEXT.indexOf('id="trial_card"');
  const sidebar_text = PREDISPATCH_PAGE_TEXT.slice(0, PREDISPATCH_PAGE_TEXT.indexOf("</aside>"));
  const trial_section = read_section("trial_card");

  assert.ok(plan_position >= 0 && trial_position > plan_position, "trial_card 應排在 plan_card 之後");
  for (const trial_input_id of ["charge_cap_range", "spread_range", "soc_input", "reset_thresholds"]) {
    assert.doesNotMatch(sidebar_text, new RegExp(`id="${trial_input_id}"`));
    assert.match(trial_section, new RegExp(`id="${trial_input_id}"`));
  }
});

test("page_copy: app.js 以固定 id 取用的元素都在 index.html 裡（#29）", () => {
  const literal_ids = [...PREDISPATCH_APP_TEXT.matchAll(LITERAL_ELEMENT_ID_PATTERN)].map((id_match) => id_match[1]);
  const listed_ids = [...PREDISPATCH_APP_TEXT.matchAll(ELEMENT_ID_LIST_PATTERN)]
    .flatMap((list_match) => [...list_match[1].matchAll(QUOTED_ID_PATTERN)].map((id_match) => id_match[1]));
  const referenced_ids = [...literal_ids, ...listed_ids];

  assert.ok(referenced_ids.length > 0);
  for (const element_id of new Set(referenced_ids)) {
    assert.match(PREDISPATCH_PAGE_TEXT, new RegExp(`id="${element_id}"`), `index.html 缺少 id="${element_id}"`);
  }
});

test("page_copy: README 不再寫預調度頁可選五個區域（#29）", () => {
  const shared_section = README_TEXT.slice(README_TEXT.indexOf("## 兩頁共用的基礎"), README_TEXT.indexOf("## 預調度頁"));

  assert.doesNotMatch(shared_section, /預調度頁可選五個區域/);
  assert.doesNotMatch(README_TEXT, /自訂價格試算保留，移到主結論下方/);
});
