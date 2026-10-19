"""`analysis.external_factors` 的單元測試。"""

from datetime import date
from pathlib import Path

import pytest

from analysis.external_factors import (
    BatteryUnitRecord,
    battery_power_at,
    daily_battery_power,
    month_end_for,
    parse_battery_units,
    parse_gas_prices,
    read_csv_records,
)

REPOSITORY_ROOT: Path = Path(__file__).resolve().parents[2]
BATTERY_UNITS_FILE: Path = REPOSITORY_ROOT / "data" / "external" / "nsw_battery_units.csv"
OPEN_ENDED_DATE = date(2999, 12, 31)


def build_unit(
    duid: str, effective_date: date, max_capacity_mw: float, region_start_date: date, region_end_date: date = OPEN_ENDED_DATE
) -> BatteryUnitRecord:
    """組一筆電池機組記錄。"""
    return BatteryUnitRecord(duid, effective_date, max_capacity_mw, region_start_date, region_end_date)


def test_parse_gas_prices_reads_exante_price_by_gas_date() -> None:
    """STTM 列：以 gas_date 對應事前價。"""
    gas_rows = [{"gas_date": "2024-07-01", "exante_price_aud_per_gj": "12.5", "expost_price_aud_per_gj": "13"}]

    assert parse_gas_prices(gas_rows) == {date(2024, 7, 1): 12.5}


def test_parse_gas_prices_rejects_duplicate_date() -> None:
    """同一天出現兩次：丟出帶日期的 ValueError。"""
    gas_rows = [{"gas_date": "2024-07-01", "exante_price_aud_per_gj": "12.5"}] * 2

    with pytest.raises(ValueError, match="2024-07-01"):
        parse_gas_prices(gas_rows)


def test_parse_gas_prices_rejects_blank_price() -> None:
    """事前價空白：丟出指出欄名的 ValueError。"""
    with pytest.raises(ValueError, match="exante_price_aud_per_gj"):
        parse_gas_prices([{"gas_date": "2024-07-01", "exante_price_aud_per_gj": ""}])


def test_parse_battery_units_reads_typed_fields() -> None:
    """機組登記列：轉成具型別的記錄。"""
    unit_rows = [
        {
            "duid": "BHB1",
            "station_id": "BHBESS",
            "effective_date": "2024-07-04",
            "registered_capacity_mw": "66",
            "max_capacity_mw": "50",
            "max_storage_capacity_mwh": "50",
            "region_start_date": "2024-07-04",
            "region_end_date": "2999-12-31",
        }
    ]

    assert parse_battery_units(unit_rows) == (build_unit("BHB1", date(2024, 7, 4), 50.0, date(2024, 7, 4)),)


@pytest.mark.parametrize(
    ("any_day", "expected_month_end"),
    [(date(2024, 2, 10), date(2024, 2, 29)), (date(2024, 12, 31), date(2024, 12, 31)), (date(2025, 4, 1), date(2025, 4, 30))],
)
def test_month_end_for_returns_last_day_of_month(any_day: date, expected_month_end: date) -> None:
    """任一天：回傳當月最後一天，含閏年二月與月底當天。"""
    assert month_end_for(any_day) == expected_month_end


def test_battery_power_at_uses_latest_effective_row_per_unit() -> None:
    """同一機組有兩筆容量：取生效日不晚於查詢日的最後一筆。"""
    battery_units = (
        build_unit("UNIT1", date(2024, 7, 1), 50.0, date(2024, 7, 1)),
        build_unit("UNIT1", date(2024, 9, 1), 80.0, date(2024, 7, 1)),
    )

    assert battery_power_at(battery_units, date(2024, 8, 31)) == 50.0
    assert battery_power_at(battery_units, date(2024, 9, 30)) == 80.0


def test_battery_power_at_excludes_units_outside_region_period() -> None:
    """尚未進入或已離開 NSW1 的機組：不計入；離開日當天也不計入。"""
    battery_units = (
        build_unit("UNIT1", date(2024, 7, 1), 50.0, date(2024, 7, 1), region_end_date=date(2024, 9, 30)),
        build_unit("UNIT2", date(2024, 7, 1), 20.0, date(2024, 10, 5)),
    )

    assert battery_power_at(battery_units, date(2024, 9, 30)) is None
    assert battery_power_at(battery_units, date(2024, 10, 31)) == 20.0


def test_battery_power_at_without_units_is_missing_not_zero() -> None:
    """查詢日沒有任何機組：回傳 None（缺資料），不用 0。"""
    battery_units = (build_unit("UNIT1", date(2024, 7, 4), 50.0, date(2024, 7, 4)),)

    assert battery_power_at(battery_units, date(2024, 6, 30)) is None


def test_daily_battery_power_uses_month_end_value_and_skips_missing_months() -> None:
    """每天用當月月底值；月底沒有機組的月份整月不列出。"""
    battery_units = (build_unit("UNIT1", date(2024, 7, 4), 50.0, date(2024, 7, 4)),)

    battery_by_date = daily_battery_power(battery_units, [date(2024, 6, 15), date(2024, 7, 1), date(2024, 7, 31)])

    assert battery_by_date == {date(2024, 7, 1): 50.0, date(2024, 7, 31): 50.0}


@pytest.mark.parametrize(
    ("month_end", "expected_power_mw"),
    [(date(2024, 7, 31), 140.0), (date(2024, 12, 31), 1210.0), (date(2025, 12, 31), 2700.0), (date(2026, 9, 30), 3409.0)],
)
def test_battery_power_at_matches_documented_month_end_values(month_end: date, expected_power_mw: float) -> None:
    """repo 內的 NSW 電池 CSV：月底放電功率與 docs/data_sources.md #8 的表相同。"""
    battery_units = parse_battery_units(read_csv_records(BATTERY_UNITS_FILE))

    assert battery_power_at(battery_units, month_end) == pytest.approx(expected_power_mw)


def test_read_csv_records_reads_header_keyed_rows(tmp_path: Path) -> None:
    """有標題列的 CSV：每列轉成「欄名 → 字串」。"""
    csv_file = tmp_path / "sample.csv"
    csv_file.write_text("gas_date,exante_price_aud_per_gj\n2024-07-01,12.5\n", encoding="utf-8")

    assert read_csv_records(csv_file) == [{"gas_date": "2024-07-01", "exante_price_aud_per_gj": "12.5"}]
