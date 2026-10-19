import assert from "node:assert/strict";
import { test } from "node:test";

import { split_csv_line } from "../src/csv_line.js";
import { format_money } from "../src/number_format.js";

test("split_csv_line: 引號內的逗號與跳脫引號", () => {
  assert.deepEqual(split_csv_line('a,"b,c","d""e"\r'), ["a", "b,c", 'd"e']);
});

test("split_csv_line: 空欄位保留", () => {
  assert.deepEqual(split_csv_line("a,,c"), ["a", "", "c"]);
});

test("format_money: 百萬與十億換成中文單位，負數用全形減號", () => {
  assert.equal(format_money(1_234_000, "AUD"), "1.23 百萬 AUD");
  assert.equal(format_money(-2_500_000_000, "AUD"), "−2.50 十億 AUD");
  assert.equal(format_money(999, "JPY"), "999 JPY");
});
