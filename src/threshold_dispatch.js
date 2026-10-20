/**
 * 自訂價格門檻的逐時段充放電模擬（純計算）。
 *
 * 電價高於等於放電下限且有電就放，低於等於充電上限且未滿就充，其餘待機。
 *
 * 效率與損耗與 `select_best_plan` 相同（#47）：充電量即存入電池的電量；放電時從電池取出的量受功率限制，
 * 入網放電量＝取出量 × 來回效率；每 MWh 入網放電扣損耗成本；充放電結算都乘 MLF。
 * 淨收益＝放電量 × 電價 × MLF − 充電量 × 電價 × MLF − 放電量 × 每 MWh 損耗成本。
 * 來回效率 1、損耗 0 時與只看價差完全相同。
 */

import { INTERVAL_HOURS, is_nem_day_end } from "./nem_time.js";

const ENERGY_TOLERANCE_MWH = 1e-9;

/**
 * @typedef {object} DispatchBattery
 * @property {number} power_mw 功率（MW）
 * @property {number} capacity_mwh 容量（MWh）
 * @property {number} marginal_loss_factor 損失係數（MLF）
 * @property {number} round_trip_efficiency 來回效率，大於 0 且不超過 1
 * @property {number} degradation_cost_aud_per_mwh 每 MWh 放電的損耗成本（AUD），0 以上
 * @property {number} initial_soc_fraction 起始電量比例（0 到 1）
 */

/**
 * @typedef {object} DispatchResult
 * @property {number} net_value 淨收益（AUD），已扣除效率損失與損耗成本
 * @property {number} discharge_revenue 放電收入（AUD）
 * @property {number} charge_cost 充電成本（AUD）
 * @property {number} degradation_cost 損耗成本（AUD）
 * @property {number} charged_energy_mwh 充電量（存入電池）
 * @property {number} discharged_energy_mwh 放電量（入網，已扣效率損失）
 * @property {number} final_soc_fraction 期末電量比例
 * @property {number[]} interval_energy_mwh 每時段電池內電量變化，正為充、負為放
 * @property {number[]} stored_energy_mwh 每時段結束時電池內的電量（MWh）
 */

/**
 * 依門檻逐時段模擬。
 *
 * @param {number[]} price_values 依時間排序的 30 分鐘電價（AUD/MWh）
 * @param {DispatchBattery} battery_spec 電池規格與起始電量
 * @param {{charge_price_cap: number, discharge_price_floor: number}} price_thresholds 充電上限與放電下限
 * @returns {DispatchResult} 模擬結果
 * @throws {Error} 來回效率或損耗成本不合法時
 */
export function simulate_threshold_dispatch(price_values, battery_spec, price_thresholds) {
  validate_dispatch_costs(battery_spec);
  const maximum_interval_energy = battery_spec.power_mw * INTERVAL_HOURS;
  let stored_energy = battery_spec.initial_soc_fraction * battery_spec.capacity_mwh;
  const totals = { discharge_revenue: 0, charge_cost: 0, degradation_cost: 0, charged_energy_mwh: 0, discharged_energy_mwh: 0 };
  const interval_energy_mwh = [];
  const stored_energy_mwh = [];
  for (const price_value of price_values) {
    const energy_change = decide_interval_energy(price_value, stored_energy, battery_spec.capacity_mwh, maximum_interval_energy, price_thresholds);
    if (energy_change > 0) {
      totals.charge_cost += energy_change * price_value * battery_spec.marginal_loss_factor;
      totals.charged_energy_mwh += energy_change;
    } else if (energy_change < 0) {
      const delivered_energy = -energy_change * battery_spec.round_trip_efficiency;
      totals.discharge_revenue += delivered_energy * price_value * battery_spec.marginal_loss_factor;
      totals.degradation_cost += delivered_energy * battery_spec.degradation_cost_aud_per_mwh;
      totals.discharged_energy_mwh += delivered_energy;
    }
    stored_energy += energy_change;
    interval_energy_mwh.push(energy_change);
    stored_energy_mwh.push(stored_energy);
  }
  return {
    ...totals,
    net_value: totals.discharge_revenue - totals.charge_cost - totals.degradation_cost,
    final_soc_fraction: stored_energy / battery_spec.capacity_mwh,
    interval_energy_mwh,
    stored_energy_mwh,
  };
}

/**
 * 檢查來回效率與損耗成本；規則與 `window_selection.js` 相同（同為 L1，不能互相匯入）。
 *
 * @param {DispatchBattery} battery_spec 電池規格
 * @throws {Error} 來回效率不在 (0, 1]，或損耗成本為負或非數值時
 */
function validate_dispatch_costs(battery_spec) {
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
 * @typedef {object} RemainingEnergyMarker
 * @property {number} interval_index 標示在哪個時段的結束
 * @property {"day_end" | "horizon_end"} marker_kind 當日結束或預測期結束
 * @property {number} stored_energy_mwh 剩餘電量（MWh）
 * @property {number} stored_fraction 剩餘電量占容量的比例
 */

/**
 * 找出要在圖上標示剩餘電量的時間點：每個 NEM 日結束（24:00）與預測期最後一個時段，且電池內仍有電。
 *
 * @param {{interval_end_minute: number}[]} price_points 依時間排序的時段
 * @param {number[]} stored_energy_mwh 每時段結束時的電量（與 price_points 等長）
 * @param {number} capacity_mwh 容量（MWh）
 * @returns {RemainingEnergyMarker[]} 依時間排序的標示點
 */
export function find_remaining_energy_markers(price_points, stored_energy_mwh, capacity_mwh) {
  const last_index = price_points.length - 1;
  const remaining_markers = [];
  price_points.forEach((price_point, interval_index) => {
    const is_day_end = is_nem_day_end(price_point.interval_end_minute);
    if (!is_day_end && interval_index !== last_index) return;
    const stored_energy = stored_energy_mwh[interval_index];
    if (stored_energy <= ENERGY_TOLERANCE_MWH) return;
    remaining_markers.push({
      interval_index,
      marker_kind: interval_index === last_index ? "horizon_end" : "day_end",
      stored_energy_mwh: stored_energy,
      stored_fraction: stored_energy / capacity_mwh,
    });
  });
  return remaining_markers;
}

/**
 * 單一時段的電池內電量變化。
 *
 * @param {number} price_value 本時段電價
 * @param {number} stored_energy 目前電量（MWh）
 * @param {number} capacity_mwh 容量（MWh）
 * @param {number} maximum_interval_energy 一個時段最多充入或取出的電量（MWh）
 * @param {{charge_price_cap: number, discharge_price_floor: number}} price_thresholds 門檻
 * @returns {number} 正為充、負為放、0 為待機
 */
function decide_interval_energy(price_value, stored_energy, capacity_mwh, maximum_interval_energy, price_thresholds) {
  if (price_value >= price_thresholds.discharge_price_floor && stored_energy > ENERGY_TOLERANCE_MWH) {
    return -Math.min(maximum_interval_energy, stored_energy);
  }
  if (price_value <= price_thresholds.charge_price_cap && stored_energy < capacity_mwh - ENERGY_TOLERANCE_MWH) {
    return Math.min(maximum_interval_energy, capacity_mwh - stored_energy);
  }
  return 0;
}
