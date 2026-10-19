"""由 5 分鐘區域資料彙整每日因素（純計算）。

一天是 NEM 時間 00:00 到 24:00，以時段開始時間判斷；AEMO 的時間戳記是時段結束，所以先減 5 分鐘。
"""

import statistics
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

FIVE_MINUTE_INTERVAL = timedelta(minutes=5)
FIVE_MINUTE_INTERVALS_PER_DAY = 288
EVENING_PEAK_START = time(17, 0)
EVENING_PEAK_END = time(21, 0)

DEMAND_MEAN_FACTOR = "demand_mean_mw"
EVENING_PEAK_DEMAND_FACTOR = "evening_peak_demand_mw"
SUPPLY_MARGIN_FACTOR = "supply_margin_minimum_mw"
NET_INTERCHANGE_FACTOR = "net_interchange_mean_mw"


@dataclass(frozen=True)
class RegionSnapshot:
    """NSW1 某個 5 分鐘時段的區域狀態（MW）。`interval_end` 為 AEMO 的時段結束時間。"""

    interval_end: datetime
    total_demand: float
    available_generation: float
    net_interchange: float


@dataclass(frozen=True)
class DailyFactorSummary:
    """每日因素值，以及因時段不足 288 個而略過的日子。"""

    factor_values_by_date: dict[date, dict[str, float]]
    incomplete_dates: list[date]


def interval_start_date(interval_end: datetime) -> date:
    """時段結束時間所屬的日子（以時段開始時間判斷）。

    Args:
        interval_end: AEMO 的時段結束時間。

    Returns:
        時段開始時間的日期。
    """
    return (interval_end - FIVE_MINUTE_INTERVAL).date()


def summarize_daily_factors(region_snapshots: Iterable[RegionSnapshot]) -> DailyFactorSummary:
    """把每個時段的區域狀態彙整成每日四個因素。

    Args:
        region_snapshots: 不重複的時段狀態，順序不拘。

    Returns:
        完整日子的因素值；時段不足的日子列在 `incomplete_dates`。
    """
    snapshots_by_date: dict[date, list[RegionSnapshot]] = defaultdict(list)
    for region_snapshot in region_snapshots:
        snapshots_by_date[interval_start_date(region_snapshot.interval_end)].append(region_snapshot)
    factor_values_by_date: dict[date, dict[str, float]] = {}
    incomplete_dates: list[date] = []
    for snapshot_date in sorted(snapshots_by_date):
        day_snapshots = snapshots_by_date[snapshot_date]
        if len(day_snapshots) != FIVE_MINUTE_INTERVALS_PER_DAY:
            incomplete_dates.append(snapshot_date)
            continue
        factor_values_by_date[snapshot_date] = summarize_one_day(day_snapshots)
    return DailyFactorSummary(factor_values_by_date=factor_values_by_date, incomplete_dates=incomplete_dates)


def summarize_one_day(day_snapshots: list[RegionSnapshot]) -> dict[str, float]:
    """一天 288 個時段的四個因素。

    Args:
        day_snapshots: 同一天的全部時段狀態。

    Returns:
        因素名稱對應的值（MW）。
    """
    evening_demands = [
        region_snapshot.total_demand
        for region_snapshot in day_snapshots
        if EVENING_PEAK_START <= (region_snapshot.interval_end - FIVE_MINUTE_INTERVAL).time() < EVENING_PEAK_END
    ]
    return {
        DEMAND_MEAN_FACTOR: statistics.fmean(region_snapshot.total_demand for region_snapshot in day_snapshots),
        EVENING_PEAK_DEMAND_FACTOR: max(evening_demands),
        SUPPLY_MARGIN_FACTOR: min(region_snapshot.available_generation - region_snapshot.total_demand for region_snapshot in day_snapshots),
        NET_INTERCHANGE_FACTOR: statistics.fmean(region_snapshot.net_interchange for region_snapshot in day_snapshots),
    }
