/**
 * 自訂價格門檻的逐時段充放電模擬（純計算）。
 *
 * 電價高於等於放電下限且有電就放，低於等於充電上限且未滿就充，其餘待機。
 * 來回效率固定 100%、不計損耗。
 */

import { INTERVAL_HOURS } from "./nem_time.js";

const ENERGY_TOLERANCE_MWH = 1e-9;

/**
 * @typedef {object} DispatchBattery
 * @property {number} power_mw 功率（MW）
 * @property {number} capacity_mwh 容量（MWh）
 * @property {number} marginal_loss_factor 損失係數（MLF）
 * @property {number} initial_soc_fraction 起始電量比例（0 到 1）
 */

/**
 * @typedef {object} DispatchResult
 * @property {number} net_value 淨收益（AUD）
 * @property {number} discharge_revenue 放電收入（AUD）
 * @property {number} charge_cost 充電成本（AUD）
 * @property {number} charged_energy_mwh 充電量
 * @property {number} discharged_energy_mwh 放電量
 * @property {number} final_soc_fraction 期末電量比例
 * @property {number[]} interval_energy_mwh 每時段電量變化，正為充、負為放
 */

/**
 * 依門檻逐時段模擬。
 *
 * @param {number[]} price_values 依時間排序的 30 分鐘電價（AUD/MWh）
 * @param {DispatchBattery} battery_spec 電池規格與起始電量
 * @param {{charge_price_cap: number, discharge_price_floor: number}} price_thresholds 充電上限與放電下限
 * @returns {DispatchResult} 模擬結果
 */
export function simulate_threshold_dispatch(price_values, battery_spec, price_thresholds) {
  const maximum_interval_energy = battery_spec.power_mw * INTERVAL_HOURS;
  let stored_energy = battery_spec.initial_soc_fraction * battery_spec.capacity_mwh;
  const totals = { discharge_revenue: 0, charge_cost: 0, charged_energy_mwh: 0, discharged_energy_mwh: 0 };
  const interval_energy_mwh = [];
  for (const price_value of price_values) {
    const energy_change = decide_interval_energy(price_value, stored_energy, battery_spec.capacity_mwh, maximum_interval_energy, price_thresholds);
    const settled_value = Math.abs(energy_change) * price_value * battery_spec.marginal_loss_factor;
    if (energy_change > 0) {
      totals.charge_cost += settled_value;
      totals.charged_energy_mwh += energy_change;
    } else if (energy_change < 0) {
      totals.discharge_revenue += settled_value;
      totals.discharged_energy_mwh -= energy_change;
    }
    stored_energy += energy_change;
    interval_energy_mwh.push(energy_change);
  }
  return {
    ...totals,
    net_value: totals.discharge_revenue - totals.charge_cost,
    final_soc_fraction: stored_energy / battery_spec.capacity_mwh,
    interval_energy_mwh,
  };
}

/**
 * 單一時段的電量變化。
 *
 * @param {number} price_value 本時段電價
 * @param {number} stored_energy 目前電量（MWh）
 * @param {number} capacity_mwh 容量（MWh）
 * @param {number} maximum_interval_energy 一個時段最多充放的電量（MWh）
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
