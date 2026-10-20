/**
 * 連續等待天數（#28、roadmap D4）：記錄每個 NEM 日期的結論，連續多日只有「等待」時提示到情境評估頁檢討價差標準。
 *
 * 純計算，不碰 localStorage；讀寫由 app.js 負責。同一天只要有一次「執行」就記為執行。
 * 只記錄使用者打開頁面的日子，沒有紀錄的日子視為中斷，所以連續天數只會少算、不會多算。
 */

export const WAIT_STREAK_ALERT_DAYS = 3;
export const WAIT_HISTORY_MAX_DAYS = 14;
export const WAIT_HISTORY_STORAGE_KEY = "nem_predispatch_wait_history_v1";

const NEM_OFFSET_MILLISECONDS = 10 * 60 * 60_000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60_000;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PLAN_ACTION_VALUES = Object.freeze(["execute", "wait"]);

/**
 * @typedef {Readonly<Record<string, "execute" | "wait">>} WaitHistory 以 NEM 日期（YYYY-MM-DD）為鍵的每日結論
 */

/**
 * 某個時間點在 NEM 時間（UTC+10）的日期。
 *
 * @param {number} epoch_milliseconds epoch 毫秒
 * @returns {string} YYYY-MM-DD
 */
export function nem_date_for(epoch_milliseconds) {
  return new Date(epoch_milliseconds + NEM_OFFSET_MILLISECONDS).toISOString().slice(0, 10);
}

/**
 * 記下一次結論；同一天已記為執行時不改回等待；只保留最近 14 個日期。
 *
 * @param {WaitHistory} wait_history 目前紀錄
 * @param {string} nem_date NEM 日期（YYYY-MM-DD）
 * @param {"execute" | "wait"} plan_action 這次的結論
 * @returns {WaitHistory} 新的紀錄
 * @throws {Error} 日期格式或動作不合法時
 */
export function record_plan_action(wait_history, nem_date, plan_action) {
  if (!ISO_DATE_PATTERN.test(nem_date)) throw new Error(`NEM 日期必須是 YYYY-MM-DD：${nem_date}`);
  if (!PLAN_ACTION_VALUES.includes(plan_action)) throw new Error(`結論動作必須是 execute 或 wait：${plan_action}`);
  const day_action = wait_history[nem_date] === "execute" ? "execute" : plan_action;
  const kept_dates = Object.keys({ ...wait_history, [nem_date]: day_action }).sort().slice(-WAIT_HISTORY_MAX_DAYS);
  const merged_history = { ...wait_history, [nem_date]: day_action };
  return Object.freeze(Object.fromEntries(kept_dates.map((kept_date) => [kept_date, merged_history[kept_date]])));
}

/**
 * 從指定日期往回數，連續記為等待的天數；當天沒有紀錄時為 0。
 *
 * @param {WaitHistory} wait_history 紀錄
 * @param {string} nem_date 今天的 NEM 日期
 * @returns {number} 連續等待天數
 */
export function count_wait_streak(wait_history, nem_date) {
  let streak_days = 0;
  let checked_milliseconds = Date.parse(`${nem_date}T00:00:00Z`);
  while (wait_history[new Date(checked_milliseconds).toISOString().slice(0, 10)] === "wait") {
    streak_days++;
    checked_milliseconds -= MILLISECONDS_PER_DAY;
  }
  return streak_days;
}

/**
 * 解析 localStorage 裡的紀錄；空白、壞掉的 JSON 或不合法的項目一律忽略，不讓頁面出錯。
 *
 * @param {string | null} stored_text 存放的文字
 * @returns {WaitHistory} 紀錄
 */
export function parse_wait_history(stored_text) {
  if (!stored_text) return Object.freeze({});
  let stored_value;
  try {
    stored_value = JSON.parse(stored_text);
  } catch {
    return Object.freeze({});
  }
  if (typeof stored_value !== "object" || stored_value === null || Array.isArray(stored_value)) return Object.freeze({});
  const valid_entries = Object.entries(stored_value).filter(
    ([stored_date, stored_action]) => ISO_DATE_PATTERN.test(stored_date) && PLAN_ACTION_VALUES.includes(stored_action),
  );
  return Object.freeze(Object.fromEntries(valid_entries));
}

/**
 * 轉成存進 localStorage 的文字。
 *
 * @param {WaitHistory} wait_history 紀錄
 * @returns {string} JSON 文字
 */
export function serialize_wait_history(wait_history) {
  return JSON.stringify(wait_history);
}
