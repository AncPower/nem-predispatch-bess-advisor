/**
 * 在預調度電價上選出建議充放電窗（純計算，不連網路、不碰畫面）。
 *
 * 每段窗口長度相同（容量 ÷ 功率）、連續、滿功率、不重疊且依序排列。一個循環是「充、放」兩段，
 * 兩個循環是「充、放、充、放」四段一起選，求淨收益的精確最大值。
 * 每個循環的價差（放電段均價 − 充電段均價）必須為正、不低於每循環最低價差，且淨收益必須為正。
 * 同分時取最早的組合；一個與兩個循環同分時取一個；沒有任何組合符合時不排。
 *
 * 效率與損耗（#27）：每次充電量為「容量」，放電量為「容量 × 來回效率」（充電量＝放電量 ÷ 來回效率），
 * 淨收益＝放電量 × 放電均價 × MLF − 充電量 × 充電均價 × MLF − 放電量 × 每 MWh 損耗成本。
 * 來回效率 1、損耗 0 時，選窗與收益和只看價差時完全相同。
 */

import { INTERVAL_HOURS } from "./nem_time.js";

const PRICE_SCALE_FACTOR = 1_000_000;

/**
 * @typedef {object} BatterySpec
 * @property {number} power_mw 功率（MW）
 * @property {number} capacity_mwh 容量（MWh）
 * @property {number} marginal_loss_factor 損失係數（MLF）
 * @property {number} round_trip_efficiency 來回效率，大於 0 且不超過 1
 * @property {number} degradation_cost_aud_per_mwh 每 MWh 放電的損耗成本（AUD），0 以上
 */

/**
 * @typedef {object} PlannedCycle
 * @property {number} charge_start_index 充電段第一個時段的索引
 * @property {number} discharge_start_index 放電段第一個時段的索引
 * @property {number} charge_average_price 充電段均價（AUD/MWh）
 * @property {number} discharge_average_price 放電段均價（AUD/MWh）
 * @property {number} net_value 預估淨收益（AUD），已扣除效率損失與損耗成本
 */

/**
 * @typedef {{charge_start: number, discharge_start: number, cycle_score: number}} CandidateCycle
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
 * 損益兩平價差：放電均價 − 充電均價至少要高於這個值，淨收益才會為正。
 *
 * 由「放電量 × 放電均價 × MLF ＞ 充電量 × 充電均價 × MLF ＋ 放電量 × 損耗成本」推得：
 * 充電均價 ×（1 ÷ 效率 − 1）＋ 損耗成本 ÷ MLF；MLF 為 1 時即 roadmap D3 的公式。
 *
 * @param {number} charge_average_price 充電段均價（AUD/MWh）
 * @param {BatterySpec} battery_spec 電池規格
 * @returns {number} 損益兩平價差（AUD/MWh）
 * @throws {Error} 來回效率或損耗成本不合法時
 */
export function break_even_spread(charge_average_price, battery_spec) {
  validate_battery_costs(battery_spec);
  return (
    charge_average_price * (1 / battery_spec.round_trip_efficiency - 1) +
    battery_spec.degradation_cost_aud_per_mwh / battery_spec.marginal_loss_factor
  );
}

/**
 * 選出淨收益最高的建議計畫（最多兩個循環）。
 *
 * @param {number[]} price_values 依時間排序的 30 分鐘電價（AUD/MWh）
 * @param {BatterySpec} battery_spec 電池規格
 * @param {number} [minimum_cycle_spread] 每循環最低價差（AUD/MWh），預設 0
 * @returns {{segment_length: number, energy_mwh: number, discharge_energy_mwh: number, cycles: PlannedCycle[], total_value: number}}
 *   `energy_mwh` 為每次充電量，`discharge_energy_mwh` 為每次放電量
 * @throws {Error} 電價含非有限數值、最低價差為負或非數值，或來回效率、損耗成本不合法時
 */
export function select_best_plan(price_values, battery_spec, minimum_cycle_spread = 0) {
  if (price_values.some((price_value) => !Number.isFinite(price_value))) {
    throw new Error("選窗用的電價含有非數值");
  }
  if (!Number.isFinite(minimum_cycle_spread) || minimum_cycle_spread < 0) {
    throw new Error(`每循環最低價差必須是 0 以上的數值：${minimum_cycle_spread}`);
  }
  validate_battery_costs(battery_spec);
  const segment_length = segment_length_for(battery_spec);
  const energy_mwh = Math.min(battery_spec.capacity_mwh, battery_spec.power_mw * segment_length * INTERVAL_HOURS);
  const discharge_energy_mwh = energy_mwh * battery_spec.round_trip_efficiency;
  const scaled_prices = price_values.map((price_value) => Math.round(price_value * PRICE_SCALE_FACTOR));
  const segment_sums = compute_segment_sums(scaled_prices, segment_length);
  const minimum_cycle_score = Math.round(minimum_cycle_spread * PRICE_SCALE_FACTOR) * segment_length;
  const score_settings = build_score_settings(battery_spec, segment_length);
  const candidate_cycles = enumerate_candidate_cycles(segment_sums, segment_length, minimum_cycle_score, score_settings);
  const chosen_cycles = choose_best_cycles(candidate_cycles, segment_sums.length, segment_length);
  const cycles = chosen_cycles.map((candidate_cycle) =>
    build_cycle(candidate_cycle, segment_sums, segment_length, { energy_mwh, discharge_energy_mwh }, battery_spec),
  );
  const total_value = cycles.reduce((value_sum, planned_cycle) => value_sum + planned_cycle.net_value, 0);
  return { segment_length, energy_mwh, discharge_energy_mwh, cycles, total_value };
}

/**
 * 檢查來回效率與損耗成本；設定檔讀取時已驗證，這裡再擋一次，避免漏傳欄位算出 NaN。
 *
 * @param {BatterySpec} battery_spec 電池規格
 * @throws {Error} 來回效率不在 (0, 1]，或損耗成本為負或非數值時
 */
function validate_battery_costs(battery_spec) {
  const efficiency = battery_spec.round_trip_efficiency;
  if (!Number.isFinite(efficiency) || efficiency <= 0 || efficiency > 1) {
    throw new Error(`來回效率必須大於 0 且不超過 1：${efficiency}`);
  }
  const degradation_cost = battery_spec.degradation_cost_aud_per_mwh;
  if (!Number.isFinite(degradation_cost) || degradation_cost < 0) {
    throw new Error(`每 MWh 損耗成本必須是 0 以上的數值：${degradation_cost}`);
  }
}

/**
 * 排序用分數的參數。分數＝MLF ×（效率 × 放電段總和 − 充電段總和）− 效率 × 損耗成本 × 段長（皆已放大），
 * 與淨收益成正比（比例為 每時段電量 ÷ 放大倍數），所以依分數排序就是依淨收益排序。
 *
 * @param {BatterySpec} battery_spec 電池規格
 * @param {number} segment_length 每段時段數
 * @returns {{marginal_loss_factor: number, round_trip_efficiency: number, degradation_score: number}}
 */
function build_score_settings(battery_spec, segment_length) {
  const scaled_degradation_cost = Math.round(battery_spec.degradation_cost_aud_per_mwh * PRICE_SCALE_FACTOR);
  return {
    marginal_loss_factor: battery_spec.marginal_loss_factor,
    round_trip_efficiency: battery_spec.round_trip_efficiency,
    degradation_score: battery_spec.round_trip_efficiency * scaled_degradation_cost * segment_length,
  };
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
 * 列出所有符合條件的「充電段、放電段」配對，依（充電起點、放電起點）由早到晚排序。
 *
 * @param {number[]} segment_sums 每個起點的段內價格總和
 * @param {number} segment_length 每段時段數
 * @param {number} minimum_cycle_score 每循環最低的段總和差（放大後的整數）
 * @param {{marginal_loss_factor: number, round_trip_efficiency: number, degradation_score: number}} score_settings 分數參數
 * @returns {CandidateCycle[]} 價差為正、不低於門檻且淨收益為正的配對；`cycle_score` 為淨收益分數
 */
function enumerate_candidate_cycles(segment_sums, segment_length, minimum_cycle_score, score_settings) {
  const candidate_cycles = [];
  for (let charge_start = 0; charge_start < segment_sums.length; charge_start++) {
    for (let discharge_start = charge_start + segment_length; discharge_start < segment_sums.length; discharge_start++) {
      const spread_score = segment_sums[discharge_start] - segment_sums[charge_start];
      if (spread_score <= 0 || spread_score < minimum_cycle_score) continue;
      const cycle_score =
        score_settings.marginal_loss_factor *
          (score_settings.round_trip_efficiency * segment_sums[discharge_start] - segment_sums[charge_start]) -
        score_settings.degradation_score;
      if (cycle_score > 0) candidate_cycles.push({ charge_start, discharge_start, cycle_score });
    }
  }
  return candidate_cycles;
}

/**
 * 比較最佳單循環與最佳雙循環；雙循環必須嚴格較高才採用。
 *
 * @param {CandidateCycle[]} candidate_cycles 依起點排序的候選配對
 * @param {number} start_count 合法起點數
 * @param {number} segment_length 每段時段數
 * @returns {CandidateCycle[]} 選中的 0 到 2 個循環
 */
function choose_best_cycles(candidate_cycles, start_count, segment_length) {
  if (candidate_cycles.length === 0) return [];
  const best_single = candidate_cycles.reduce((best_cycle, candidate_cycle) =>
    candidate_cycle.cycle_score > best_cycle.cycle_score ? candidate_cycle : best_cycle,
  );
  const best_from_start = build_best_from_start(candidate_cycles, start_count);
  let best_pair = null;
  for (const first_cycle of candidate_cycles) {
    const second_cycle = best_from_start[first_cycle.discharge_start + segment_length];
    if (!second_cycle) continue;
    const pair_score = first_cycle.cycle_score + second_cycle.cycle_score;
    if (!best_pair || pair_score > best_pair.pair_score) best_pair = { pair_score, cycles: [first_cycle, second_cycle] };
  }
  return best_pair && best_pair.pair_score > best_single.cycle_score ? best_pair.cycles : [best_single];
}

/**
 * `result[t]` 為充電起點不早於 t 的最佳配對，同分取最早；沒有時為 undefined。
 *
 * @param {CandidateCycle[]} candidate_cycles 依起點排序的候選配對
 * @param {number} start_count 合法起點數
 * @returns {(CandidateCycle | undefined)[]} 長度為 start_count + 1 的後綴表
 */
function build_best_from_start(candidate_cycles, start_count) {
  const best_from_start = new Array(start_count + 1).fill(undefined);
  for (let candidate_index = candidate_cycles.length - 1; candidate_index >= 0; candidate_index--) {
    const candidate_cycle = candidate_cycles[candidate_index];
    const current_best = best_from_start[candidate_cycle.charge_start];
    if (!current_best || candidate_cycle.cycle_score >= current_best.cycle_score) {
      best_from_start[candidate_cycle.charge_start] = candidate_cycle;
    }
  }
  for (let start_index = start_count - 1; start_index >= 0; start_index--) {
    const later_best = best_from_start[start_index + 1];
    const own_best = best_from_start[start_index];
    if (later_best && (!own_best || later_best.cycle_score > own_best.cycle_score)) best_from_start[start_index] = later_best;
  }
  return best_from_start;
}

/**
 * 把候選配對換算成均價與淨收益；運算順序與 Python 版相同，浮點結果才會一致。
 *
 * @param {CandidateCycle} candidate_cycle 選中的配對
 * @param {number[]} segment_sums 每個起點的段內價格總和
 * @param {number} segment_length 每段時段數
 * @param {{energy_mwh: number, discharge_energy_mwh: number}} cycle_energy 每次充電量與放電量
 * @param {BatterySpec} battery_spec 電池規格
 * @returns {PlannedCycle} 循環
 */
function build_cycle(candidate_cycle, segment_sums, segment_length, cycle_energy, battery_spec) {
  const average_price_at = (start_index) => segment_sums[start_index] / segment_length / PRICE_SCALE_FACTOR;
  const charge_average_price = average_price_at(candidate_cycle.charge_start);
  const discharge_average_price = average_price_at(candidate_cycle.discharge_start);
  const settled_spread = battery_spec.round_trip_efficiency * discharge_average_price - charge_average_price;
  return {
    charge_start_index: candidate_cycle.charge_start,
    discharge_start_index: candidate_cycle.discharge_start,
    charge_average_price,
    discharge_average_price,
    net_value:
      cycle_energy.energy_mwh * battery_spec.marginal_loss_factor * settled_spread -
      cycle_energy.discharge_energy_mwh * battery_spec.degradation_cost_aud_per_mwh,
  };
}

/**
 * 由建議計畫推出自訂價格的預設值：取淨收益最高的循環，充電上限為其充電段最高價（無條件進位），
 * 放電下限為其放電段最低價（無條件捨去），價差為兩者之差。取整的方向確保窗內每個時段都落在門檻內，
 * 用這組門檻模擬時會充滿、放完同一個窗。
 * 沒有建議循環時，充電上限取最低價（無條件捨去）、放電下限高於最高價（等於不放電）。
 *
 * @param {number[]} price_values 依時間排序的電價
 * @param {{segment_length: number, cycles: PlannedCycle[]}} plan_result `select_best_plan` 的結果
 * @returns {{charge_price_cap: number, price_spread: number}} 建議的充電上限與價差（整數）
 */
export function suggest_price_thresholds(price_values, plan_result) {
  if (price_values.length === 0) return { charge_price_cap: 0, price_spread: 0 };
  if (plan_result.cycles.length === 0) {
    const charge_price_cap = Math.floor(Math.min(...price_values));
    return { charge_price_cap, price_spread: Math.floor(Math.max(...price_values)) - charge_price_cap + 1 };
  }
  const main_cycle = plan_result.cycles.reduce((best_cycle, planned_cycle) => (planned_cycle.net_value > best_cycle.net_value ? planned_cycle : best_cycle));
  const window_prices = (start_index) => price_values.slice(start_index, start_index + plan_result.segment_length);
  const charge_price_cap = Math.ceil(Math.max(...window_prices(main_cycle.charge_start_index)));
  const discharge_price_floor = Math.floor(Math.min(...window_prices(main_cycle.discharge_start_index)));
  return { charge_price_cap, price_spread: Math.max(0, discharge_price_floor - charge_price_cap) };
}

export const PLAN_ACTIONS = Object.freeze({ execute: "execute", wait: "wait" });

/**
 * @typedef {object} PlanDecision
 * @property {"execute" | "wait"} action 執行或等待
 * @property {ReturnType<typeof select_best_plan>} executable_plan 以價差標準為每循環最低價差選出的計畫；等待時沒有循環
 * @property {ReturnType<typeof select_best_plan>} best_plan 不設最低價差的最佳組合
 * @property {number | null} best_cycle_spread 等待時，最佳組合中最大的循環價差；沒有獲利組合或執行時為 null
 * @property {number | null} spread_gap 等待時，價差標準 − best_cycle_spread；否則為 null
 * @property {number | null} highest_break_even_spread 顯示的計畫（執行時為可執行計畫，否則為最佳組合）各循環損益兩平價差的最大值
 * @property {boolean} standard_below_break_even 價差標準是否低於 highest_break_even_spread
 */

/**
 * 依價差標準判斷執行或等待（roadmap D4）：每個循環的價差 ≥ 價差標準且整體淨收益 > 0 才執行。
 *
 * 跑兩次選窗：以價差標準為門檻得到可執行計畫，不設門檻得到最佳組合，等待時用來說明差距。
 * 最佳組合的每個循環都是門檻 0 的候選；若其中有循環價差達到標準，它也會是可執行計畫的候選，
 * 所以等待時最佳組合的最大價差一定低於標準，差距為正。
 *
 * @param {number[]} price_values 依時間排序的 30 分鐘電價（AUD/MWh）
 * @param {BatterySpec} battery_spec 電池規格
 * @param {number} spread_standard 價差標準（AUD/MWh），0 以上
 * @returns {PlanDecision} 結論
 * @throws {Error} 價差標準為負或非數值，或 `select_best_plan` 的輸入不合法時
 */
export function decide_plan_action(price_values, battery_spec, spread_standard) {
  if (!Number.isFinite(spread_standard) || spread_standard < 0) {
    throw new Error(`價差標準必須是 0 以上的數值：${spread_standard}`);
  }
  const executable_plan = select_best_plan(price_values, battery_spec, spread_standard);
  const best_plan = select_best_plan(price_values, battery_spec, 0);
  const is_executable = executable_plan.cycles.length > 0 && executable_plan.total_value > 0;
  const shown_cycles = is_executable ? executable_plan.cycles : best_plan.cycles;
  const break_even_spreads = shown_cycles.map((planned_cycle) => break_even_spread(planned_cycle.charge_average_price, battery_spec));
  const highest_break_even_spread = break_even_spreads.length > 0 ? Math.max(...break_even_spreads) : null;
  const cycle_spreads = best_plan.cycles.map((planned_cycle) => planned_cycle.discharge_average_price - planned_cycle.charge_average_price);
  const best_cycle_spread = !is_executable && cycle_spreads.length > 0 ? Math.max(...cycle_spreads) : null;
  return {
    action: is_executable ? PLAN_ACTIONS.execute : PLAN_ACTIONS.wait,
    executable_plan,
    best_plan,
    best_cycle_spread,
    spread_gap: best_cycle_spread === null ? null : spread_standard - best_cycle_spread,
    highest_break_even_spread,
    standard_below_break_even: highest_break_even_spread !== null && spread_standard < highest_break_even_spread,
  };
}
