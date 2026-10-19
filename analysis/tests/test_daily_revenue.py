"""`analysis.daily_revenue` 的單元測試。"""

from datetime import date, datetime, timedelta

import pytest

from analysis.arbitrage_plan import BatterySpecification
from analysis.daily_revenue import (
    average_half_hour_prices,
    compute_daily_revenue,
    merge_interval_prices,
)
from analysis.mms_csv import MmsRecord
from analysis.nem_day import FIVE_MINUTE_INTERVAL, HALF_HOUR_INTERVAL, HALF_HOURS_PER_DAY

FOUR_HOUR_BATTERY = BatterySpecification(power_mw=5, capacity_mwh=20, marginal_loss_factor=1)
FIRST_DAY_START = datetime(2025, 4, 10)


def build_price_record(
    settlement_text: str, price_text: str, region_id: str = "NSW1", record_location: str = "測試檔 第 2 行"
) -> MmsRecord:
    """組一筆 TRADING.PRICE 資料列。"""
    return MmsRecord({"SETTLEMENTDATE": settlement_text, "REGIONID": region_id, "RRP": price_text}, record_location)


def build_half_hour_day(day_start: datetime, price_values: list[float]) -> dict[datetime, float]:
    """把一天的 30 分鐘電價依序放到結束時間 00:30、01:00、…、24:00。"""
    return {
        day_start + (half_hour_index + 1) * HALF_HOUR_INTERVAL: price_value
        for half_hour_index, price_value in enumerate(price_values)
    }


def test_merge_interval_prices_keeps_only_requested_region() -> None:
    """多個區域混在一起：只留指定區域的電價。"""
    price_records = [
        build_price_record("2025/04/10 00:05:00", "58"),
        build_price_record("2025/04/10 00:05:00", "70", region_id="VIC1"),
    ]

    merged_prices = merge_interval_prices(price_records, "NSW1")

    assert merged_prices == {datetime(2025, 4, 10, 0, 5): 58.0}


def test_merge_interval_prices_accepts_identical_duplicate() -> None:
    """同一時段重複出現且電價相同：去重後留一筆。"""
    price_records = [build_price_record("2025/04/10 00:05:00", "58")] * 2

    assert merge_interval_prices(price_records, "NSW1") == {datetime(2025, 4, 10, 0, 5): 58.0}


def test_merge_interval_prices_rejects_conflicting_duplicate() -> None:
    """同一時段出現兩個不同電價：丟出帶時間、兩個值與兩個來源位置的 ValueError。"""
    price_records = [
        build_price_record("2025/04/10 00:05:00", "58", record_location="甲檔 第 7 行"),
        build_price_record("2025/04/10 00:05:00", "59", record_location="乙檔 第 9 行"),
    ]

    with pytest.raises(ValueError, match="2025-04-10T00:05:00.*58.0（甲檔 第 7 行）.*59.0（乙檔 第 9 行）"):
        merge_interval_prices(price_records, "NSW1")


def test_merge_interval_prices_rejects_non_finite_price() -> None:
    """RRP 為 NaN：丟出 ValueError。"""
    with pytest.raises(ValueError, match="RRP"):
        merge_interval_prices([build_price_record("2025/04/10 00:05:00", "nan")], "NSW1")


def test_merge_interval_prices_rejects_text_price_with_timestamp() -> None:
    """RRP 不是數字：丟出帶來源位置、時段時間與原字串的 ValueError。"""
    with pytest.raises(ValueError, match="測試檔 第 2 行（2025-04-10T00:05:00）.*abc"):
        merge_interval_prices([build_price_record("2025/04/10 00:05:00", "abc")], "NSW1")


def test_merge_interval_prices_rejects_missing_field() -> None:
    """資料列缺少 RRP 欄：丟出指出來源位置與欄名的 ValueError。"""
    incomplete_record = MmsRecord({"SETTLEMENTDATE": "2025/04/10 00:05:00", "REGIONID": "NSW1"}, "測試檔 第 4 行")

    with pytest.raises(ValueError, match="測試檔 第 4 行.*RRP"):
        merge_interval_prices([incomplete_record], "NSW1")


def test_average_half_hour_prices_averages_six_five_minute_prices() -> None:
    """六筆 5 分鐘電價：30 分鐘電價為其算術平均。"""
    five_minute_prices = {FIRST_DAY_START + step_index * FIVE_MINUTE_INTERVAL: float(step_index) for step_index in range(1, 7)}

    assert average_half_hour_prices(five_minute_prices) == {FIRST_DAY_START + HALF_HOUR_INTERVAL: 3.5}


def test_average_half_hour_prices_drops_incomplete_half_hour() -> None:
    """30 分鐘時段只有五筆 5 分鐘電價：不列入結果。"""
    five_minute_prices = {FIRST_DAY_START + step_index * FIVE_MINUTE_INTERVAL: 10.0 for step_index in range(1, 6)}

    assert average_half_hour_prices(five_minute_prices) == {}


def test_compute_daily_revenue_uses_select_best_plan_per_day() -> None:
    """完整的一天：收益等於 select_best_plan 的總收益。"""
    price_values = [0.0] * 8 + [100.0] * 8 + [50.0] * (HALF_HOURS_PER_DAY - 16)

    daily_result = compute_daily_revenue(build_half_hour_day(FIRST_DAY_START, price_values), FOUR_HOUR_BATTERY)

    assert daily_result.revenue_by_date == {date(2025, 4, 10): 2000.0}
    assert daily_result.incomplete_dates == ()


def test_compute_daily_revenue_does_not_cross_midnight() -> None:
    """低價日接高價日：不跨午夜套利，兩天收益都是 0。"""
    cheap_day = build_half_hour_day(FIRST_DAY_START, [0.0] * HALF_HOURS_PER_DAY)
    expensive_day = build_half_hour_day(FIRST_DAY_START + timedelta(days=1), [100.0] * HALF_HOURS_PER_DAY)

    daily_result = compute_daily_revenue({**cheap_day, **expensive_day}, FOUR_HOUR_BATTERY)

    assert daily_result.revenue_by_date == {date(2025, 4, 10): 0.0, date(2025, 4, 11): 0.0}


def test_compute_daily_revenue_reports_incomplete_day() -> None:
    """一天不足 48 段：不算收益，列為不完整。"""
    half_hour_prices = build_half_hour_day(FIRST_DAY_START, [10.0] * (HALF_HOURS_PER_DAY - 1))

    daily_result = compute_daily_revenue(half_hour_prices, FOUR_HOUR_BATTERY)

    assert daily_result.revenue_by_date == {}
    assert daily_result.incomplete_dates == (date(2025, 4, 10),)


def test_compute_daily_revenue_empty_input_gives_empty_result() -> None:
    """沒有任何電價：收益與不完整日都為空。"""
    daily_result = compute_daily_revenue({}, FOUR_HOUR_BATTERY)

    assert daily_result.revenue_by_date == {}
    assert daily_result.incomplete_dates == ()
