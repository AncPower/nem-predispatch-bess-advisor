import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PREDISPATCH_PAGE_TEXT = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const README_TEXT = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const STALE_EFFICIENCY_PATTERNS = Object.freeze([/來回效率固定\s*100%/, /仍以來回效率\s*100%/, /效率\s*100%、不計損耗/]);

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
