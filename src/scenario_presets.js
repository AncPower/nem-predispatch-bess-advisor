/**
 * 情境工具的市場預設值、新聞事件調整與輸入欄位定義（純資料，不做計算）。
 *
 * 市場預設值是依公開報導整理的示意價格型態，不是即時市場數據。
 */

export const BATTERY_DURATION_HOURS = 4;

/**
 * @typedef {object} MarketPreset
 * @property {string} market_name 顯示名稱
 * @property {string} currency_code 幣別
 * @property {number} base_price 基準平均電價（幣別/MWh）
 * @property {number} solar_dip 午間再生能源凹陷深度（相對基準價）
 * @property {number} evening_peak 傍晚尖峰高度（相對基準價）
 * @property {number} gas_share 燃氣價格傳導到電價的比例
 * @property {number} spike_probability 每日價格尖峰機率（%）
 * @property {number} price_cap 價格上限
 * @property {number} price_floor 價格下限
 * @property {number} spread_standard 預設價差標準（幣別/MWh）
 * @property {number} [weather_volatility] 天氣波動度（%），歷史校準才會有
 * @property {string} market_note 市場說明
 */

/** @type {Readonly<Record<string, MarketPreset>>} */
export const MARKET_PRESETS = Object.freeze({
  nsw: { market_name: "澳洲 NSW", currency_code: "AUD", base_price: 85, solar_dip: 0.8, evening_peak: 0.4, gas_share: 0.5, spike_probability: 4, price_cap: 23200, price_floor: -1000, spread_standard: 80,
    market_note: "5 分鐘結算，午間太陽能常壓出負電價，傍晚尖峰由電池與燃氣定價，偶有極端尖峰。" },
  de: { market_name: "德國", currency_code: "EUR", base_price: 90, solar_dip: 0.6, evening_peak: 0.45, gas_share: 0.6, spike_probability: 1.5, price_cap: 4000, price_floor: -500, spread_standard: 70,
    market_note: "日前市場以小時（逐步改為 15 分鐘）競價，夏季午間負電價頻繁，傍晚約 20 時出現高峰。" },
  gb: { market_name: "英國", currency_code: "GBP", base_price: 85, solar_dip: 0.25, evening_peak: 0.45, gas_share: 0.85, spike_probability: 2, price_cap: 4000, price_floor: -500, spread_standard: 45,
    market_note: "風電主導價差，燃氣價格影響大；電池同時參與批發市場與平衡機制。" },
  ercot: { market_name: "美國德州 ERCOT", currency_code: "USD", base_price: 40, solar_dip: 0.35, evening_peak: 0.4, gas_share: 0.6, spike_probability: 3, price_cap: 5000, price_floor: -250, spread_standard: 25,
    market_note: "純能源市場、無容量市場，收益高度依賴少數稀缺尖峰日。" },
  caiso: { market_name: "美國加州 CAISO", currency_code: "USD", base_price: 50, solar_dip: 0.7, evening_peak: 0.5, gas_share: 0.6, spike_probability: 1, price_cap: 2000, price_floor: -150, spread_standard: 45,
    market_note: "典型鴨子曲線，電池收益九成來自套利，另有雙邊容量（資源充足）合約。" },
  jp: { market_name: "日本 JEPX（九州）", currency_code: "JPY", base_price: 11000, solar_dip: 0.55, evening_peak: 0.3, gas_share: 0.5, spike_probability: 1.5, price_cap: 200000, price_floor: 10, spread_standard: 6000,
    market_note: "價格以日圓／MWh 表示；JEPX 最低價為每 kWh 0.01 日圓，沒有負電價，九州太陽能午間價差明顯。" },
  sg: { market_name: "新加坡", currency_code: "SGD", base_price: 200, solar_dip: 0.1, evening_peak: 0.25, gas_share: 0.95, spike_probability: 2, price_cap: 4500, price_floor: 0, spread_standard: 45,
    market_note: "半小時結算的 USEP，幾乎全由進口天然氣發電，價差主要來自燃料價格與需求起伏。" },
});

/**
 * @typedef {object} ScenarioParameters
 * @property {number} base_price 基準平均電價
 * @property {number} gas_change 天然氣價格變動（%）
 * @property {number} demand_change 用電需求變動（%）
 * @property {number} renewable_change 再生能源出力變動（%）
 * @property {number} fleet_change 新增電池容量變動（%）
 * @property {number} weather_volatility 天氣波動度（%）
 * @property {number} spike_probability 每日價格尖峰機率（%）
 * @property {number} price_cap 價格上限
 * @property {number} price_floor 價格下限
 * @property {number} temperature_deviation 氣溫偏離常態（°C）
 * @property {number} temperature_sensitivity 每偏離 1°C 需求變化（%）
 * @property {number} wind_change 風力出力變動（%）
 * @property {number} neighbor_change 鄰近區域電價變動（%）
 * @property {number} spread_standard 價差標準（幣別/MWh）
 * @property {number} power_mw 放電功率（MW）
 * @property {number} maximum_wait_days 最長等待天數
 * @property {number} evaluation_days 評估期間（天）
 */

const DEFAULT_WEATHER_VOLATILITY = 25;
const DEFAULT_POWER_MW = 5;

/**
 * 市場預設值對應的初始參數。
 *
 * @param {MarketPreset} market_preset 市場預設
 * @returns {ScenarioParameters} 初始參數
 */
export function default_parameters(market_preset) {
  return {
    base_price: market_preset.base_price, gas_change: 0, demand_change: 0, renewable_change: 0, fleet_change: 0,
    weather_volatility: market_preset.weather_volatility ?? DEFAULT_WEATHER_VOLATILITY,
    spike_probability: market_preset.spike_probability, price_cap: market_preset.price_cap, price_floor: market_preset.price_floor,
    temperature_deviation: 0, temperature_sensitivity: 2, wind_change: 0, neighbor_change: 0,
    spread_standard: market_preset.spread_standard, power_mw: DEFAULT_POWER_MW, maximum_wait_days: 3, evaluation_days: 30,
  };
}

/**
 * @typedef {{parameter_key: string, label_text: string, unit_text: string, minimum_value: number, maximum_value: number, step_value: number}} FieldDefinition
 */

/**
 * 三組滑桿欄位：市場情境因子、天氣與相關市場、設備與策略。
 *
 * @param {MarketPreset} market_preset 市場預設，決定基準價與價差標準的範圍
 * @returns {{scenario_fields: FieldDefinition[], weather_fields: FieldDefinition[], strategy_fields: FieldDefinition[]}}
 */
export function build_field_definitions(market_preset) {
  const is_large_unit = market_preset.base_price > 1000;
  const price_unit = `${market_preset.currency_code}/MWh`;
  const field = (parameter_key, label_text, unit_text, minimum_value, maximum_value, step_value) =>
    ({ parameter_key, label_text, unit_text, minimum_value, maximum_value, step_value });
  return {
    scenario_fields: [
      field("base_price", "基準平均電價", price_unit, 0, Math.round(market_preset.base_price * 3), is_large_unit ? 100 : 1),
      field("gas_change", "燃料（天然氣）價格變動", "%", -50, 150, 1),
      field("demand_change", "用電需求變動", "%", -20, 30, 1),
      field("renewable_change", "再生能源出力變動", "%", -60, 80, 1),
      field("fleet_change", "新增電池容量變動", "%", 0, 150, 1),
      field("weather_volatility", "天氣波動度", "%", 5, 60, 1),
      field("spike_probability", "每日價格尖峰機率", "%", 0, 30, 0.5),
    ],
    weather_fields: [
      field("temperature_deviation", "氣溫偏離常態", "°C", -12, 12, 0.5),
      field("temperature_sensitivity", "每偏離 1°C 需求變化", "%", 0, 6, 0.5),
      field("wind_change", "風力出力變動", "%", -60, 80, 1),
      field("neighbor_change", "鄰近區域電價變動", "%", -50, 100, 1),
    ],
    strategy_fields: [
      field("spread_standard", "價差標準（高價段 − 低價段）", price_unit, 0, Math.round(market_preset.base_price * 2.5), is_large_unit ? 50 : 1),
      field("power_mw", `放電功率（${BATTERY_DURATION_HOURS} 小時電池）`, "MW", 1, 1000, 1),
      field("maximum_wait_days", "最長等待天數", "天", 1, 10, 1),
      field("evaluation_days", "評估期間", "天", 7, 90, 1),
    ],
  };
}

/**
 * @typedef {{label_text: string, log_text: string, apply_adjustment: (parameters: ScenarioParameters) => void}} NewsAdjustment
 */

/** @type {readonly NewsAdjustment[]} */
export const NEWS_ADJUSTMENTS = Object.freeze([
  { label_text: "天然氣價格上漲 15%", log_text: "天然氣 +15%", apply_adjustment: (parameters) => { parameters.gas_change += 15; } },
  { label_text: "天然氣價格下跌 15%", log_text: "天然氣 −15%", apply_adjustment: (parameters) => { parameters.gas_change -= 15; } },
  { label_text: "熱浪或寒流", log_text: "需求 +8%、尖峰機率 +3 個百分點", apply_adjustment: (parameters) => { parameters.demand_change += 8; parameters.spike_probability += 3; } },
  { label_text: "氣溫偏離常態 4°C", log_text: "氣溫偏離 +4°C", apply_adjustment: (parameters) => { parameters.temperature_deviation += 4; } },
  { label_text: "鄰近區域電價上漲 20%", log_text: "鄰近區域電價 +20%", apply_adjustment: (parameters) => { parameters.neighbor_change += 20; } },
  { label_text: "風光發電強勁", log_text: "再生能源出力 +20%", apply_adjustment: (parameters) => { parameters.renewable_change += 20; } },
  { label_text: "風光發電疲弱", log_text: "再生能源出力 −20%、尖峰機率 +1 個百分點", apply_adjustment: (parameters) => { parameters.renewable_change -= 20; parameters.spike_probability += 1; } },
  { label_text: "大量新電池併網", log_text: "新增電池容量 +20%", apply_adjustment: (parameters) => { parameters.fleet_change += 20; } },
  { label_text: "價格上限下修", log_text: "價格上限 × 0.7", apply_adjustment: (parameters) => { parameters.price_cap = Math.round(parameters.price_cap * 0.7); } },
]);

/**
 * 套用新聞事件後，把參數拉回各欄位的上下限。
 *
 * @param {ScenarioParameters} parameters 參數（就地修改）
 * @param {MarketPreset} market_preset 市場預設，用來取得欄位範圍
 */
export function clamp_to_field_limits(parameters, market_preset) {
  const field_groups = build_field_definitions(market_preset);
  for (const field_definition of [...field_groups.scenario_fields, ...field_groups.weather_fields, ...field_groups.strategy_fields]) {
    const current_value = parameters[field_definition.parameter_key];
    parameters[field_definition.parameter_key] = Math.min(field_definition.maximum_value, Math.max(field_definition.minimum_value, current_value));
  }
}
