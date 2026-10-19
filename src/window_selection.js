/**
 * 在預調度電價上選出建議充放電窗（純計算，不連網路、不碰畫面）。
 *
 * 每段窗口長度相同（容量 ÷ 功率）、連續、滿功率、不重疊且依序排列。一個循環是「充、放」兩段，
 * 兩個循環是「充、放、充、放」四段一起選，以動態規劃求「放電段總價 − 充電段總價」的精確最大值。
 * 同分時取最早的組合；一個與兩個循環同分時取一個；沒有任何組合能獲利時不排。
 * 來回效率固定 100%、不計損耗，所以收益只看價差。
 */

import { INTERVAL_HOURS } from "./nem_time.js";

const PRICE_SCALE_FACTOR = 1_000_000;
const KIND_SIGN = Object.freeze({ charge: -1, discharge: 1 });
const SINGLE_CYCLE_PATTERN = Object.freeze(["charge", "discharge"]);
const DOUBLE_CYCLE_PATTERN = Object.freeze(["charge", "discharge", "charge", "discharge"]);

/**
 * @typedef {object} BatterySpec
 * @property {number} power_mw 功率（MW）
 * @property {number} capacity_mwh 容量（MWh）
 * @property {number} marginal_loss_factor 損失係數（MLF），只縮放收益，不影響選窗
 */

/**
 * @typedef {object} PlannedCycle
 * @property {number} charge_start_index 充電段第一個時段的索引
 * @property {number} discharge_start_index 放電段第一個時段的索引
 * @property {number} charge_average_price 充電段均價（AUD/MWh）
 * @property {number} discharge_average_price 放電段均價（AUD/MWh）
 * @property {number} net_value 預估淨收益（AUD）
 */

/**
 * 每段窗口的時段數：滿充所需時間 ÷ 30 分鐘，至少 1 段。
 *
 * @param {BatterySpec} battery_spec 電池規格
 * @returns {number} 每段時段數
 */
export function segment_length_for(battery_spec) {
  return Math.max(1, Math.round(battery_spec.capacity_mwh / battery_spec.power_mw / INTERVAL_HOURS));
}

/**
 * 選出淨收益最高的建議計畫（最多兩個循環）。
 *
 * @param {number[]} price_values 依時間排序的 30 分鐘電價（AUD/MWh）
 * @param {BatterySpec} battery_spec 電池規格
 * @returns {{segment_length: number, energy_mwh: number, cycles: PlannedCycle[], total_value: number}}
 * @throws {Error} 電價含非有限數值時
 */
export function select_best_plan(price_values, battery_spec) {
  if (price_values.some((price_value) => !Number.isFinite(price_value))) {
    throw new Error("選窗用的電價含有非數值");
  }
  const segment_length = segment_length_for(battery_spec);
  const energy_mwh = Math.min(battery_spec.capacity_mwh, battery_spec.power_mw * segment_length * INTERVAL_HOURS);
  const scaled_prices = price_values.map((price_value) => Math.round(price_value * PRICE_SCALE_FACTOR));
  const segment_sums = compute_segment_sums(scaled_prices, segment_length);
  const best_solution = choose_best_solution(segment_sums, segment_length);
  const cycles = best_solution
    ? build_cycles(best_solution.segment_starts, segment_sums, segment_length, energy_mwh, battery_spec.marginal_loss_factor)
    : [];
  const total_value = cycles.reduce((value_sum, planned_cycle) => value_sum + planned_cycle.net_value, 0);
  return { segment_length, energy_mwh, cycles, total_value };
}

/**
 * 一個循環與兩個循環各求最佳解，取總分為正且最高者；同分取循環數少的。
 *
 * @param {number[]} segment_sums 每個起點的段內價格總和（放大後的整數）
 * @param {number} segment_length 每段時段數
 * @returns {{total_score: number, segment_starts: number[]} | null} 最佳解，沒有獲利組合時為 null
 */
function choose_best_solution(segment_sums, segment_length) {
  let best_solution = null;
  for (const pattern of [SINGLE_CYCLE_PATTERN, DOUBLE_CYCLE_PATTERN]) {
    const pattern_solution = solve_pattern(segment_sums, pattern, segment_length);
    if (!pattern_solution || pattern_solution.total_score <= 0) continue;
    if (!best_solution || pattern_solution.total_score > best_solution.total_score) best_solution = pattern_solution;
  }
  return best_solution;
}

/**
 * 每個合法起點的段內價格總和（整數運算，沒有浮點誤差）。
 *
 * @param {number[]} scaled_prices 放大成整數的電價
 * @param {number} segment_length 每段時段數
 * @returns {number[]} 長度為「時段數 − 段長 + 1」的總和陣列
 */
function compute_segment_sums(scaled_prices, segment_length) {
  const segment_sums = [];
  let running_sum = 0;
  for (let price_index = 0; price_index < scaled_prices.length; price_index++) {
    running_sum += scaled_prices[price_index];
    if (price_index >= segment_length) running_sum -= scaled_prices[price_index - segment_length];
    if (price_index >= segment_length - 1) segment_sums.push(running_sum);
  }
  return segment_sums;
}

/**
 * 依指定段型（例如充、放、充、放）求最佳起點組合。
 *
 * @param {number[]} segment_sums 每個起點的段內價格總和
 * @param {readonly string[]} pattern 段型
 * @param {number} segment_length 每段時段數
 * @returns {{total_score: number, segment_starts: number[]} | null} 放不下時為 null
 */
function solve_pattern(segment_sums, pattern, segment_length) {
  const required_intervals = segment_length * pattern.length;
  if (segment_sums.length + segment_length - 1 < required_intervals) return null;
  const suffix_tables = build_suffix_tables(segment_sums, pattern, segment_length);
  const segment_starts = reconstruct_starts(segment_sums, pattern, segment_length, suffix_tables);
  return { total_score: suffix_tables[0][0], segment_starts };
}

/**
 * 第 j 段起點為 s 時，第 j 段到最後一段的總分；接不上後續段時為負無限大。
 *
 * @param {number[]} segment_sums 每個起點的段內價格總和
 * @param {string} segment_kind 本段種類（charge 或 discharge）
 * @param {number} segment_length 每段時段數
 * @param {number[] | undefined} later_best_scores 下一段的後綴最大值表，本段為最後一段時為 undefined
 * @returns {number[]} 每個起點的總分
 */
function score_from_segment(segment_sums, segment_kind, segment_length, later_best_scores) {
  const kind_sign = KIND_SIGN[segment_kind];
  return segment_sums.map((segment_sum, start_index) => {
    const own_score = kind_sign * segment_sum;
    if (!later_best_scores) return own_score;
    const next_start_index = start_index + segment_length;
    return next_start_index < later_best_scores.length
      ? own_score + later_best_scores[next_start_index]
      : Number.NEGATIVE_INFINITY;
  });
}

/**
 * 由最後一段往前建表：`tables[j][s]` 為第 j 段起點不早於 s 時，第 j 段到最後一段的最大總分。
 *
 * @param {number[]} segment_sums 每個起點的段內價格總和
 * @param {readonly string[]} pattern 段型
 * @param {number} segment_length 每段時段數
 * @returns {number[][]} 每段的後綴最大值表
 */
function build_suffix_tables(segment_sums, pattern, segment_length) {
  const suffix_tables = new Array(pattern.length);
  for (let segment_index = pattern.length - 1; segment_index >= 0; segment_index--) {
    const total_scores = score_from_segment(
      segment_sums,
      pattern[segment_index],
      segment_length,
      suffix_tables[segment_index + 1],
    );
    suffix_tables[segment_index] = suffix_maximum(total_scores);
  }
  return suffix_tables;
}

/**
 * `result[s]` 為起點 s 以後（含）的最大值。
 *
 * @param {number[]} score_values 每個起點的分數
 * @returns {number[]} 後綴最大值
 */
function suffix_maximum(score_values) {
  const suffix_values = score_values.slice();
  for (let start_index = suffix_values.length - 2; start_index >= 0; start_index--) {
    suffix_values[start_index] = Math.max(suffix_values[start_index], suffix_values[start_index + 1]);
  }
  return suffix_values;
}

/**
 * 由第一段往後還原：每段取達到最佳總分的最早起點。
 *
 * @param {number[]} segment_sums 每個起點的段內價格總和
 * @param {readonly string[]} pattern 段型
 * @param {number} segment_length 每段時段數
 * @param {number[][]} suffix_tables 後綴最大值表
 * @returns {number[]} 每段的起點索引
 */
function reconstruct_starts(segment_sums, pattern, segment_length, suffix_tables) {
  const segment_starts = [];
  let earliest_start = 0;
  for (let segment_index = 0; segment_index < pattern.length; segment_index++) {
    const target_score = suffix_tables[segment_index][earliest_start];
    const candidate_scores = score_from_segment(
      segment_sums,
      pattern[segment_index],
      segment_length,
      suffix_tables[segment_index + 1],
    );
    let chosen_start = earliest_start;
    while (candidate_scores[chosen_start] !== target_score) chosen_start++;
    segment_starts.push(chosen_start);
    earliest_start = chosen_start + segment_length;
  }
  return segment_starts;
}

/**
 * 把起點索引兩兩配成循環，換算均價與淨收益。
 *
 * @param {number[]} segment_starts 依序的充、放起點
 * @param {number[]} segment_sums 每個起點的段內價格總和
 * @param {number} segment_length 每段時段數
 * @param {number} energy_mwh 每次充放的電量
 * @param {number} marginal_loss_factor 損失係數
 * @returns {PlannedCycle[]} 循環清單
 */
function build_cycles(segment_starts, segment_sums, segment_length, energy_mwh, marginal_loss_factor) {
  const average_price_at = (start_index) => segment_sums[start_index] / segment_length / PRICE_SCALE_FACTOR;
  const planned_cycles = [];
  for (let pair_index = 0; pair_index < segment_starts.length; pair_index += 2) {
    const charge_start_index = segment_starts[pair_index];
    const discharge_start_index = segment_starts[pair_index + 1];
    const charge_average_price = average_price_at(charge_start_index);
    const discharge_average_price = average_price_at(discharge_start_index);
    const net_value = energy_mwh * marginal_loss_factor * (discharge_average_price - charge_average_price);
    planned_cycles.push({ charge_start_index, discharge_start_index, charge_average_price, discharge_average_price, net_value });
  }
  return planned_cycles;
}

/**
 * 由建議計畫推出自訂價格的預設值：取淨收益最高的循環，充電上限為其充電段最高價，價差為其放電段最低價減充電上限。
 * 沒有建議循環時，充電上限取最低價、價差設成讓放電下限高於最高價（等於不放電）。
 *
 * @param {number[]} price_values 依時間排序的電價
 * @param {{segment_length: number, cycles: PlannedCycle[]}} plan_result `select_best_plan` 的結果
 * @returns {{charge_price_cap: number, price_spread: number}} 建議的充電上限與價差（四捨五入到整數）
 */
export function suggest_price_thresholds(price_values, plan_result) {
  if (price_values.length === 0) return { charge_price_cap: 0, price_spread: 0 };
  if (plan_result.cycles.length === 0) {
    const lowest_price = Math.min(...price_values);
    return { charge_price_cap: Math.round(lowest_price), price_spread: Math.round(Math.max(...price_values) - lowest_price + 1) };
  }
  const main_cycle = plan_result.cycles.reduce((best_cycle, planned_cycle) => (planned_cycle.net_value > best_cycle.net_value ? planned_cycle : best_cycle));
  const window_prices = (start_index) => price_values.slice(start_index, start_index + plan_result.segment_length);
  const charge_price_cap = Math.max(...window_prices(main_cycle.charge_start_index));
  const discharge_price_floor = Math.min(...window_prices(main_cycle.discharge_start_index));
  return { charge_price_cap: Math.round(charge_price_cap), price_spread: Math.round(Math.max(0, discharge_price_floor - charge_price_cap)) };
}
