/**
 * 預調度資料的時效判斷（roadmap D1）。AEMO 每 30 分鐘發布一次預調度，但儀表板 API 沒有預調度的執行時間，
 * 所以以本頁最後一次成功取得資料的時間判斷：超過 35 分鐘沒有成功更新，就標示「資料可能過期」。
 */

export const STALE_AFTER_MINUTES = 35;

const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * @typedef {object} DataFreshness
 * @property {boolean} is_stale 距取得時間是否超過 35 分鐘
 * @property {number} elapsed_minutes 距取得時間的整數分鐘（無條件捨去；電腦時間倒退時為 0）
 */

/**
 * 判斷資料是否可能過期。剛好 35 分鐘不算過期，超過才算。
 *
 * @param {number} fetched_at_milliseconds 最後一次成功取得資料的 epoch 毫秒
 * @param {number} now_milliseconds 現在的 epoch 毫秒
 * @returns {DataFreshness} 時效判斷
 * @throws {Error} 任一時間不是有限數字時
 */
export function assess_data_freshness(fetched_at_milliseconds, now_milliseconds) {
  if (!Number.isFinite(fetched_at_milliseconds) || !Number.isFinite(now_milliseconds)) {
    throw new Error("取得時間或現在時間不是有效的數字");
  }
  const elapsed_milliseconds = Math.max(0, now_milliseconds - fetched_at_milliseconds);
  return {
    is_stale: elapsed_milliseconds > STALE_AFTER_MINUTES * MILLISECONDS_PER_MINUTE,
    elapsed_minutes: Math.floor(elapsed_milliseconds / MILLISECONDS_PER_MINUTE),
  };
}

/**
 * 時效說明文字。
 *
 * @param {DataFreshness} data_freshness 時效判斷
 * @param {string} fetched_time_label 取得時間（你的電腦時間），例如 `23:00`
 * @returns {string} 例如「資料取得時間 23:00（你的電腦時間），12 分鐘前」
 */
export function format_data_freshness(data_freshness, fetched_time_label) {
  const { is_stale, elapsed_minutes } = data_freshness;
  if (is_stale) {
    return `資料可能過期：取得時間 ${fetched_time_label}（你的電腦時間），已 ${elapsed_minutes} 分鐘沒有成功更新（超過 ${STALE_AFTER_MINUTES} 分鐘）`;
  }
  const elapsed_text = elapsed_minutes < 1 ? "剛剛" : `${elapsed_minutes} 分鐘前`;
  return `資料取得時間 ${fetched_time_label}（你的電腦時間），${elapsed_text}`;
}
