/**
 * 從 AEMO NEM 儀表板 API 取得 30 分鐘預調度電價，並在進入程式前驗證格式。
 *
 * 端點是 AEMO 官網 NEM 儀表板背後的 API，回應允許任何網域讀取（Access-Control-Allow-Origin: *），
 * 所以靜態網頁可以直接呼叫。它沒有公開文件與服務保證，格式改變時由 `parse_dashboard_report` 擋下。
 */

import { fetch_json_with_retry } from "./http_request.js";
import { parse_nem_timestamp } from "./nem_time.js";

export const DASHBOARD_REPORT_URL = "https://visualisations.aemo.com.au/aemo/apps/api/report/5MIN";

const DASHBOARD_REQUEST_BODY = JSON.stringify({ timeScale: ["30MIN"] });
const REPORT_ROWS_KEY = "5MIN";
const FORECAST_PERIOD_TYPE = "FORECAST";
const KNOWN_PERIOD_TYPES = new Set(["ACTUAL", FORECAST_PERIOD_TYPE]);
const REGION_ID_PATTERN = /^[A-Z]{2,3}1$/;

/**
 * @typedef {{interval_end_minute: number, price: number}} PricePoint
 * @typedef {Record<string, PricePoint[]>} RegionForecasts 區域代碼 → 依時間排序的預測電價
 */

/**
 * 呼叫儀表板 API，遇到暫時性錯誤退避重試（見 `http_request.fetch_json_with_retry`）。
 *
 * @param {Partial<import("./http_request.js").RequestOptions>} [request_options] 可替換的 fetch、等待與逾時
 * @returns {Promise<unknown>} 原始 JSON
 */
export function fetch_dashboard_report(request_options = {}) {
  return fetch_json_with_retry(
    DASHBOARD_REPORT_URL,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: DASHBOARD_REQUEST_BODY, cache: "no-store" },
    { source_label: "AEMO 儀表板 API", ...request_options },
  );
}

/**
 * 驗證儀表板回應並取出各區域的預測電價。
 *
 * @param {unknown} report_payload 原始 JSON
 * @returns {RegionForecasts} 各區域的預測電價
 * @throws {Error} 格式不符時，訊息指出第幾列哪個欄位
 */
export function parse_dashboard_report(report_payload) {
  const report_rows = report_payload?.[REPORT_ROWS_KEY];
  if (!Array.isArray(report_rows)) throw new Error(`儀表板回應缺少「${REPORT_ROWS_KEY}」陣列`);
  const region_forecasts = {};
  report_rows.forEach((report_row, row_index) => {
    const validated_row = validate_report_row(report_row, row_index);
    if (validated_row.period_type !== FORECAST_PERIOD_TYPE) return;
    (region_forecasts[validated_row.region_id] ??= []).push(validated_row.price_point);
  });
  if (Object.keys(region_forecasts).length === 0) throw new Error("儀表板回應沒有任何預測（FORECAST）資料");
  for (const price_points of Object.values(region_forecasts)) {
    price_points.sort((left_point, right_point) => left_point.interval_end_minute - right_point.interval_end_minute);
  }
  return region_forecasts;
}

/**
 * 驗證單列欄位。
 *
 * @param {unknown} report_row 原始列
 * @param {number} row_index 列號（從 0 起算）
 * @returns {{region_id: string, period_type: string, price_point: PricePoint}} 驗證後的列
 */
function validate_report_row(report_row, row_index) {
  const row_label = `儀表板回應第 ${row_index + 1} 列`;
  if (typeof report_row !== "object" || report_row === null) throw new Error(`${row_label}不是物件`);
  if (typeof report_row.REGIONID !== "string" || !REGION_ID_PATTERN.test(report_row.REGIONID)) {
    throw new Error(`${row_label}的 REGIONID 無效：${report_row.REGIONID}`);
  }
  if (!KNOWN_PERIOD_TYPES.has(report_row.PERIODTYPE)) throw new Error(`${row_label}的 PERIODTYPE 無效：${report_row.PERIODTYPE}`);
  if (typeof report_row.RRP !== "number" || !Number.isFinite(report_row.RRP)) {
    throw new Error(`${row_label}的 RRP 不是有限數值：${report_row.RRP}`);
  }
  if (typeof report_row.SETTLEMENTDATE !== "string") throw new Error(`${row_label}缺少 SETTLEMENTDATE`);
  const interval_end_minute = parse_nem_timestamp(report_row.SETTLEMENTDATE);
  return {
    region_id: report_row.REGIONID,
    period_type: report_row.PERIODTYPE,
    price_point: { interval_end_minute, price: report_row.RRP },
  };
}
