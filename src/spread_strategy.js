/**
 * 價差標準策略的評估（純計算）。
 *
 * 每天若電池為空，於當日最低的連續四小時充電；之後最高的連續四小時若與充電價的價差達標就放電，
 * 否則持有，之後每天看全日最高的四小時，達標或等滿最長天數就放電（等滿而未達標算強制放電）。
 * 來回效率固定 100%、不計損耗。
 */

import { BATTERY_DURATION_HOURS } from "./scenario_presets.js";

const BEST_STANDARD_TOLERANCE = 0.01;
const DISCHARGE_PROBABILITY = 0.5;
const WAIT_PROBABILITY = 0.2;
const WAIT_STANDARD_MARGIN = 1.15;

/**
 * @typedef {object} StrategyOutcome
 * @property {number} mean_value 期間淨收益期望值
 * @property {number} p10_value 第 10 百分位
 * @property {number} p50_value 中位數
 * @property {number} p90_value 第 90 百分位
 * @property {number} average_cycles 每條路徑平均放電次數
 * @property {number} average_forced 每條路徑平均強制放電次數
 * @property {number} average_wait_days 每次放電前平均等待天數
 * @property {number} average_hold_days 每條路徑平均持有未放電天數
 */

/**
 * 在模擬電價上評估一個價差標準。
 *
 * @param {import("./price_simulation.js").PriceSimulation} simulation 模擬結果
 * @param {{power_mw: number, maximum_wait_days: number}} strategy_settings 功率與最長等待天數
 * @param {number} spread_standard 價差標準
 * @returns {StrategyOutcome} 評估結果
 */
export function evaluate_spread_strategy(simulation, strategy_settings, spread_standard) {
  const cycle_energy = strategy_settings.power_mw * BATTERY_DURATION_HOURS;
  const maximum_wait_days = Math.round(strategy_settings.maximum_wait_days);
  const path_values = new Float64Array(simulation.path_count);
  const counters = { cycle_count: 0, forced_count: 0, wait_day_count: 0 };
  for (let path_index = 0; path_index < simulation.path_count; path_index++) {
    path_values[path_index] = run_single_path(simulation, path_index, { cycle_energy, maximum_wait_days, spread_standard }, counters);
  }
  const sorted_values = Array.from(path_values).sort((left_value, right_value) => left_value - right_value);
  const percentile_value = (fraction) => sorted_values[Math.floor(simulation.path_count * fraction)];
  return {
    mean_value: sorted_values.reduce((value_sum, path_value) => value_sum + path_value, 0) / simulation.path_count,
    p10_value: percentile_value(0.1),
    p50_value: percentile_value(0.5),
    p90_value: percentile_value(0.9),
    average_cycles: counters.cycle_count / simulation.path_count,
    average_forced: counters.forced_count / simulation.path_count,
    average_wait_days: counters.cycle_count ? counters.wait_day_count / counters.cycle_count : 0,
    average_hold_days: counters.wait_day_count / simulation.path_count,
  };
}

/**
 * 一條路徑逐日執行策略，回傳期間淨收益並累加計數。
 *
 * @param {import("./price_simulation.js").PriceSimulation} simulation 模擬結果
 * @param {number} path_index 路徑
 * @param {{cycle_energy: number, maximum_wait_days: number, spread_standard: number}} path_settings 設定
 * @param {{cycle_count: number, forced_count: number, wait_day_count: number}} counters 計數（就地累加）
 * @returns {number} 期間淨收益
 */
function run_single_path(simulation, path_index, path_settings, counters) {
  let is_full = false;
  let charge_price = 0;
  let waited_days = 0;
  let path_value = 0;
  for (let day_index = 0; day_index < simulation.day_count; day_index++) {
    const cell_index = path_index * simulation.day_count + day_index;
    if (!is_full) {
      is_full = true;
      charge_price = simulation.low_average[cell_index];
      waited_days = 0;
      const same_day_high = simulation.high_after_average[cell_index];
      if (same_day_high - charge_price < path_settings.spread_standard) continue;
      path_value += path_settings.cycle_energy * (same_day_high - charge_price);
      is_full = false;
      counters.cycle_count++;
      continue;
    }
    waited_days++;
    counters.wait_day_count++;
    const day_high = simulation.high_any_average[cell_index];
    const meets_standard = day_high - charge_price >= path_settings.spread_standard;
    if (!meets_standard && waited_days < path_settings.maximum_wait_days) continue;
    path_value += path_settings.cycle_energy * (day_high - charge_price);
    is_full = false;
    counters.cycle_count++;
    if (!meets_standard) counters.forced_count++;
  }
  return path_value;
}

/**
 * 第一天（今日）在所有路徑上的價差分布與最常見的充放電時段。
 *
 * @param {import("./price_simulation.js").PriceSimulation} simulation 模擬結果
 * @param {number} spread_standard 價差標準
 * @returns {{sorted_spreads: number[], hit_probability: number, median_spread: number, common_charge_hour: number, common_discharge_hour: number}}
 */
export function summarize_first_day(simulation, spread_standard) {
  const first_day_spreads = [];
  const charge_hour_counts = new Map();
  const discharge_hour_counts = new Map();
  const add_count = (count_map, hour_value) => count_map.set(hour_value, (count_map.get(hour_value) ?? 0) + 1);
  for (let path_index = 0; path_index < simulation.path_count; path_index++) {
    const cell_index = path_index * simulation.day_count;
    first_day_spreads.push(simulation.high_after_average[cell_index] - simulation.low_average[cell_index]);
    add_count(charge_hour_counts, simulation.low_start_hour[cell_index]);
    if (simulation.high_after_start_hour[cell_index] >= 0) add_count(discharge_hour_counts, simulation.high_after_start_hour[cell_index]);
  }
  first_day_spreads.sort((left_spread, right_spread) => left_spread - right_spread);
  return {
    sorted_spreads: first_day_spreads,
    hit_probability: first_day_spreads.filter((spread_value) => spread_value >= spread_standard).length / simulation.path_count,
    median_spread: first_day_spreads[Math.floor(simulation.path_count / 2)],
    common_charge_hour: most_common_hour(charge_hour_counts),
    common_discharge_hour: most_common_hour(discharge_hour_counts),
  };
}

/**
 * 出現次數最多的小時，同次數取最早。
 *
 * @param {Map<number, number>} hour_counts 小時 → 次數
 * @returns {number} 小時，沒有資料時為 0
 */
function most_common_hour(hour_counts) {
  let best_hour = 0;
  let best_count = -1;
  for (const [hour_value, hour_count] of [...hour_counts.entries()].sort((left_entry, right_entry) => left_entry[0] - right_entry[0])) {
    if (hour_count > best_count) {
      best_hour = hour_value;
      best_count = hour_count;
    }
  }
  return best_hour;
}

/**
 * 從 0 到上限等距掃描價差標準。
 *
 * @param {import("./price_simulation.js").PriceSimulation} simulation 模擬結果
 * @param {{power_mw: number, maximum_wait_days: number}} strategy_settings 策略設定
 * @param {number} maximum_standard 掃描上限
 * @param {number} step_count 分段數
 * @returns {{spread_standard: number, mean_value: number}[]} 掃描結果
 */
export function sweep_spread_standards(simulation, strategy_settings, maximum_standard, step_count) {
  return Array.from({ length: step_count + 1 }, (_unused, step_index) => {
    const spread_standard = (maximum_standard * step_index) / step_count;
    return { spread_standard, mean_value: evaluate_spread_strategy(simulation, strategy_settings, spread_standard).mean_value };
  });
}

/**
 * 建議價差標準：期望收益在最高值 1% 以內的標準中，取最高的一個（同樣收益下寧可要求較高價差）。
 *
 * @param {{spread_standard: number, mean_value: number}[]} sweep_points 掃描結果
 * @returns {{spread_standard: number, mean_value: number, point_index: number}} 建議標準
 */
export function choose_best_standard(sweep_points) {
  const highest_value = Math.max(...sweep_points.map((sweep_point) => sweep_point.mean_value));
  const tolerance_value = Math.abs(highest_value) * BEST_STANDARD_TOLERANCE;
  let point_index = 0;
  sweep_points.forEach((sweep_point, candidate_index) => { if (sweep_point.mean_value >= highest_value - tolerance_value) point_index = candidate_index; });
  return { ...sweep_points[point_index], point_index };
}

/**
 * 判斷燈號：今日達標機率 ≥ 50% 放電；20% 至 50% 且目前標準不超過建議值的 1.15 倍時等待；其餘建議下修。
 *
 * @param {number} hit_probability 今日達標機率
 * @param {number} current_standard 目前價差標準
 * @param {number} best_standard 建議價差標準
 * @returns {"discharge" | "wait" | "lower"} 燈號
 */
export function decide_verdict(hit_probability, current_standard, best_standard) {
  if (hit_probability >= DISCHARGE_PROBABILITY) return "discharge";
  if (hit_probability >= WAIT_PROBABILITY && current_standard <= best_standard * WAIT_STANDARD_MARGIN) return "wait";
  return "lower";
}
