"""`analysis.nem_day` 的單元測試。"""

from datetime import date, datetime

import pytest

from analysis.nem_day import (
    FIVE_MINUTE_INTERVAL,
    HALF_HOUR_INTERVAL,
    HALF_HOURS_PER_DAY,
    INTERVAL_HOURS,
    half_hour_end_for,
    parse_mms_timestamp,
    trading_date_for,
)


def test_interval_hours_is_half_hour_like_javascript() -> None:
    assert INTERVAL_HOURS == 0.5


def test_half_hours_per_day_is_48() -> None:
    assert HALF_HOURS_PER_DAY == 48


def test_parse_mms_timestamp_reads_slash_format() -> None:
    assert parse_mms_timestamp("2024/01/01 00:05:00") == datetime(2024, 1, 1, 0, 5)


def test_parse_mms_timestamp_rejects_other_format_with_original_text() -> None:
    with pytest.raises(ValueError, match="2024-01-01T00:05"):
        parse_mms_timestamp("2024-01-01T00:05")


def test_trading_date_for_midnight_end_belongs_to_previous_day() -> None:
    assert trading_date_for(datetime(2024, 1, 2, 0, 0), FIVE_MINUTE_INTERVAL) == date(2024, 1, 1)


def test_trading_date_for_first_interval_belongs_to_same_day() -> None:
    assert trading_date_for(datetime(2024, 1, 1, 0, 5), FIVE_MINUTE_INTERVAL) == date(2024, 1, 1)


def test_trading_date_for_half_hour_midnight_end_belongs_to_previous_day() -> None:
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
    assert half_hour_end_for(five_minute_end) == expected_half_hour_end


def test_half_hour_end_for_rejects_unaligned_timestamp() -> None:
    with pytest.raises(ValueError, match="5 分鐘"):
        half_hour_end_for(datetime(2024, 1, 1, 0, 7))
