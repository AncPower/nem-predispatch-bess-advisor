"""NSW 已併網電池的月底裝置量（純計算）。

資料來源與篩選方式見 `docs/data_sources.md` 第 8 項。2024-07 以前的電池以「發電機 ＋ 負載」登記、
不在資料內，這段期間不採計：最早併入 NSW1 的日期（`region_start_date`）所在月份之前的日子不給值。
"""

import calendar
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date

BATTERY_POWER_FACTOR = "battery_power_mw"


@dataclass(frozen=True)
class BatteryUnitRecord:
    """一台電池機組在某個生效日之後的容量。"""

    duid: str
    effective_date: date
    max_capacity_mw: float
    max_storage_capacity_mwh: float
    region_start_date: date
    region_end_date: date


def month_end_of(any_date: date) -> date:
    """該日期所在月份的最後一天。

    Args:
        any_date: 任一日期。

    Returns:
        月底日期。
    """
    return any_date.replace(day=calendar.monthrange(any_date.year, any_date.month)[1])


def fleet_power_on(unit_records: Sequence[BatteryUnitRecord], check_date: date) -> float:
    """某一天仍在運轉的電池放電功率加總（MW）。

    同一機組有多筆時，取生效日不晚於當天的最後一筆。

    Args:
        unit_records: 機組容量記錄。
        check_date: 要計算的日期。

    Returns:
        放電功率加總。
    """
    latest_by_unit: dict[str, BatteryUnitRecord] = {}
    for unit_record in sorted(unit_records, key=lambda unit_entry: unit_entry.effective_date):
        if unit_record.effective_date <= check_date and unit_record.region_start_date <= check_date < unit_record.region_end_date:
            latest_by_unit[unit_record.duid] = unit_record
    return sum(unit_record.max_capacity_mw for unit_record in latest_by_unit.values())


def month_end_power_by_date(unit_records: Sequence[BatteryUnitRecord], target_dates: Iterable[date]) -> dict[date, float]:
    """每一天對應到該月月底的電池放電功率。

    Args:
        unit_records: 機組容量記錄。
        target_dates: 要給值的日期。

    Returns:
        日期對應的月底放電功率；早於資料涵蓋起始月份的日期不在結果內。

    Raises:
        ValueError: 沒有任何機組記錄時。
    """
    if not unit_records:
        raise ValueError("電池機組記錄是空的")
    coverage_start = min(unit_record.region_start_date for unit_record in unit_records).replace(day=1)
    power_by_month_end: dict[date, float] = {}
    power_by_date: dict[date, float] = {}
    for target_date in target_dates:
        if target_date < coverage_start:
            continue
        month_end = month_end_of(target_date)
        if month_end not in power_by_month_end:
            power_by_month_end[month_end] = fleet_power_on(unit_records, month_end)
        power_by_date[target_date] = power_by_month_end[month_end]
    return power_by_date
