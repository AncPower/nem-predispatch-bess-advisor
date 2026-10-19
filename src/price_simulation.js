/**
 * 情境工具的每日電價模擬（純計算）。
 *
 * 每日 24 小時電價＝基準價 × 日型態（清晨小峰、午間再生能源凹陷、傍晚尖峰）＋雜訊，
 * 偶發尖峰落在 18 至 21 時，最後夾在價格上下限之間。模擬多條路徑、多天，
 * 並記下每天「最低的連續四小時」與「之後最高的連續四小時」。
 */

import { bell_weight, summarize_day_windows } from "./day_shape.js";
import { BATTERY_DURATION_HOURS } from "./scenario_presets.js";

export const DEFAULT_PATH_COUNT = 400;
export const DEFAULT_RANDOM_SEED = 20261019;

const HOURS_PER_DAY = 24;
const TWO_PI = 2 * Math.PI;
const FLEET_DAMPING = 0.35;
const LEVEL_NOISE = 0.12;
const PRICE_NOISE_SHARE = 0.06;
const TRANSMISSION_SHARE = 0.3;

/**
 * 固定種子的亂數產生器（mulberry32），讓模擬可重現。
 *
 * @param {number} seed_value 種子
 * @returns {() => number} 每次呼叫回傳 [0, 1) 的亂數
 */
export function create_seeded_random(seed_value) {
  let random_state = seed_value >>> 0;
  return () => {
    random_state = (random_state + 0x6d2b79f5) | 0;
    let mixed_value = Math.imul(random_state ^ (random_state >>> 15), 1 | random_state);
    mixed_value = (mixed_value + Math.imul(mixed_value ^ (mixed_value >>> 7), 61 | mixed_value)) ^ mixed_value;
    return ((mixed_value ^ (mixed_value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * 以 Box-Muller 從均勻亂數產生標準常態亂數。
 *
 * @param {() => number} next_random 均勻亂數
 * @returns {() => number} 標準常態亂數
 */
function create_normal_random(next_random) {
  return () => {
    const uniform_first = next_random() || 1e-9;
    const uniform_second = next_random();
    return Math.sqrt(-2 * Math.log(uniform_first)) * Math.cos(TWO_PI * uniform_second);
  };
}

/**
 * @typedef {object} PriceSimulation
 * @property {number} path_count 路徑數
 * @property {number} day_count 天數
 * @property {Float32Array} hourly_prices 依（路徑、天、小時）排列的電價
 * @property {Float32Array} low_average 每（路徑、天）最低四小時均價
 * @property {Int8Array} low_start_hour 最低窗起點
 * @property {Float32Array} high_after_average 最低窗之後的最高四小時均價
 * @property {Int8Array} high_after_start_hour 其起點，沒有時為 −1
 * @property {Float32Array} high_any_average 全日最高四小時均價
 */

/**
 * 模擬多條路徑的每日電價。
 *
 * @param {import("./scenario_presets.js").ScenarioParameters} parameters 情境參數
 * @param {import("./scenario_presets.js").MarketPreset} market_preset 市場預設（型態與燃氣傳導比例）
 * @param {{path_count?: number, random_seed?: number}} [simulation_options] 路徑數與種子
 * @returns {PriceSimulation} 模擬結果
 */
export function simulate_price_paths(parameters, market_preset, simulation_options = {}) {
  const path_count = simulation_options.path_count ?? DEFAULT_PATH_COUNT;
  const day_count = Math.round(parameters.evaluation_days);
  const next_random = create_seeded_random(simulation_options.random_seed ?? DEFAULT_RANDOM_SEED);
  const next_normal = create_normal_random(next_random);
  const simulation = allocate_simulation(path_count, day_count);
  const scenario_factors = derive_scenario_factors(parameters, market_preset);
  const day_prices = new Float32Array(HOURS_PER_DAY);
  for (let path_index = 0; path_index < path_count; path_index++) {
    for (let day_index = 0; day_index < day_count; day_index++) {
      fill_day_prices(day_prices, parameters, market_preset, scenario_factors, { next_random, next_normal });
      const cell_index = path_index * day_count + day_index;
      simulation.hourly_prices.set(day_prices, cell_index * HOURS_PER_DAY);
      store_day_summary(simulation, cell_index, summarize_day_windows(day_prices, BATTERY_DURATION_HOURS));
    }
  }
  return simulation;
}

/**
 * 配置模擬結果的陣列。
 *
 * @param {number} path_count 路徑數
 * @param {number} day_count 天數
 * @returns {PriceSimulation} 空的模擬結果
 */
function allocate_simulation(path_count, day_count) {
  const cell_count = path_count * day_count;
  return {
    path_count, day_count,
    hourly_prices: new Float32Array(cell_count * HOURS_PER_DAY),
    low_average: new Float32Array(cell_count), low_start_hour: new Int8Array(cell_count),
    high_after_average: new Float32Array(cell_count), high_after_start_hour: new Int8Array(cell_count),
    high_any_average: new Float32Array(cell_count),
  };
}

/**
 * 把情境參數換算成模擬用的倍率。
 *
 * @param {import("./scenario_presets.js").ScenarioParameters} parameters 情境參數
 * @param {import("./scenario_presets.js").MarketPreset} market_preset 市場預設
 * @returns {{renewable_factor: number, fleet_factor: number, demand_factor: number, volatility_fraction: number, level_base: number}}
 */
function derive_scenario_factors(parameters, market_preset) {
  const temperature_demand = Math.abs(parameters.temperature_deviation) * parameters.temperature_sensitivity;
  return {
    renewable_factor: 1 + parameters.renewable_change / 100,
    fleet_factor: parameters.fleet_change / 100,
    demand_factor: 1 + (3 * (parameters.demand_change + temperature_demand)) / 100,
    volatility_fraction: parameters.weather_volatility / 100,
    level_base: parameters.base_price
      * (1 + (parameters.gas_change / 100) * market_preset.gas_share)
      * (1 - (TRANSMISSION_SHARE * parameters.wind_change) / 100)
      * (1 + (TRANSMISSION_SHARE * parameters.neighbor_change) / 100),
  };
}

/**
 * 產生一天 24 小時電價，寫入 `day_prices`。
 *
 * @param {Float32Array} day_prices 輸出陣列
 * @param {import("./scenario_presets.js").ScenarioParameters} parameters 情境參數
 * @param {import("./scenario_presets.js").MarketPreset} market_preset 市場預設
 * @param {ReturnType<typeof derive_scenario_factors>} scenario_factors 情境倍率
 * @param {{next_random: () => number, next_normal: () => number}} random_sources 亂數
 */
function fill_day_prices(day_prices, parameters, market_preset, scenario_factors, random_sources) {
  const { next_random, next_normal } = random_sources;
  const volatility_fraction = scenario_factors.volatility_fraction;
  const weather_multiplier = Math.exp(volatility_fraction * next_normal() - (volatility_fraction * volatility_fraction) / 2);
  const fleet_damping = 1 - FLEET_DAMPING * scenario_factors.fleet_factor;
  const solar_dip = market_preset.solar_dip * weather_multiplier * scenario_factors.renewable_factor * fleet_damping;
  const evening_peak = market_preset.evening_peak * scenario_factors.demand_factor * fleet_damping * (0.85 + 0.3 * next_random());
  const price_level = scenario_factors.level_base * Math.exp(LEVEL_NOISE * next_normal() - (LEVEL_NOISE * LEVEL_NOISE) / 2);
  const has_spike = next_random() < parameters.spike_probability / 100;
  const spike_hour = 18 + Math.floor(next_random() * 3);
  const spike_multiplier = 1.5 + 12 * next_random() ** 3;
  for (let hour_value = 0; hour_value < HOURS_PER_DAY; hour_value++) {
    const day_shape = 0.85 + 0.2 * bell_weight(hour_value, 7.5, 1.5) - solar_dip * bell_weight(hour_value, 12.5, 2.6) + evening_peak * bell_weight(hour_value, 19, 1.8);
    let hour_price = price_level * day_shape + parameters.base_price * PRICE_NOISE_SHARE * next_normal();
    if (has_spike && (hour_value === spike_hour || hour_value === spike_hour + 1)) hour_price += price_level * spike_multiplier;
    day_prices[hour_value] = Math.min(parameters.price_cap, Math.max(parameters.price_floor, hour_price));
  }
}

/**
 * 寫入一天的四小時窗摘要。
 *
 * @param {PriceSimulation} simulation 模擬結果
 * @param {number} cell_index（路徑、天）索引
 * @param {ReturnType<typeof summarize_day_windows>} day_summary 摘要
 */
function store_day_summary(simulation, cell_index, day_summary) {
  simulation.low_average[cell_index] = day_summary.low_average;
  simulation.low_start_hour[cell_index] = day_summary.low_start_hour;
  simulation.high_after_average[cell_index] = day_summary.high_after_average;
  simulation.high_after_start_hour[cell_index] = day_summary.high_after_start_hour;
  simulation.high_any_average[cell_index] = day_summary.high_any_average;
}

/**
 * 前幾天各小時電價的 P10、中位數、P90（畫 24 小時圖用）。
 *
 * @param {PriceSimulation} simulation 模擬結果
 * @param {number} day_limit 最多取前幾天
 * @returns {{p10_values: number[], p50_values: number[], p90_values: number[], used_days: number}}
 */
export function summarize_hourly_percentiles(simulation, day_limit) {
  const used_days = Math.min(day_limit, simulation.day_count);
  const percentile_rows = { p10_values: [], p50_values: [], p90_values: [] };
  for (let hour_value = 0; hour_value < HOURS_PER_DAY; hour_value++) {
    const hour_prices = [];
    for (let path_index = 0; path_index < simulation.path_count; path_index++) {
      for (let day_index = 0; day_index < used_days; day_index++) {
        hour_prices.push(simulation.hourly_prices[(path_index * simulation.day_count + day_index) * HOURS_PER_DAY + hour_value]);
      }
    }
    hour_prices.sort((left_price, right_price) => left_price - right_price);
    percentile_rows.p10_values.push(hour_prices[Math.floor(hour_prices.length * 0.1)]);
    percentile_rows.p50_values.push(hour_prices[Math.floor(hour_prices.length * 0.5)]);
    percentile_rows.p90_values.push(hour_prices[Math.floor(hour_prices.length * 0.9)]);
  }
  return { ...percentile_rows, used_days };
}
