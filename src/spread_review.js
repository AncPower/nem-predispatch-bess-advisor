/**
 * 價差標準檢討（roadmap L2、#32）的純計算：歷史收益保留率與錯失機會。
 *
 * 對 `data/daily_summary.json` 每天既有的最佳計畫，逐日判斷：當天每個循環的價差都 ≥ 標準才執行，否則當天不做。
 * 不重新選窗、不跨日持有（見 `docs/data_sources.md`〈輸出：`data/daily_summary.json`〉的限制）。
 *
 * 結果回答「這個標準保留了多少歷史可得收益、錯過哪些日子」，不是最佳營運門檻：
 * 每日計畫用的是事後電價，也沒有計入預測誤差，所以門檻越低，這裡算出的收益只會相同或更高。
 * 損益兩平價差只作成本說明（`summarize_break_even_spreads`），不限制保留範圍。
 */

/** 候選標準的間距（AUD/MWh）。 */
export const STANDARD_STEP_AUD_PER_MWH = 1;
/** 保留範圍：淨收益不低於最高值的這個比例。 */
export const RETENTION_TARGET = 0.99;
/** 有效天數少於這個值時加註樣本不足。 */
export const MINIMUM_SAMPLE_DAYS = 60;
/** 南半球季節。 */
export const SEASON_LABELS = Object.freeze({
  summer: "夏季（12–2 月）",
  autumn: "秋季（3–5 月）",
  winter: "冬季（6–8 月）",
  spring: "春季（9–11 月）",
});

const SEASON_BY_MONTH = Object.freeze([
  "summer", "summer", "autumn", "autumn", "autumn", "winter", "winter", "winter", "spring", "spring", "spring", "summer",
]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_START_INDEX = 5;
const MONTH_END_INDEX = 7;
const VALUE_TOLERANCE_AUD = 1e-9;

/**
 * @typedef {object} ReviewDay
 * @property {string} date 交易日（YYYY-MM-DD）
 * @property {boolean} excluded 是否因資料不完整而排除
 * @property {string | null} exclusion_reason 排除原因
 * @property {number | null} net_value_aud 當天最佳計畫的淨收益
 * @property {number | null} best_spread_aud_per_mwh 各循環價差的最小值；沒有循環時為 null
 * @property {readonly object[]} cycles 各循環
 */

/**
 * @typedef {object} StandardOutcome
 * @property {number} spread_standard 價差標準（AUD/MWh）
 * @property {number} executed_day_count 執行天數
 * @property {number} net_value_aud 執行日的淨收益加總
 * @property {number} skipped_day_count 有獲利計畫但價差未達標而不做的天數
 * @property {number} skipped_value_aud 這些天的潛在收益
 * @property {number | null} retention_ratio 淨收益 ÷ 所有候選標準中的最高淨收益；最高值不為正時為 null
 */

/**
 * @typedef {object} SpreadReview
 * @property {"no_data" | "no_revenue" | "keep" | "lower"} status 沒有有效日、沒有正收益、維持、建議下調
 * @property {number} current_standard 目前標準
 * @property {number} valid_day_count 有效天數（未因資料不完整而排除）
 * @property {number} no_plan_day_count 資料完整但沒有淨收益為正的計畫的天數
 * @property {{date: string, reason: string}[]} data_excluded_days 資料不完整而排除的日子
 * @property {string[]} warnings 樣本不足、季節限制的提示
 * @property {StandardOutcome[]} sweep_points 各候選標準的結果，依標準遞增；沒有有效日時為空
 * @property {StandardOutcome | null} current_outcome 目前標準的結果
 * @property {number | null} maximum_value_aud 最高淨收益（標準 0 時）
 * @property {number | null} highest_retained_standard 淨收益仍達最高值 99% 的最高候選標準；不給建議時為 null
 */

/**
 * 取出起訖日之間（含兩端）的每日資料，順序不變。
 *
 * @template {{date: string}} DayRecord
 * @param {readonly DayRecord[]} day_records 每日資料
 * @param {string} start_date 起日（YYYY-MM-DD）
 * @param {string} end_date 迄日（YYYY-MM-DD）
 * @returns {DayRecord[]} 期間內的每日資料
 * @throws {Error} 日期格式不符或起日晚於迄日時
 */
export function select_period_days(day_records, start_date, end_date) {
  if (!ISO_DATE_PATTERN.test(start_date)) throw new Error(`起日必須是 YYYY-MM-DD：${JSON.stringify(start_date)}`);
  if (!ISO_DATE_PATTERN.test(end_date)) throw new Error(`迄日必須是 YYYY-MM-DD：${JSON.stringify(end_date)}`);
  if (start_date > end_date) throw new Error(`起日 ${start_date} 不可晚於迄日 ${end_date}`);
  return day_records.filter((day_record) => day_record.date >= start_date && day_record.date <= end_date);
}

/**
 * 候選標準：0 到「最高每日價差向上取整」與「目前標準」兩者的較大值，每 1 AUD/MWh 一個；
 * 目前標準不是整數時另外插入它的精確值。
 *
 * @param {number} maximum_spread 有效日中最高的每日價差（沒有計畫時傳 0）
 * @param {number} current_standard 目前標準
 * @returns {number[]} 遞增排列的候選標準
 */
export function build_candidate_standards(maximum_spread, current_standard) {
  const upper_standard = Math.max(Math.ceil(maximum_spread), Math.ceil(current_standard), 0);
  const candidate_standards = [];
  for (let standard_value = 0; standard_value <= upper_standard; standard_value += STANDARD_STEP_AUD_PER_MWH) {
    candidate_standards.push(standard_value);
  }
  if (!Number.isInteger(current_standard)) {
    candidate_standards.push(current_standard);
    candidate_standards.sort((left_value, right_value) => left_value - right_value);
  }
  return candidate_standards;
}

/**
 * 對目前標準與所有候選標準做逐日檢討。
 *
 * @param {readonly ReviewDay[]} day_records 已依期間與事件檢視篩選的每日資料
 * @param {number} current_standard 目前標準（`config/spread_standard.json`）
 * @returns {SpreadReview} 檢討結果
 * @throws {Error} 目前標準不合法，或某天的價差與收益互相矛盾時
 */
export function review_spread_standards(day_records, current_standard) {
  if (typeof current_standard !== "number" || !Number.isFinite(current_standard) || current_standard < 0) {
    throw new Error(`目前價差標準必須是 0 以上的數值：${JSON.stringify(current_standard)}`);
  }
  const valid_days = day_records.filter((day_record) => !day_record.excluded);
  valid_days.forEach(check_review_day);
  const planned_days = valid_days.filter((day_record) => day_record.best_spread_aud_per_mwh !== null);
  const review_base = {
    current_standard,
    valid_day_count: valid_days.length,
    no_plan_day_count: valid_days.length - planned_days.length,
    data_excluded_days: day_records
      .filter((day_record) => day_record.excluded)
      .map((day_record) => ({ date: day_record.date, reason: day_record.exclusion_reason })),
    warnings: build_sample_warnings(valid_days),
  };
  if (valid_days.length === 0) {
    return { ...review_base, status: "no_data", sweep_points: [], current_outcome: null, maximum_value_aud: null, highest_retained_standard: null };
  }
  const maximum_spread = planned_days.reduce((largest_spread, day_record) => Math.max(largest_spread, day_record.best_spread_aud_per_mwh), 0);
  const outcome_for = build_outcome_evaluator(planned_days);
  const raw_points = build_candidate_standards(maximum_spread, current_standard).map(outcome_for);
  const maximum_value_aud = Math.max(...raw_points.map((sweep_point) => sweep_point.net_value_aud));
  const sweep_points = raw_points.map((sweep_point) => ({
    ...sweep_point,
    retention_ratio: maximum_value_aud > 0 ? sweep_point.net_value_aud / maximum_value_aud : null,
  }));
  const current_outcome = sweep_points.find((sweep_point) => sweep_point.spread_standard === current_standard);
  if (!(maximum_value_aud > 0)) {
    return { ...review_base, status: "no_revenue", sweep_points, current_outcome, maximum_value_aud, highest_retained_standard: null };
  }
  const retained_minimum = RETENTION_TARGET * maximum_value_aud - VALUE_TOLERANCE_AUD;
  const is_retained = (sweep_point) => sweep_point.net_value_aud >= retained_minimum;
  const highest_retained_standard = sweep_points.filter(is_retained).at(-1).spread_standard;
  return {
    ...review_base,
    status: is_retained(current_outcome) ? "keep" : "lower",
    sweep_points,
    current_outcome,
    maximum_value_aud,
    highest_retained_standard,
  };
}

/**
 * 每個循環的損益兩平價差摘要（只作成本說明，不是門檻）。
 *
 * @param {readonly ReviewDay[]} day_records 已篩選的每日資料；資料不完整的日子略過
 * @param {(charge_average_price: number) => number} compute_break_even 由充電均價算損益兩平價差，例如 `window_selection.break_even_spread`
 * @returns {{cycle_count: number, minimum: number, median: number, maximum: number} | null} 沒有任何循環時為 null
 * @throws {Error} 循環缺少充電均價時
 */
export function summarize_break_even_spreads(day_records, compute_break_even) {
  const break_even_values = [];
  for (const day_record of day_records) {
    if (day_record.excluded) continue;
    day_record.cycles.forEach((planned_cycle, cycle_index) => {
      const charge_average_price = planned_cycle?.charge_average_price_aud_per_mwh;
      if (typeof charge_average_price !== "number" || !Number.isFinite(charge_average_price)) {
        throw new Error(`${day_record.date} 第 ${cycle_index + 1} 個循環的 charge_average_price_aud_per_mwh 必須是數值`);
      }
      break_even_values.push(compute_break_even(charge_average_price));
    });
  }
  if (break_even_values.length === 0) return null;
  break_even_values.sort((left_value, right_value) => left_value - right_value);
  const middle_index = Math.floor(break_even_values.length / 2);
  const median = break_even_values.length % 2 === 1
    ? break_even_values[middle_index]
    : (break_even_values[middle_index - 1] + break_even_values[middle_index]) / 2;
  return { cycle_count: break_even_values.length, minimum: break_even_values[0], median, maximum: break_even_values.at(-1) };
}

/**
 * 檢查一天的價差與收益是否一致：沒有價差（沒有循環）時淨收益必須為 0，有價差時必須有循環。
 *
 * @param {ReviewDay} day_record 一天
 * @throws {Error} 不一致時
 */
function check_review_day(day_record) {
  if (day_record.best_spread_aud_per_mwh === null) {
    if (day_record.net_value_aud !== 0) throw new Error(`${day_record.date} 沒有價差，淨收益卻不是 0：${day_record.net_value_aud}`);
    return;
  }
  if (day_record.cycles.length === 0) throw new Error(`${day_record.date} 有價差卻沒有任何循環`);
}

/**
 * 依價差排序並建立後綴加總，之後每個標準以二分搜尋求結果。
 *
 * @param {readonly ReviewDay[]} planned_days 有計畫的有效日
 * @returns {(spread_standard: number) => Omit<StandardOutcome, "retention_ratio">} 單一標準的結果
 */
function build_outcome_evaluator(planned_days) {
  const sorted_days = [...planned_days].sort((left_day, right_day) => left_day.best_spread_aud_per_mwh - right_day.best_spread_aud_per_mwh);
  const sorted_spreads = sorted_days.map((day_record) => day_record.best_spread_aud_per_mwh);
  const suffix_values = new Array(sorted_days.length + 1).fill(0);
  for (let day_index = sorted_days.length - 1; day_index >= 0; day_index--) {
    suffix_values[day_index] = suffix_values[day_index + 1] + sorted_days[day_index].net_value_aud;
  }
  return (spread_standard) => {
    const first_executed_index = find_first_at_least(sorted_spreads, spread_standard);
    return {
      spread_standard,
      executed_day_count: sorted_days.length - first_executed_index,
      net_value_aud: suffix_values[first_executed_index],
      skipped_day_count: first_executed_index,
      skipped_value_aud: suffix_values[0] - suffix_values[first_executed_index],
    };
  };
}

/**
 * 遞增陣列中第一個 ≥ 目標值的位置；全部都小於目標值時回傳長度。
 *
 * @param {readonly number[]} sorted_values 遞增排列的數值
 * @param {number} target_value 目標值
 * @returns {number} 位置
 */
function find_first_at_least(sorted_values, target_value) {
  let low_index = 0;
  let high_index = sorted_values.length;
  while (low_index < high_index) {
    const middle_index = (low_index + high_index) >> 1;
    if (sorted_values[middle_index] >= target_value) high_index = middle_index;
    else low_index = middle_index + 1;
  }
  return low_index;
}

/**
 * 依有效日產生樣本提示：少於 60 天加註樣本不足；只涵蓋一個季節加註季節限制。
 *
 * @param {readonly {date: string}[]} valid_days 有效日
 * @returns {string[]} 提示
 */
function build_sample_warnings(valid_days) {
  if (valid_days.length === 0) return [];
  const warnings = [];
  if (valid_days.length < MINIMUM_SAMPLE_DAYS) {
    warnings.push(`樣本不足：有效日只有 ${valid_days.length} 天（少於 ${MINIMUM_SAMPLE_DAYS} 天），結論僅供參考。`);
  }
  const seasons = new Set(valid_days.map((day_record) => SEASON_BY_MONTH[Number(day_record.date.slice(MONTH_START_INDEX, MONTH_END_INDEX)) - 1]));
  if (seasons.size === 1) {
    warnings.push(`季節限制：有效日只涵蓋${SEASON_LABELS[[...seasons][0]]}，不能代表其他季節。`);
  }
  return warnings;
}
