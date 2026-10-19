"""`analysis.nem_day` 的單元測試。"""

from datetime import date, datetime

import pytest

from analysis.nem_day import (
    FIVE_MINUTE_INTERVAL,
    FIVE_MINUTE_INTERVALS_PER_DAY,
    HALF_HOUR_INTERVAL,
    HALF_HOURS_PER_DAY,
    INTERVAL_HOURS,
    half_hour_end_for,
    parse_mms_timestamp,
    trading_date_for,
)


def test_interval_hours_is_half_hour_like_javascript() -> None:
    """時段長度為 0.5 小時，與 JS 的 INTERVAL_HOURS 相同。"""
    assert INTERVAL_HOURS == 0.5


def test_half_hours_per_day_is_48() -> None:
    """一天有 48 個 30 分鐘時段。"""
    assert HALF_HOURS_PER_DAY == 48


def test_five_minute_intervals_per_day_is_288() -> None:
    """一天有 288 個 5 分鐘時段。"""
    assert FIVE_MINUTE_INTERVALS_PER_DAY == 288


def test_parse_mms_timestamp_reads_slash_format() -> None:
    """MMS 的斜線時間格式：轉成對應的 datetime。"""
    assert parse_mms_timestamp("2024/01/01 00:05:00") == datetime(2024, 1, 1, 0, 5)


def test_parse_mms_timestamp_rejects_other_format_with_original_text() -> None:
    """格式不符的時間字串：丟出帶原字串的 ValueError。"""
    with pytest.raises(ValueError, match="2024-01-01T00:05"):
        parse_mms_timestamp("2024-01-01T00:05")


def test_trading_date_for_midnight_end_belongs_to_previous_day() -> None:
    """結束於 24:00 的 5 分鐘時段：屬於前一個交易日。"""
    assert trading_date_for(datetime(2024, 1, 2, 0, 0), FIVE_MINUTE_INTERVAL) == date(2024, 1, 1)


def test_trading_date_for_first_interval_belongs_to_same_day() -> None:
    """結束於 00:05 的第一個時段：屬於當天。"""
    assert trading_date_for(datetime(2024, 1, 1, 0, 5), FIVE_MINUTE_INTERVAL) == date(2024, 1, 1)


def test_trading_date_for_half_hour_midnight_end_belongs_to_previous_day() -> None:
    """結束於 24:00 的 30 分鐘時段：屬於前一個交易日。"""
    assert trading_date_for(datetime(2024, 1, 2, 0, 0), HALF_HOUR_INTERVAL) == date(2024, 1, 1)


@pytest.mark.parametrize(
    ("five_minute_end", "expected_half_hour_end"),
    [
        (datetime(2024, 1, 1, 0, 5), datetime(2024, 1, 1, 0, 30)),
        (datetime(2024, 1, 1, 0, 30), datetime(2024, 1, 1, 0, 30)),
        (datetime(2024, 1, 1, 0, 35), datetime(2024, 1, 1, 1, 0)),
        (datetime(2024, 1, 2, 0, 0), datetime(2024, 1, 2, 0, 0)),
    ],
)
def test_half_hour_end_for_maps_six_five_minute_ends_to_one_half_hour(
    five_minute_end: datetime, expected_half_hour_end: datetime
) -> None:
    """結束於 T−25 到 T 的 5 分鐘時段：都對應到結束於 T 的 30 分鐘時段。"""
    assert half_hour_end_for(five_minute_end) == expected_half_hour_end


def test_half_hour_end_for_rejects_unaligned_timestamp() -> None:
    """沒有對齊 5 分鐘的時間：丟出 ValueError。"""
    with pytest.raises(ValueError, match="5 分鐘"):
        half_hour_end_for(datetime(2024, 1, 1, 0, 7))
