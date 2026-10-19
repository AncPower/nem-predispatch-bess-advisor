"""`analysis.region_factors` 的單元測試。"""

from datetime import date, datetime, timedelta

import pytest

from analysis.mms_csv import MmsRecord
from analysis.nem_day import FIVE_MINUTE_INTERVAL, FIVE_MINUTE_INTERVALS_PER_DAY
from analysis.region_factors import (
    RegionSnapshot,
    collect_region_snapshots,
    compute_region_day_factors,
)

FIRST_DAY_START = datetime(2025, 4, 10)


def build_region_record(
    run_end: datetime,
    interval_end: datetime | None = None,
    total_demand: str = "7000",
    available_generation: str = "10000",
    net_interchange: str = "-500",
    extra_fields: dict[str, str] | None = None,
    record_location: str = "測試檔 第 2 行",
) -> MmsRecord:
    """組一筆 P5MIN.REGIONSOLUTION 資料列。"""
    timestamp_format = "%Y/%m/%d %H:%M:%S"
    field_values = {
        "RUN_DATETIME": run_end.strftime(timestamp_format),
        "INTERVAL_DATETIME": (interval_end or run_end).strftime(timestamp_format),
        "REGIONID": "NSW1",
        "TOTALDEMAND": total_demand,
        "AVAILABLEGENERATION": available_generation,
        "NETINTERCHANGE": net_interchange,
        **(extra_fields or {}),
    }
    return MmsRecord(field_values, record_location)


def build_full_day(day_start: datetime, demand_for_step: dict[int, float] | None = None) -> dict[datetime, RegionSnapshot]:
    """組一整天 288 個 5 分鐘快照；`demand_for_step` 指定某幾個時段（1 起算）的需求，其餘為 7000。"""
    demand_overrides = demand_for_step or {}
    return {
        day_start + step_index * FIVE_MINUTE_INTERVAL: RegionSnapshot(
            total_demand_mw=demand_overrides.get(step_index, 7000.0),
            available_generation_mw=10000.0,
            net_interchange_mw=-500.0,
        )
        for step_index in range(1, FIVE_MINUTE_INTERVALS_PER_DAY + 1)
    }


def test_collect_region_snapshots_keeps_only_first_interval_of_each_run() -> None:
    """每次求解有多個時段：只留時段等於求解時間的第一個時段。"""
    run_end = FIRST_DAY_START + FIVE_MINUTE_INTERVAL
    region_records = [
        build_region_record(run_end),
        build_region_record(run_end, interval_end=run_end + FIVE_MINUTE_INTERVAL, total_demand="9999"),
    ]

    region_snapshots = collect_region_snapshots(region_records, "NSW1")

    assert region_snapshots == {run_end: RegionSnapshot(7000.0, 10000.0, -500.0)}


def test_collect_region_snapshots_skips_intervention_runs() -> None:
    """有 INTERVENTION 欄且不為 0：略過；為 0 時保留。"""
    run_end = FIRST_DAY_START + FIVE_MINUTE_INTERVAL
    region_records = [
        build_region_record(run_end, total_demand="9999", extra_fields={"INTERVENTION": "1"}),
        build_region_record(run_end, extra_fields={"INTERVENTION": "0"}),
    ]

    assert collect_region_snapshots(region_records, "NSW1") == {run_end: RegionSnapshot(7000.0, 10000.0, -500.0)}


def test_collect_region_snapshots_skips_other_regions() -> None:
    """其他區域的列：略過。"""
    other_region_record = build_region_record(FIRST_DAY_START + FIVE_MINUTE_INTERVAL, extra_fields={"REGIONID": "VIC1"})

    assert collect_region_snapshots([other_region_record], "NSW1") == {}


def test_collect_region_snapshots_rejects_conflicting_duplicate() -> None:
    """重疊資料夾中同一次求解的值不同：丟出帶時間與兩個來源位置的 ValueError。"""
    run_end = FIRST_DAY_START + FIVE_MINUTE_INTERVAL
    region_records = [
        build_region_record(run_end, record_location="甲檔 第 3 行"),
        build_region_record(run_end, total_demand="7001", record_location="乙檔 第 8 行"),
    ]

    with pytest.raises(ValueError, match="2025-04-10T00:05:00.*甲檔 第 3 行.*乙檔 第 8 行"):
        collect_region_snapshots(region_records, "NSW1")


def test_collect_region_snapshots_rejects_text_value() -> None:
    """數值欄不是數字：丟出指出來源位置與欄名的 ValueError。"""
    region_records = [build_region_record(FIRST_DAY_START + FIVE_MINUTE_INTERVAL, total_demand="")]

    with pytest.raises(ValueError, match="測試檔 第 2 行.*TOTALDEMAND"):
        collect_region_snapshots(region_records, "NSW1")


def test_compute_region_day_factors_summarizes_full_day() -> None:
    """完整的一天：日均需求、晚間尖峰、最小供給餘裕、日均淨進出口都依定義計算。"""
    evening_step = (17 * 60 + 5) // 5
    region_snapshots = build_full_day(FIRST_DAY_START, {evening_step: 9000.0, 1: 9500.0})

    region_result = compute_region_day_factors(region_snapshots)

    day_factors = region_result.factors_by_date[date(2025, 4, 10)]
    assert day_factors.demand_mean_mw == pytest.approx(7000.0 + (2000.0 + 2500.0) / FIVE_MINUTE_INTERVALS_PER_DAY)
    assert day_factors.evening_peak_demand_mw == 9000.0
    assert day_factors.supply_margin_min_mw == 500.0
    assert day_factors.net_interchange_mean_mw == -500.0
    assert region_result.incomplete_run_counts == {}


@pytest.mark.parametrize(
    ("interval_end_minutes", "is_in_window"),
    [(17 * 60, False), (17 * 60 + 5, True), (21 * 60, True), (21 * 60 + 5, False)],
)
def test_compute_region_day_factors_evening_window_uses_interval_start(
    interval_end_minutes: int, is_in_window: bool
) -> None:
    """晚間尖峰以時段開始時間判斷：結束於 17:05 到 21:00 的時段算在 17:00–21:00 內。"""
    peak_step = interval_end_minutes // 5
    region_snapshots = build_full_day(FIRST_DAY_START, {peak_step: 12000.0})

    day_factors = compute_region_day_factors(region_snapshots).factors_by_date[date(2025, 4, 10)]

    assert (day_factors.evening_peak_demand_mw == 12000.0) is is_in_window


def test_compute_region_day_factors_midnight_end_belongs_to_previous_day() -> None:
    """結束於 24:00 的快照屬於前一天：前一天完整，次日只有部分資料而列為不完整。"""
    region_snapshots = build_full_day(FIRST_DAY_START)
    region_snapshots[FIRST_DAY_START + timedelta(days=1, minutes=5)] = RegionSnapshot(7000.0, 10000.0, -500.0)

    region_result = compute_region_day_factors(region_snapshots)

    assert list(region_result.factors_by_date) == [date(2025, 4, 10)]
    assert region_result.incomplete_run_counts == {date(2025, 4, 11): 1}


def test_compute_region_day_factors_reports_day_with_missing_runs() -> None:
    """一天少於 288 次求解：不算因素，記下實際次數。"""
    region_snapshots = build_full_day(FIRST_DAY_START)
    del region_snapshots[FIRST_DAY_START + 100 * FIVE_MINUTE_INTERVAL]

    region_result = compute_region_day_factors(region_snapshots)

    assert region_result.factors_by_date == {}
    assert region_result.incomplete_run_counts == {date(2025, 4, 10): FIVE_MINUTE_INTERVALS_PER_DAY - 1}
