/**
 * 特殊事件的純計算（roadmap L3）：類別與影響方向的代碼表、把事件展開成日期、三種檢視篩選。
 *
 * 情境評估頁的事件表、每日收益圖與歷史校準、價差標準檢討（#32）、參考期間推估（#33）共用這裡的規則。
 * 事件只要有一部分時段落在某個交易日，那一天就算事件日；起時、迄時只供顯示。
 */

/** 類別代碼 → 顯示名稱。新增類別要同時更新 `docs/data_sources.md`。 */
export const EVENT_CATEGORY_LABELS = Object.freeze({
  unit_or_network_outage: "機組或輸電事故",
  aemo_market_intervention: "AEMO 市場干預",
  extreme_weather: "極端天氣",
  price_cap_or_cpt: "價格上限或累積價格門檻觸發",
  policy_or_rule_announcement: "政策或規則公告",
  data_anomaly: "資料異常",
});

/** 影響方向代碼 → 顯示名稱。 */
export const IMPACT_DIRECTION_LABELS = Object.freeze({
  raise: "推高",
  lower: "壓低",
  uncertain: "不確定",
});

/** 三種檢視代碼 → 顯示名稱。 */
export const EVENT_VIEWS = Object.freeze({
  include_events: "含事件日",
  exclude_events: "排除事件日",
  only_events: "只看事件日",
});

const MILLISECONDS_PER_DAY = 86_400_000;
const ISO_DATE_LENGTH = 10;

/**
 * 事件涵蓋的每一天，含起日與迄日。
 *
 * @param {{start_date: string, end_date: string}} special_date 事件（日期為 YYYY-MM-DD）
 * @returns {string[]} 依序排列的日期
 * @throws {Error} 日期無法解析或迄日早於起日時
 */
export function list_event_dates(special_date) {
  const start_time = Date.parse(`${special_date.start_date}T00:00:00Z`);
  const end_time = Date.parse(`${special_date.end_date}T00:00:00Z`);
  if (!Number.isFinite(start_time) || !Number.isFinite(end_time) || end_time < start_time) {
    throw new Error(`事件期間不合法：${special_date.start_date} 至 ${special_date.end_date}`);
  }
  const event_dates = [];
  for (let day_time = start_time; day_time <= end_time; day_time += MILLISECONDS_PER_DAY) {
    event_dates.push(new Date(day_time).toISOString().slice(0, ISO_DATE_LENGTH));
  }
  return event_dates;
}

/**
 * 所有事件涵蓋的日期，給三種檢視使用。
 *
 * @param {readonly {start_date: string, end_date: string}[]} special_dates 事件
 * @returns {Set<string>} 日期（YYYY-MM-DD）
 */
export function collect_event_dates(special_dates) {
  return new Set(special_dates.flatMap(list_event_dates));
}

/**
 * 標為「預設排除」的事件涵蓋的日期，給歷史校準使用。
 *
 * @param {readonly {start_date: string, end_date: string, exclude_by_default: boolean}[]} special_dates 事件
 * @returns {Set<string>} 日期（YYYY-MM-DD）
 */
export function collect_excluded_dates(special_dates) {
  return collect_event_dates(special_dates.filter((special_date) => special_date.exclude_by_default));
}

/**
 * 依檢視篩選每日資料；不改動輸入，回傳新陣列。
 *
 * @template {{date: string}} DayRecord
 * @param {readonly DayRecord[]} day_records 每日資料，例如 `data/daily_summary.json` 的 `days`
 * @param {ReadonlySet<string>} event_dates 事件日（`collect_event_dates` 或 `collect_excluded_dates` 的結果）
 * @param {keyof typeof EVENT_VIEWS} view_key 檢視
 * @returns {DayRecord[]} 篩選後的每日資料，順序不變
 * @throws {Error} 檢視代碼不存在時
 */
export function filter_days_by_event_view(day_records, event_dates, view_key) {
  if (!Object.hasOwn(EVENT_VIEWS, view_key)) throw new Error(`未知的事件檢視：${view_key}`);
  if (view_key === "include_events") return [...day_records];
  const keep_event_days = view_key === "only_events";
  return day_records.filter((day_record) => event_dates.has(day_record.date) === keep_event_days);
}

/**
 * 每一天有哪些事件（跨日事件在涵蓋的每一天都會出現），依輸入順序排列。
 *
 * @template {{start_date: string, end_date: string}} SpecialDate
 * @param {readonly SpecialDate[]} special_dates 事件
 * @returns {Map<string, SpecialDate[]>} 日期 → 事件
 */
export function group_events_by_date(special_dates) {
  const events_by_date = new Map();
  for (const special_date of special_dates) {
    for (const event_date of list_event_dates(special_date)) {
      if (!events_by_date.has(event_date)) events_by_date.set(event_date, []);
      events_by_date.get(event_date).push(special_date);
    }
  }
  return events_by_date;
}

/**
 * 每日收益圖的標注：沒有事件為 `none`，有事件為 `event`；當天任一事件標為預設排除時為 `excluded_event`。
 *
 * @param {readonly {date: string, net_value_aud: number | null}[]} day_records 每日資料，例如 `data/daily_summary.json` 的 `days`
 * @param {ReadonlyMap<string, readonly {exclude_by_default: boolean}[]>} events_by_date `group_events_by_date` 的結果
 * @returns {{date: string, net_value_aud: number | null, marker_kind: "none" | "event" | "excluded_event", day_events: readonly object[]}[]} 依輸入順序
 */
export function annotate_days_with_events(day_records, events_by_date) {
  return day_records.map((day_record) => {
    const day_events = events_by_date.get(day_record.date) ?? [];
    let marker_kind = "none";
    if (day_events.length > 0) marker_kind = day_events.some((special_date) => special_date.exclude_by_default) ? "excluded_event" : "event";
    return { date: day_record.date, net_value_aud: day_record.net_value_aud, marker_kind, day_events };
  });
}
