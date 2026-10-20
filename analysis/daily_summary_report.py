"""組出 `data/daily_summary.json` 的內容（純計算，不寫檔；#30、roadmap L1）。

- 期間：從 `SUMMARY_START_DATE`（與 `data/factor_weights.json` 的擬合期間同一天起算）到最後一個完整交易日；
  期間內每一天都列出，資料不完整或完全沒有資料的日子標為排除並寫明原因，不補值。
- 每天的計畫依 D2、D3 的規則（`select_best_plan`，從空電池開始、不跨午夜、計入效率與損耗），
  每循環最低價差為 0；價差標準由情境評估頁（#32）拿各循環的價差自行比較。
- 價差＝放電段均價 − 充電段均價（AUD/MWh），與 README「價差標準」的定義相同，不含效率與 MLF。
- `best_spread_aud_per_mwh` 取當天各循環價差的最小值：#32 的執行條件是「每個循環 ≥ 標準」，
  最小的那個循環決定能不能執行。沒有任何循環時為 null。
"""

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta

from analysis.arbitrage_plan import ArbitragePlan, BatterySpecification, PlannedCycle
from analysis.daily_revenue import DailyPlanResult
from analysis.factor_weights_report import build_fingerprint_section, format_utc_timestamp
from analysis.input_fingerprint import RawFileEntry, SourceFingerprint
from analysis.nem_day import FIVE_MINUTE_INTERVALS_PER_DAY, HALF_HOUR_INTERVAL, list_calendar_dates

SCHEMA_VERSION: int = 1
SUMMARY_START_DATE: date = date(2024, 7, 1)
NEM_MINUTE_FORMAT: str = "%Y-%m-%dT%H:%M"
MISSING_PRICE_REASON: str = "沒有電價資料"
INCOMPLETE_HALF_HOUR_REASON: str = "30 分鐘電價不足 48 段"


@dataclass(frozen=True)
class SummarySources:
    """組每日摘要用的計算結果。"""

    region_id: str
    daily_plans: DailyPlanResult
    five_minute_counts: Mapping[date, int]


@dataclass(frozen=True)
class SummaryMetadata:
    """不來自資料的輸出欄位。"""

    generated_at: datetime
    battery_specification: BatterySpecification


def find_exclusion_reason(trading_date: date, summary_sources: SummarySources) -> str:
    """某個沒有計畫的交易日為什麼被排除。

    Args:
        trading_date: 交易日，必須不在 `plans_by_date` 裡。
        summary_sources: 計算結果。

    Returns:
        排除原因。
    """
    price_count = summary_sources.five_minute_counts.get(trading_date, 0)
    if price_count == 0:
        return MISSING_PRICE_REASON
    if price_count < FIVE_MINUTE_INTERVALS_PER_DAY:
        return f"5 分鐘電價只有 {price_count} 筆（應為 {FIVE_MINUTE_INTERVALS_PER_DAY} 筆）"
    return INCOMPLETE_HALF_HOUR_REASON


def format_interval_start(trading_date: date, half_hour_index: int) -> str:
    """第幾個 30 分鐘時段的開始時間（NEM 時間，不帶時區）。

    Args:
        trading_date: 交易日。
        half_hour_index: 當天從 0 起算的 30 分鐘時段序號。

    Returns:
        例如 `2025-04-10T04:00`。
    """
    day_start = datetime.combine(trading_date, datetime.min.time())
    return (day_start + half_hour_index * HALF_HOUR_INTERVAL).strftime(NEM_MINUTE_FORMAT)


def build_cycle_entry(trading_date: date, planned_cycle: PlannedCycle) -> dict[str, object]:
    """一個循環的輸出。

    Args:
        trading_date: 交易日。
        planned_cycle: 選中的循環。

    Returns:
        充放電開始時間、兩段均價、價差與淨收益。
    """
    return {
        "charge_start": format_interval_start(trading_date, planned_cycle.charge_start_index),
        "discharge_start": format_interval_start(trading_date, planned_cycle.discharge_start_index),
        "charge_average_price_aud_per_mwh": planned_cycle.charge_average_price,
        "discharge_average_price_aud_per_mwh": planned_cycle.discharge_average_price,
        "spread_aud_per_mwh": planned_cycle.discharge_average_price - planned_cycle.charge_average_price,
        "net_value_aud": planned_cycle.net_value,
    }


def build_included_day(trading_date: date, daily_plan: ArbitragePlan) -> dict[str, object]:
    """有完整資料的一天；沒有任何符合條件的組合時淨收益為 0、`cycles` 為空。

    Args:
        trading_date: 交易日。
        daily_plan: 當天最佳計畫。

    Returns:
        一天的輸出。
    """
    cycle_entries = [build_cycle_entry(trading_date, planned_cycle) for planned_cycle in daily_plan.cycles]
    cycle_spreads = [cycle_entry["spread_aud_per_mwh"] for cycle_entry in cycle_entries]
    return {
        "date": trading_date.isoformat(),
        "excluded": False,
        "exclusion_reason": None,
        "net_value_aud": daily_plan.total_value,
        "best_spread_aud_per_mwh": min(cycle_spreads) if cycle_spreads else None,
        "cycles": cycle_entries,
    }


def build_excluded_day(trading_date: date, exclusion_reason: str) -> dict[str, object]:
    """被排除的一天。

    Args:
        trading_date: 交易日。
        exclusion_reason: 排除原因。

    Returns:
        一天的輸出，數值欄位為 null。
    """
    return {
        "date": trading_date.isoformat(),
        "excluded": True,
        "exclusion_reason": exclusion_reason,
        "net_value_aud": None,
        "best_spread_aud_per_mwh": None,
        "cycles": [],
    }


def build_day_entries(summary_sources: SummarySources, start_date: date) -> list[dict[str, object]]:
    """期間內每一天的輸出。

    Args:
        summary_sources: 計算結果。
        start_date: 期間第一天。

    Returns:
        依日期排序的每日輸出。

    Raises:
        ValueError: 期間第一天之後沒有任何完整交易日時。
    """
    plans_by_date = summary_sources.daily_plans.plans_by_date
    included_dates = [trading_date for trading_date in plans_by_date if trading_date >= start_date]
    if not included_dates:
        raise ValueError(f"{start_date.isoformat()} 之後沒有任何完整交易日的電價")
    return [
        build_included_day(period_date, plans_by_date[period_date])
        if period_date in plans_by_date
        else build_excluded_day(period_date, find_exclusion_reason(period_date, summary_sources))
        for period_date in list_calendar_dates(start_date, max(included_dates))
    ]


def build_period_section(day_entries: Sequence[dict[str, object]]) -> dict[str, object]:
    """期間區段。

    Args:
        day_entries: 每日輸出。

    Returns:
        起訖日與天數。
    """
    excluded_count = sum(1 for day_entry in day_entries if day_entry["excluded"])
    return {
        "start_date": day_entries[0]["date"],
        "end_date": day_entries[-1]["date"],
        "day_count": len(day_entries),
        "included_day_count": len(day_entries) - excluded_count,
        "excluded_day_count": excluded_count,
    }


def build_summary_document(
    summary_sources: SummarySources,
    source_fingerprint: SourceFingerprint,
    raw_manifest: Sequence[RawFileEntry],
    summary_metadata: SummaryMetadata,
    start_date: date = SUMMARY_START_DATE,
) -> dict[str, object]:
    """組出完整的 JSON 文件內容。

    Args:
        summary_sources: 計算結果。
        source_fingerprint: 程式與設定檔的指紋。
        raw_manifest: 原始資料檔清單。
        summary_metadata: 產生時間與電池規格。
        start_date: 期間第一天，預設 `SUMMARY_START_DATE`。

    Returns:
        可直接 `json.dump` 的字典。

    Raises:
        ValueError: 期間內沒有任何完整交易日，或產生時間沒有時區時。
    """
    day_entries = build_day_entries(summary_sources, start_date)
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": format_utc_timestamp(summary_metadata.generated_at),
        "region_id": summary_sources.region_id,
        "period": build_period_section(day_entries),
        "battery_specification": asdict(summary_metadata.battery_specification),
        "days": day_entries,
        "input_fingerprint": build_fingerprint_section(source_fingerprint, raw_manifest),
    }
