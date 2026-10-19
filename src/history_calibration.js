/**
 * 以歷史電價校準情境工具的市場參數（純計算）。
 *
 * 讀入任何含日期時間與電價兩欄的 CSV（例如 AEMO 各區域每月的 PRICE_AND_DEMAND 檔），
 * 依小時平均出每日型態，以最小平方法擬合「基準 + 清晨小峰 − 午間凹陷 + 傍晚尖峰」四個係數，
 * 再算尖峰日比例、天氣波動度與四小時價差中位數。標記排除的日期不納入。
 */

import { split_csv_line } from "./csv_line.js";
import { bell_weight, summarize_day_windows } from "./day_shape.js";
import { BATTERY_DURATION_HOURS } from "./scenario_presets.js";

const HEADER_SEARCH_ROWS = 50;
const MINIMUM_HISTORY_ROWS = 48;
const MINIMUM_HOURS_PER_DAY = 20;
const MINIMUM_FULL_DAYS = 3;
const SHAPE_BASELINE = 0.85;
const SPIKE_LEVEL_MULTIPLIER = 3;
const SPIKE_LEVEL_OFFSET = 300;
const PREFERRED_REGION = "NSW1";
const MIDDAY_HOURS = Object.freeze([11, 12, 13, 14]);
const SHOULDER_HOURS = Object.freeze([6, 7, 8, 17, 18, 19, 20]);
const TIME_COLUMN_PATTERN = /SETTLEMENTDATE|DATETIME|INTERVAL_DATETIME|TIMESTAMP|^DATE|^TIME/;
const PRICE_COLUMN_PATTERN = /^RRP$|PRICE/;
const TIMESTAMP_PATTERN = /(?<year>\d{4})[/-](?<month>\d{1,2})[/-](?<day>\d{1,2})[ T](?<hour>\d{1,2}):(?<minute>\d{2})/;

/**
 * @typedef {{date_text: string, hour_value: number, price_value: number, region_id: string}} HistoryRow
 */

/**
 * 解析歷史電價 CSV；在前 50 列內找欄名列。
 *
 * @param {string} csv_text CSV 全文
 * @returns {HistoryRow[]} 有效的資料列
 * @throws {Error} 找不到欄名或資料不足 48 列時
 */
export function parse_history_csv(csv_text) {
  const csv_lines = csv_text.split("\n").filter((csv_line) => csv_line.trim());
  if (csv_lines.length < 2) throw new Error("檔案內容太少");
  const header_match = find_header_columns(csv_lines);
  if (!header_match) throw new Error("找不到日期時間欄與電價欄（欄名需包含 SETTLEMENTDATE／DATETIME／DATE 與 RRP／PRICE）");
  const history_rows = [];
  for (const csv_line of csv_lines.slice(header_match.header_row + 1)) {
    const row_cells = split_csv_line(csv_line);
    const timestamp_match = TIMESTAMP_PATTERN.exec((row_cells[header_match.time_column] ?? "").trim());
    const price_value = Number.parseFloat(row_cells[header_match.price_column]);
    if (!timestamp_match || !Number.isFinite(price_value)) continue;
    const time_parts = timestamp_match.groups;
    history_rows.push({
      date_text: `${time_parts.year}-${time_parts.month.padStart(2, "0")}-${time_parts.day.padStart(2, "0")}`,
      hour_value: Number(time_parts.hour) + Number(time_parts.minute) / 60,
      price_value,
      region_id: header_match.region_column >= 0 ? (row_cells[header_match.region_column] ?? "").trim() : "",
    });
  }
  if (history_rows.length < MINIMUM_HISTORY_ROWS) throw new Error(`可用的資料列不足 ${MINIMUM_HISTORY_ROWS} 筆`);
  return history_rows;
}

/**
 * 在前幾列找出日期時間、電價與區域欄的位置。
 *
 * @param {string[]} csv_lines 非空白列
 * @returns {{header_row: number, time_column: number, price_column: number, region_column: number} | null}
 */
function find_header_columns(csv_lines) {
  for (let row_index = 0; row_index < Math.min(csv_lines.length, HEADER_SEARCH_ROWS); row_index++) {
    const header_cells = split_csv_line(csv_lines[row_index]).map((header_cell) => header_cell.trim().toUpperCase());
    const time_column = header_cells.findIndex((header_cell) => TIME_COLUMN_PATTERN.test(header_cell));
    const price_column = header_cells.findIndex((header_cell) => PRICE_COLUMN_PATTERN.test(header_cell));
    if (time_column >= 0 && price_column >= 0) {
      return { header_row: row_index, time_column, price_column, region_column: header_cells.findIndex((header_cell) => /REGION/.test(header_cell)) };
    }
  }
  return null;
}

/**
 * 檔案含多個區域時選一個：有 NSW1 用 NSW1，否則用排序後第一個。
 *
 * @param {HistoryRow[]} history_rows 資料列
 * @returns {{region_rows: HistoryRow[], region_id: string, region_count: number}} 選定區域的資料
 */
export function select_calibration_region(history_rows) {
  const region_ids = [...new Set(history_rows.map((history_row) => history_row.region_id).filter(Boolean))].sort();
  if (region_ids.length <= 1) return { region_rows: history_rows, region_id: region_ids[0] ?? "", region_count: region_ids.length };
  const region_id = region_ids.includes(PREFERRED_REGION) ? PREFERRED_REGION : region_ids[0];
  return { region_rows: history_rows.filter((history_row) => history_row.region_id === region_id), region_id, region_count: region_ids.length };
}

/**
 * @typedef {object} CalibrationResult
 * @property {import("./scenario_presets.js").MarketPreset} calibrated_preset 校準後的市場預設
 * @property {{used_days: number, excluded_days: number, base_level: number, solar_dip: number, evening_peak: number, spike_day_share: number, median_spread: number}} calibration_stats 統計
 */

/**
 * 以歷史資料校準市場預設。
 *
 * @param {HistoryRow[]} history_rows 單一區域的資料列
 * @param {Set<string>} excluded_dates 排除的日期（YYYY-MM-DD）
 * @param {import("./scenario_presets.js").MarketPreset} base_preset 幣別、上下限、燃氣傳導比例沿用這份
 * @param {string} source_name 檔名，用在顯示名稱
 * @returns {CalibrationResult} 校準結果
 * @throws {Error} 完整日不足 3 天或擬合失敗時
 */
export function calibrate_from_history(history_rows, excluded_dates, base_preset, source_name) {
  const day_profiles = build_day_profiles(history_rows, excluded_dates);
  if (day_profiles.length < MINIMUM_FULL_DAYS) throw new Error(`排除備註日期後，完整的日資料少於 ${MINIMUM_FULL_DAYS} 天，無法校準`);
  const fitted_shape = fit_day_shape(average_profile(day_profiles.map((day_profile) => day_profile.hourly_averages)));
  const spike_threshold = Math.max(SPIKE_LEVEL_MULTIPLIER * fitted_shape.base_level, fitted_shape.base_level + SPIKE_LEVEL_OFFSET);
  const spike_day_share = day_profiles.filter((day_profile) => day_profile.highest_price > spike_threshold).length / day_profiles.length;
  const weather_volatility = estimate_weather_volatility(day_profiles, fitted_shape.base_level);
  const median_spread = median_of(day_profiles.map((day_profile) => four_hour_spread(day_profile.hourly_averages)).filter(Number.isFinite));
  const calibration_stats = {
    used_days: day_profiles.length, excluded_days: excluded_dates.size, base_level: fitted_shape.base_level,
    solar_dip: fitted_shape.solar_dip, evening_peak: fitted_shape.evening_peak, spike_day_share, median_spread,
  };
  const calibrated_preset = {
    ...base_preset,
    market_name: `歷史校準：${source_name.slice(0, 24)}`,
    base_price: Math.round(fitted_shape.base_level),
    solar_dip: Number(fitted_shape.solar_dip.toFixed(3)),
    evening_peak: Number(fitted_shape.evening_peak.toFixed(3)),
    spike_probability: Number((100 * spike_day_share).toFixed(1)),
    weather_volatility,
    spread_standard: Math.round(median_spread),
    market_note: `以 ${day_profiles.length} 天歷史資料擬合（排除 ${excluded_dates.size} 個備註日期）。`,
  };
  return { calibrated_preset, calibration_stats };
}

/**
 * 依日期與小時平均；只留至少 20 個小時有資料的日子。
 *
 * @param {HistoryRow[]} history_rows 資料列
 * @param {Set<string>} excluded_dates 排除的日期
 * @returns {{hourly_averages: (number | null)[], highest_price: number}[]} 每日型態
 */
function build_day_profiles(history_rows, excluded_dates) {
  const day_buckets = new Map();
  for (const history_row of history_rows) {
    if (excluded_dates.has(history_row.date_text)) continue;
    let day_bucket = day_buckets.get(history_row.date_text);
    if (!day_bucket) {
      day_bucket = { price_sums: new Array(24).fill(0), price_counts: new Array(24).fill(0), highest_price: Number.NEGATIVE_INFINITY };
      day_buckets.set(history_row.date_text, day_bucket);
    }
    const hour_bucket = Math.floor(history_row.hour_value) % 24;
    day_bucket.price_sums[hour_bucket] += history_row.price_value;
    day_bucket.price_counts[hour_bucket]++;
    day_bucket.highest_price = Math.max(day_bucket.highest_price, history_row.price_value);
  }
  return [...day_buckets.values()]
    .filter((day_bucket) => day_bucket.price_counts.filter((price_count) => price_count > 0).length >= MINIMUM_HOURS_PER_DAY)
    .map((day_bucket) => ({
      hourly_averages: day_bucket.price_sums.map((price_sum, hour_value) => (day_bucket.price_counts[hour_value] ? price_sum / day_bucket.price_counts[hour_value] : null)),
      highest_price: day_bucket.highest_price,
    }));
}

/**
 * 各小時跨日平均，忽略缺值。
 *
 * @param {(number | null)[][]} hourly_profiles 每日各小時平均
 * @returns {number[]} 24 小時平均型態
 */
function average_profile(hourly_profiles) {
  return Array.from({ length: 24 }, (_unused, hour_value) => {
    const hour_values = hourly_profiles.map((hourly_profile) => hourly_profile[hour_value]).filter((hour_price) => hour_price !== null);
    return hour_values.reduce((value_sum, hour_price) => value_sum + hour_price, 0) / hour_values.length;
  });
}

/**
 * 最小平方法擬合日型態：基準、清晨小峰、午間凹陷、傍晚尖峰。
 *
 * @param {number[]} hourly_profile 24 小時平均型態
 * @returns {{base_level: number, solar_dip: number, evening_peak: number}} 基準價與相對深度
 * @throws {Error} 矩陣奇異或基準不為正時
 */
export function fit_day_shape(hourly_profile) {
  const design_rows = hourly_profile.map((_unused, hour_value) => [1, bell_weight(hour_value, 7.5, 1.5), -bell_weight(hour_value, 12.5, 2.6), bell_weight(hour_value, 19, 1.8)]);
  const coefficient_count = 4;
  const normal_matrix = Array.from({ length: coefficient_count }, (_row, row_index) =>
    Array.from({ length: coefficient_count }, (_column, column_index) =>
      design_rows.reduce((value_sum, design_row) => value_sum + design_row[row_index] * design_row[column_index], 0)));
  const normal_vector = Array.from({ length: coefficient_count }, (_row, row_index) =>
    design_rows.reduce((value_sum, design_row, hour_value) => value_sum + design_row[row_index] * hourly_profile[hour_value], 0));
  const coefficients = solve_linear_system(normal_matrix, normal_vector);
  if (!coefficients || coefficients[0] <= 0) throw new Error("擬合失敗：平均電價過低或型態不明顯，請改用較長期間的資料");
  const base_level = coefficients[0] / SHAPE_BASELINE;
  return { base_level, solar_dip: Math.max(0, coefficients[2] / base_level), evening_peak: Math.max(0, coefficients[3] / base_level) };
}

/**
 * 高斯消去法解線性方程組（部分選主元）。
 *
 * @param {number[][]} coefficient_matrix 係數矩陣
 * @param {number[]} constant_vector 常數向量
 * @returns {number[] | null} 解；矩陣奇異時為 null
 */
function solve_linear_system(coefficient_matrix, constant_vector) {
  const equation_count = constant_vector.length;
  const augmented_rows = coefficient_matrix.map((matrix_row, row_index) => [...matrix_row, constant_vector[row_index]]);
  for (let pivot_column = 0; pivot_column < equation_count; pivot_column++) {
    let pivot_row = pivot_column;
    for (let row_index = pivot_column + 1; row_index < equation_count; row_index++) {
      if (Math.abs(augmented_rows[row_index][pivot_column]) > Math.abs(augmented_rows[pivot_row][pivot_column])) pivot_row = row_index;
    }
    [augmented_rows[pivot_column], augmented_rows[pivot_row]] = [augmented_rows[pivot_row], augmented_rows[pivot_column]];
    if (Math.abs(augmented_rows[pivot_column][pivot_column]) < 1e-12) return null;
    for (let row_index = 0; row_index < equation_count; row_index++) {
      if (row_index === pivot_column) continue;
      const elimination_factor = augmented_rows[row_index][pivot_column] / augmented_rows[pivot_column][pivot_column];
      for (let column_index = pivot_column; column_index <= equation_count; column_index++) {
        augmented_rows[row_index][column_index] -= elimination_factor * augmented_rows[pivot_column][column_index];
      }
    }
  }
  return augmented_rows.map((augmented_row, row_index) => augmented_row[equation_count] / augmented_row[row_index]);
}

/**
 * 天氣波動度：每日「清晨與傍晚均價 − 午間均價」相對基準價的變異係數，限制在 5% 至 60%。
 *
 * @param {{hourly_averages: (number | null)[]}[]} day_profiles 每日型態
 * @param {number} base_level 基準價
 * @returns {number} 波動度（%）
 */
function estimate_weather_volatility(day_profiles, base_level) {
  const mean_of = (hour_list, hourly_averages) => {
    const hour_values = hour_list.map((hour_value) => hourly_averages[hour_value]).filter((hour_price) => hour_price !== null);
    return hour_values.reduce((value_sum, hour_price) => value_sum + hour_price, 0) / hour_values.length;
  };
  const dip_depths = day_profiles.map((day_profile) =>
    (mean_of(SHOULDER_HOURS, day_profile.hourly_averages) - mean_of(MIDDAY_HOURS, day_profile.hourly_averages)) / base_level);
  const mean_depth = dip_depths.reduce((value_sum, dip_depth) => value_sum + dip_depth, 0) / dip_depths.length;
  const depth_deviation = Math.sqrt(dip_depths.reduce((value_sum, dip_depth) => value_sum + (dip_depth - mean_depth) ** 2, 0) / dip_depths.length);
  const coefficient_of_variation = mean_depth > 0 ? (100 * depth_deviation) / mean_depth : 25;
  return Math.round(Math.min(60, Math.max(5, coefficient_of_variation)));
}

/**
 * 一天的「最低四小時之後的最高四小時 − 最低四小時」；缺小時的窗不會被選中，算不出時為 NaN 或負無限大。
 *
 * @param {(number | null)[]} hourly_averages 各小時平均
 * @returns {number} 價差
 */
function four_hour_spread(hourly_averages) {
  const hour_prices = hourly_averages.map((hour_price) => (hour_price === null ? Number.NaN : hour_price));
  const day_summary = summarize_day_windows(hour_prices, BATTERY_DURATION_HOURS);
  return day_summary.high_after_average - day_summary.low_average;
}

/**
 * 中位數（取排序後第 n/2 個，與原工具相同）；空陣列為 0。
 *
 * @param {number[]} numeric_values 數值
 * @returns {number} 中位數
 */
function median_of(numeric_values) {
  if (numeric_values.length === 0) return 0;
  const sorted_values = [...numeric_values].sort((left_value, right_value) => left_value - right_value);
  return sorted_values[Math.floor(sorted_values.length / 2)];
}
