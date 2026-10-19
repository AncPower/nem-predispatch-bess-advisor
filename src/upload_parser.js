/**
 * 解析手動上傳的 NEMWeb 預調度檔（PUBLIC_PREDISPATCHIS，AEMO MMS 的 I/D 列格式）。
 *
 * NEMWeb 沒有開放跨網域讀取，網頁無法直接抓，所以保留手動上傳作為備援。
 * 輸出格式與 `dashboard_source.parse_dashboard_report` 相同。
 */

import { parse_nem_timestamp } from "./nem_time.js";

const INFORMATION_ROW_MARKER = "I";
const DATA_ROW_MARKER = "D";
const ROW_VALUE_OFFSET = 4;

/**
 * 從 MMS CSV 文字取出各區域的預調度電價，排除介入（INTERVENTION ≠ 0）的列。
 *
 * @param {string} csv_text CSV 全文
 * @returns {import("./dashboard_source.js").RegionForecasts} 各區域的預測電價
 * @throws {Error} 找不到區域電價表時
 */
export function parse_predispatch_csv(csv_text) {
  const table_headers = {};
  const region_price_maps = {};
  for (const csv_line of csv_text.split("\n")) {
    const row_marker = csv_line[0];
    if (row_marker !== INFORMATION_ROW_MARKER && row_marker !== DATA_ROW_MARKER) continue;
    const row_cells = split_csv_line(csv_line);
    const table_key = `${row_cells[1]}|${row_cells[2]}`;
    if (row_marker === INFORMATION_ROW_MARKER) {
      table_headers[table_key] = row_cells.slice(ROW_VALUE_OFFSET).map((header_cell) => header_cell.trim().toUpperCase());
      continue;
    }
    const price_record = read_price_record(row_cells, table_headers[table_key]);
    if (price_record) (region_price_maps[price_record.region_id] ??= new Map()).set(price_record.interval_end_minute, price_record.price);
  }
  if (Object.keys(region_price_maps).length === 0) {
    throw new Error("檔案中找不到預調度區域電價（REGION_PRICES 的 RRP 欄位）。請確認上傳的是 PUBLIC_PREDISPATCHIS 檔。");
  }
  return Object.fromEntries(
    Object.entries(region_price_maps).map(([region_id, price_map]) => [
      region_id,
      [...price_map.entries()]
        .map(([interval_end_minute, price]) => ({ interval_end_minute, price }))
        .sort((left_point, right_point) => left_point.interval_end_minute - right_point.interval_end_minute),
    ]),
  );
}

/**
 * 從一列資料讀出區域電價；不是區域電價表、介入列或數值無效時回傳 null。
 *
 * @param {string[]} row_cells 拆好的欄位
 * @param {string[] | undefined} header_names 該表的欄名
 * @returns {{region_id: string, interval_end_minute: number, price: number} | null}
 */
function read_price_record(row_cells, header_names) {
  const table_name = (row_cells[2] ?? "").toUpperCase();
  if (!header_names || !table_name.includes("PRICE") || table_name.includes("SENSITIV")) return null;
  const column_index = {
    region: header_names.indexOf("REGIONID"),
    price: header_names.indexOf("RRP"),
    datetime: header_names.indexOf("DATETIME"),
    intervention: header_names.indexOf("INTERVENTION"),
  };
  if (column_index.region < 0 || column_index.price < 0 || column_index.datetime < 0) return null;
  const row_values = row_cells.slice(ROW_VALUE_OFFSET);
  const intervention_text = column_index.intervention >= 0 ? (row_values[column_index.intervention] ?? "").trim() : "";
  if (intervention_text !== "" && Number(intervention_text) !== 0) return null;
  const price = Number.parseFloat(row_values[column_index.price]);
  if (!Number.isFinite(price)) return null;
  return {
    region_id: row_values[column_index.region].trim(),
    interval_end_minute: parse_nem_timestamp(row_values[column_index.datetime]),
    price,
  };
}

/**
 * 拆一列 CSV，支援雙引號與跳脫的雙引號。
 *
 * @param {string} csv_line 一列文字
 * @returns {string[]} 欄位
 */
function split_csv_line(csv_line) {
  const row_cells = [];
  let current_cell = "";
  let inside_quotes = false;
  for (let character_index = 0; character_index < csv_line.length; character_index++) {
    const current_character = csv_line[character_index];
    if (inside_quotes && current_character === '"' && csv_line[character_index + 1] === '"') {
      current_cell += '"';
      character_index++;
    } else if (current_character === '"') {
      inside_quotes = !inside_quotes;
    } else if (current_character === "," && !inside_quotes) {
      row_cells.push(current_cell);
      current_cell = "";
    } else {
      current_cell += current_character;
    }
  }
  row_cells.push(current_cell.replace(/\r$/, ""));
  return row_cells;
}
