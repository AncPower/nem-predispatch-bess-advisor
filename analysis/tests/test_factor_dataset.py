"""`analysis.factor_dataset` 的單元測試。"""

from dataclasses import fields
from datetime import date

import pytest

from analysis.daily_revenue import DailyRevenueResult
from analysis.external_factors import BatteryUnitRecord, daily_battery_power
from analysis.factor_dataset import (
    FACTOR_DEFINITIONS,
    DailyFactorValues,
    FactorSources,
    build_factor_dataset,
    span_source_dates,
)
from analysis.region_factors import RegionDayFactors, RegionFactorResult

FIRST_DAY = date(2024, 7, 1)
SECOND_DAY = date(2024, 7, 2)
THIRD_DAY = date(2024, 7, 3)
FOURTH_DAY = date(2024, 7, 4)


def build_region_day(demand_mean_mw: float) -> RegionDayFactors:
    """組一天的區域因素；只有日均需求可變，其餘固定。"""
    return RegionDayFactors(demand_mean_mw, 9000.0, 1500.0, -400.0)


def build_sources(
    revenue_dates: list[date],
    region_dates: list[date],
    gas_dates: list[date],
    battery_dates: list[date],
    incomplete_run_counts: dict[date, int] | None = None,
) -> FactorSources:
    """依各來源有資料的日子組輸入；收益與需求用日期的日數區分。"""
    return FactorSources(
        daily_revenue=DailyRevenueResult({source_day: 1000.0 * source_day.day for source_day in revenue_dates}, ()),
        region_factors=RegionFactorResult(
            {source_day: build_region_day(7000.0 + source_day.day) for source_day in region_dates}, incomplete_run_counts or {}
        ),
        gas_prices={source_day: 12.0 for source_day in gas_dates},
        battery_power={source_day: 140.0 for source_day in battery_dates},
    )


def test_factor_definitions_match_daily_value_fields() -> None:
    """因素定義的名稱與順序：和 DailyFactorValues 的欄位完全相同。"""
    assert [definition.factor_name for definition in FACTOR_DEFINITIONS] == [
        value_field.name for value_field in fields(DailyFactorValues)
    ]


def test_build_factor_dataset_keeps_days_with_every_factor() -> None:
    """四個來源都有值的日子：放進資料集，欄依因素定義的順序。"""
    all_days = [FIRST_DAY, SECOND_DAY]
    factor_sources = build_sources(all_days, all_days, all_days, all_days)

    factor_dataset = build_factor_dataset(factor_sources)

    assert factor_dataset.trading_dates == (FIRST_DAY, SECOND_DAY)
    assert factor_dataset.factor_values.tolist() == [
        [7001.0, 9000.0, 1500.0, -400.0, 12.0, 140.0],
        [7002.0, 9000.0, 1500.0, -400.0, 12.0, 140.0],
    ]
    assert factor_dataset.revenue_values.tolist() == [1000.0, 2000.0]
    assert factor_dataset.excluded_days == ()


def test_build_factor_dataset_records_gap_inside_period_with_reasons() -> None:
    """期間中間缺資料的日子：排除，並記下每個缺漏的原因。"""
    all_days = [FIRST_DAY, SECOND_DAY, THIRD_DAY]
    factor_sources = build_sources(
        all_days, [FIRST_DAY, THIRD_DAY], [FIRST_DAY, THIRD_DAY], all_days, incomplete_run_counts={SECOND_DAY: 276}
    )

    factor_dataset = build_factor_dataset(factor_sources)

    assert factor_dataset.trading_dates == (FIRST_DAY, THIRD_DAY)
    assert len(factor_dataset.excluded_days) == 1
    assert factor_dataset.excluded_days[0].trading_date == SECOND_DAY
    assert "276" in factor_dataset.excluded_days[0].reason
    assert "天然氣" in factor_dataset.excluded_days[0].reason


def test_build_factor_dataset_period_starts_when_battery_data_starts() -> None:
    """電池裝置量從第三天才有值：期間從第三天開始，前兩天不算在期間內也不列為排除。"""
    all_days = [FIRST_DAY, SECOND_DAY, THIRD_DAY, FOURTH_DAY]
    factor_sources = build_sources(all_days, all_days, all_days, [THIRD_DAY, FOURTH_DAY])

    factor_dataset = build_factor_dataset(factor_sources)

    assert factor_dataset.trading_dates == (THIRD_DAY, FOURTH_DAY)
    assert factor_dataset.excluded_days == ()


def test_build_factor_dataset_lists_day_missing_from_every_source() -> None:
    """期間中間某天所有來源都沒有資料：仍列為排除。"""
    present_days = [FIRST_DAY, THIRD_DAY]
    factor_sources = build_sources(present_days, present_days, present_days, present_days)

    factor_dataset = build_factor_dataset(factor_sources)

    assert [excluded_day.trading_date for excluded_day in factor_dataset.excluded_days] == [SECOND_DAY]


def test_build_factor_dataset_rejects_no_complete_day() -> None:
    """沒有任何一天四個來源都有值：丟出 ValueError。"""
    factor_sources = build_sources([FIRST_DAY], [FIRST_DAY], [FIRST_DAY], [])

    with pytest.raises(ValueError, match="沒有任何一天"):
        build_factor_dataset(factor_sources)


def test_span_source_dates_covers_gap_between_sources() -> None:
    """來源之間有完全沒資料的日子：區間仍含頭尾之間的每一天。"""
    factor_sources = build_sources([FIRST_DAY], [FOURTH_DAY], [], [])

    spanned_dates = span_source_dates(
        factor_sources.daily_revenue, factor_sources.region_factors, factor_sources.gas_prices
    )

    assert spanned_dates == [FIRST_DAY, SECOND_DAY, THIRD_DAY, FOURTH_DAY]


def test_incomplete_revenue_day_is_not_blamed_on_battery() -> None:
    """期間中間某天電價不完整：電池裝置量照常算出，排除原因只有電價，不含電池。"""
    all_days = [FIRST_DAY, SECOND_DAY, THIRD_DAY]
    battery_unit = BatteryUnitRecord("UNIT1", date(2024, 7, 1), 50.0, date(2024, 7, 1), date(2999, 12, 31))
    daily_revenue = DailyRevenueResult({FIRST_DAY: 1000.0, THIRD_DAY: 3000.0}, (SECOND_DAY,))
    region_factors = RegionFactorResult({source_day: build_region_day(7000.0 + source_day.day) for source_day in all_days}, {})
    gas_prices = {source_day: 12.0 for source_day in all_days}
    battery_power = daily_battery_power((battery_unit,), span_source_dates(daily_revenue, region_factors, gas_prices))

    factor_dataset = build_factor_dataset(FactorSources(daily_revenue, region_factors, gas_prices, battery_power))

    assert [excluded_day.trading_date for excluded_day in factor_dataset.excluded_days] == [SECOND_DAY]
    assert "電價" in factor_dataset.excluded_days[0].reason
    assert "電池" not in factor_dataset.excluded_days[0].reason
