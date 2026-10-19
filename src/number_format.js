/**
 * 數字與金額的顯示格式（純計算）。
 */

/**
 * 數字加千分位。
 *
 * @param {number} numeric_value 數值
 * @param {number} [decimal_places] 小數位數
 * @returns {string} 格式化後的字串
 */
export function format_number(numeric_value, decimal_places = 0) {
  return Number(numeric_value).toLocaleString("zh-TW", { maximumFractionDigits: decimal_places, minimumFractionDigits: decimal_places });
}

/**
 * 金額加幣別，百萬與十億以上換成中文單位，負數以「−」開頭。
 *
 * @param {number} numeric_value 金額
 * @param {string} currency_code 幣別，例如 AUD
 * @returns {string} 例如 `1.23 百萬 AUD`
 */
export function format_money(numeric_value, currency_code) {
  const sign_text = numeric_value < 0 ? "−" : "";
  const absolute_value = Math.abs(numeric_value);
  if (absolute_value >= 1e9) return `${sign_text}${format_number(absolute_value / 1e9, 2)} 十億 ${currency_code}`;
  if (absolute_value >= 1e6) return `${sign_text}${format_number(absolute_value / 1e6, 2)} 百萬 ${currency_code}`;
  return `${sign_text}${format_number(absolute_value)} ${currency_code}`;
}
