"""`analysis.daily_factors` 與 `analysis.battery_fleet` 的測試。"""

from datetime import date, datetime, timedelta

import pytest

from analysis.battery_fleet import BatteryUnitRecord, fleet_power_on, month_end_power_by_date
from analysis.daily_factors import (
    DEMAND_MEAN_FACTOR,
    EVENING_PEAK_DEMAND_FACTOR,
    NET_INTERCHANGE_FACTOR,
    SUPPLY_MARGIN_FACTOR,
    RegionSnapshot,
    interval_start_date,
    summarize_daily_factors,
)

OPEN_ENDED_DATE = date(2999, 12, 31)


def build_day_snapshots(day_start: datetime, evening_demand: float = 9000) -> list[RegionSnapshot]:
    """一天 288 個時段：平時需求 7000，17:00–21:00 為 `evening_demand`；可用發電量固定 10000。"""
    day_snapshots: list[RegionSnapshot] = []
    for interval_index in range(288):
        interval_start = day_start + timedelta(minutes=5 * interval_index)
        is_evening = 17 <= interval_start.hour < 21
        day_snapshots.append(
            RegionSnapshot(
                interval_end=interval_start + timedelta(minutes=5),
                total_demand=evening_demand if is_evening else 7000,
                available_generation=10000,
                net_interchange=-500,
            )
        )
    return day_snapshots


def test_interval_start_date_assigns_midnight_end_to_previous_day() -> None:
    assert interval_start_date(datetime(2024, 1, 2, 0, 0)) == date(2024, 1, 1)


def test_summarize_daily_factors_computes_four_factors() -> None:
    daily_summary = summarize_daily_factors(build_day_snapshots(datetime(2024, 7, 1)))

    day_values = daily_summary.factor_values_by_date[date(2024, 7, 1)]
    assert day_values[EVENING_PEAK_DEMAND_FACTOR] == 9000
    assert day_values[SUPPLY_MARGIN_FACTOR] == 1000
    assert day_values[NET_INTERCHANGE_FACTOR] == -500
    assert day_values[DEMAND_MEAN_FACTOR] == pytest.approx((240 * 7000 + 48 * 9000) / 288)


def test_evening_peak_uses_interval_start_between_17_and_21() -> None:
    day_snapshots = build_day_snapshots(datetime(2024, 7, 1))
    demand_by_start = {"16:55": 9900, "20:55": 9500, "21:00": 9800}
    adjusted_snapshots = [
        RegionSnapshot(
            interval_end=region_snapshot.interval_end,
            total_demand=demand_by_start.get((region_snapshot.interval_end - timedelta(minutes=5)).strftime("%H:%M"), region_snapshot.total_demand),
            available_generation=region_snapshot.available_generation,
            net_interchange=region_snapshot.net_interchange,
        )
        for region_snapshot in day_snapshots
    ]

    daily_summary = summarize_daily_factors(adjusted_snapshots)

    assert daily_summary.factor_values_by_date[date(2024, 7, 1)][EVENING_PEAK_DEMAND_FACTOR] == 9500


def test_summarize_daily_factors_skips_incomplete_day() -> None:
    daily_summary = summarize_daily_factors(build_day_snapshots(datetime(2024, 7, 1))[:-1])

    assert daily_summary.factor_values_by_date == {}
    assert daily_summary.incomplete_dates == [date(2024, 7, 1)]


def test_summarize_daily_factors_returns_empty_for_no_snapshots() -> None:
    daily_summary = summarize_daily_factors([])

    assert daily_summary.factor_values_by_date == {} and daily_summary.incomplete_dates == []


def build_unit_record(duid: str, effective_date: date, max_capacity_mw: float, region_start_date: date) -> BatteryUnitRecord:
    """測試用的機組記錄，儲能量固定為功率兩倍、仍在運轉。"""
    return BatteryUnitRecord(duid, effective_date, max_capacity_mw, max_capacity_mw * 2, region_start_date, OPEN_ENDED_DATE)


def test_fleet_power_on_uses_latest_record_per_unit() -> None:
    unit_records = [
        build_unit_record("UNIT_A", date(2024, 7, 4), 50, date(2024, 7, 4)),
        build_unit_record("UNIT_A", date(2024, 9, 1), 80, date(2024, 7, 4)),
        build_unit_record("UNIT_B", date(2024, 8, 10), 100, date(2024, 8, 10)),
    ]

    assert fleet_power_on(unit_records, date(2024, 8, 31)) == 150
    assert fleet_power_on(unit_records, date(2024, 9, 30)) == 180


def test_fleet_power_on_excludes_unit_after_region_end() -> None:
    retired_unit = BatteryUnitRecord("UNIT_A", date(2024, 7, 4), 50, 100, date(2024, 7, 4), date(2024, 8, 1))

    assert fleet_power_on([retired_unit], date(2024, 8, 31)) == 0


def test_month_end_power_by_date_skips_dates_before_coverage() -> None:
    unit_records = [build_unit_record("UNIT_A", date(2024, 7, 4), 50, date(2024, 7, 4))]

    power_by_date = month_end_power_by_date(unit_records, [date(2024, 6, 30), date(2024, 7, 1), date(2024, 7, 31)])

    assert power_by_date == {date(2024, 7, 1): 50, date(2024, 7, 31): 50}


def test_month_end_power_by_date_rejects_empty_records() -> None:
    with pytest.raises(ValueError, match="空的"):
        month_end_power_by_date([], [date(2024, 7, 1)])
