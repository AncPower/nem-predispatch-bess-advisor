/**
 * NEM 市場時間（AEST，UTC+10，不調整夏令時間）的解析與格式化。
 *
 * 內部一律用「NEM 時間的 epoch 分鐘」表示時段結束時間：把 NEM 時間的年月日時分當成 UTC 換算，
 * 結果不受瀏覽器所在時區影響。
 */

export const INTERVAL_MINUTES = 30;
export const INTERVAL_HOURS = INTERVAL_MINUTES / 60;
export const MINUTES_PER_DAY = 24 * 60;

const MILLISECONDS_PER_MINUTE = 60_000;
const NEM_TIMESTAMP_PATTERN =
  /^(?<year>\d{4})[/-](?<month>\d{2})[/-](?<day>\d{2})[ T](?<hour>\d{2}):(?<minute>\d{2})(?::\d{2})?$/;

/**
 * 把 AEMO 的時間字串轉成 NEM 時間的 epoch 分鐘。
 *
 * @param {string} timestamp_text 例如 `2026-10-19T18:30:00`（儀表板 API）或 `2026/10/19 18:30:00`（MMS CSV）
 * @returns {number} NEM 時間的 epoch 分鐘
 * @throws {Error} 格式不符時，訊息帶原字串
 */
export function parse_nem_timestamp(timestamp_text) {
  const timestamp_match = NEM_TIMESTAMP_PATTERN.exec(String(timestamp_text).trim());
  if (!timestamp_match) throw new Error(`無法解析 NEM 時間「${timestamp_text}」`);
  const time_parts = timestamp_match.groups;
  const epoch_milliseconds = Date.UTC(
    Number(time_parts.year),
    Number(time_parts.month) - 1,
    Number(time_parts.day),
    Number(time_parts.hour),
    Number(time_parts.minute),
  );
  return epoch_milliseconds / MILLISECONDS_PER_MINUTE;
}

/**
 * 把 NEM 時間的 epoch 分鐘格式化成「月/日 時:分」。
 *
 * @param {number} epoch_minute NEM 時間的 epoch 分鐘
 * @returns {string} 例如 `10/19 18:30`
 */
export function format_nem_label(epoch_minute) {
  const nem_date = new Date(epoch_minute * MILLISECONDS_PER_MINUTE);
  const pad_two = (value) => String(value).padStart(2, "0");
  return `${pad_two(nem_date.getUTCMonth() + 1)}/${pad_two(nem_date.getUTCDate())} ${pad_two(nem_date.getUTCHours())}:${pad_two(nem_date.getUTCMinutes())}`;
}

/**
 * 時段結束時間是否為 NEM 日的結束（24:00，也就是次日 00:00）。
 *
 * @param {number} interval_end_minute 時段結束的 epoch 分鐘
 * @returns {boolean} 是否為日結束
 */
export function is_nem_day_end(interval_end_minute) {
  return interval_end_minute % MINUTES_PER_DAY === 0;
}

/**
 * 時段結束時間換成時段開始時間（AEMO 的時間戳記是時段結束）。
 *
 * @param {number} interval_end_minute 時段結束的 epoch 分鐘
 * @returns {number} 時段開始的 epoch 分鐘
 */
export function interval_start_minute(interval_end_minute) {
  return interval_end_minute - INTERVAL_MINUTES;
}
