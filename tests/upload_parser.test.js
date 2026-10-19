import assert from "node:assert/strict";
import { test } from "node:test";

import { parse_predispatch_csv } from "../src/upload_parser.js";

const PRICE_HEADER = "I,PREDISPATCH,REGION_PRICES,1,PREDISPATCHSEQNO,RUNNO,REGIONID,PERIODID,INTERVENTION,RRP,DATETIME";

test("parse_predispatch_csv: 取出區域電價並排除介入列", () => {
  const csv_text = [
    "C,NEMP.WORLD,PREDISPATCHIS",
    PRICE_HEADER,
    'D,PREDISPATCH,REGION_PRICES,1,2026101937,1,NSW1,2,0,95.5,"2026/10/19 19:30:00"',
    "D,PREDISPATCH,REGION_PRICES,1,2026101937,1,NSW1,1,0,80,2026/10/19 19:00:00",
    "D,PREDISPATCH,REGION_PRICES,1,2026101937,1,NSW1,1,1,999,2026/10/19 19:00:00",
  ].join("\r\n");

  const region_forecasts = parse_predispatch_csv(csv_text);

  assert.deepEqual(region_forecasts.NSW1.map((price_point) => price_point.price), [80, 95.5]);
});

test("parse_predispatch_csv: 跳過價格敏感度表", () => {
  const csv_text = [
    PRICE_HEADER.replace("REGION_PRICES", "PRICESENSITIVITIES"),
    "D,PREDISPATCH,PRICESENSITIVITIES,1,2026101937,1,NSW1,1,0,80,2026/10/19 19:00:00",
  ].join("\n");

  assert.throws(() => parse_predispatch_csv(csv_text), /PUBLIC_PREDISPATCHIS/);
});

test("parse_predispatch_csv: 空檔案拋出錯誤", () => {
  assert.throws(() => parse_predispatch_csv(""), /找不到/);
});
