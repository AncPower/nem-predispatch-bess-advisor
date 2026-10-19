/**
 * 每日電價型態的共用數學（純計算）：鐘形權重與「連續 N 小時窗」摘要。
 */

/**
 * 以小時為中心的鐘形權重。
 *
 * @param {number} hour_value 小時
 * @param {number} center_hour 中心
 * @param {number} width_hours 寬度
 * @returns {number} 0 到 1 的權重
 */
export function bell_weight(hour_value, center_hour, width_hours) {
  return Math.exp(-(((hour_value - center_hour) / width_hours) ** 2));
}

/**
 * 一天內連續 `window_hours` 小時窗的摘要：最低窗、其後最高窗、全日最高窗。
 * 含 NaN 的窗不會被選為其後最高窗（比較結果為 false）。
 *
 * @param {ArrayLike<number>} day_prices 24 小時電價
 * @param {number} window_hours 窗長（小時）
 * @returns {{low_average: number, low_start_hour: number, high_after_average: number, high_after_start_hour: number, high_any_average: number}}
 *   最低窗之後放不下另一個窗時，`high_after_start_hour` 為 −1、`high_after_average` 為負無限大
 */
export function summarize_day_windows(day_prices, window_hours) {
  const window_start_count = day_prices.length - window_hours + 1;
  const window_averages = Array.from({ length: window_start_count }, (_unused, start_hour) => {
    let window_sum = 0;
    for (let hour_offset = 0; hour_offset < window_hours; hour_offset++) window_sum += day_prices[start_hour + hour_offset];
    return window_sum / window_hours;
  });
  let low_start_hour = 0;
  window_averages.forEach((window_average, start_hour) => { if (window_average < window_averages[low_start_hour]) low_start_hour = start_hour; });
  let high_after_start_hour = -1;
  for (let start_hour = low_start_hour + window_hours; start_hour < window_start_count; start_hour++) {
    if (high_after_start_hour < 0 ? window_averages[start_hour] > Number.NEGATIVE_INFINITY : window_averages[start_hour] > window_averages[high_after_start_hour]) {
      high_after_start_hour = start_hour;
    }
  }
  return {
    low_average: window_averages[low_start_hour],
    low_start_hour,
    high_after_average: high_after_start_hour >= 0 ? window_averages[high_after_start_hour] : Number.NEGATIVE_INFINITY,
    high_after_start_hour,
    high_any_average: Math.max(...window_averages),
  };
}
