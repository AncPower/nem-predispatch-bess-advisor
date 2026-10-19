"""NEM 市場時間（AEST，UTC+10，不調整夏令時間）的時段與交易日換算。

AEMO 的時間戳記都是時段「結束」時間。本模組的 `datetime` 一律是不帶時區的 NEM 時間。
一個交易日 D 是「時段開始時間」落在 [D 00:00, D+1 00:00) 的所有時段，
也就是結束時間在 (D 00:00, D+1 00:00] 之間。
"""

from datetime import date, datetime, time, timedelta

FIVE_MINUTE_INTERVAL: timedelta = timedelta(minutes=5)
HALF_HOUR_INTERVAL: timedelta = timedelta(minutes=30)
INTERVAL_HOURS: float = HALF_HOUR_INTERVAL / timedelta(hours=1)
HALF_HOURS_PER_DAY: int = timedelta(days=1) // HALF_HOUR_INTERVAL
FIVE_MINUTE_INTERVALS_PER_HALF_HOUR: int = HALF_HOUR_INTERVAL // FIVE_MINUTE_INTERVAL
FIVE_MINUTE_INTERVALS_PER_DAY: int = timedelta(days=1) // FIVE_MINUTE_INTERVAL
MMS_TIMESTAMP_FORMAT: str = "%Y/%m/%d %H:%M:%S"


def parse_mms_timestamp(timestamp_text: str) -> datetime:
    """把 AEMO MMS CSV 的時間字串轉成 NEM 時間。

    Args:
        timestamp_text: 例如 `2024/01/01 00:05:00`。

    Returns:
        不帶時區的 NEM 時間。

    Raises:
        ValueError: 格式不符時，訊息帶原字串。
    """
    try:
        return datetime.strptime(timestamp_text, MMS_TIMESTAMP_FORMAT)
    except ValueError as parse_error:
        raise ValueError(f"無法解析 MMS 時間「{timestamp_text}」，格式應為 {MMS_TIMESTAMP_FORMAT}") from parse_error


def trading_date_for(interval_end: datetime, interval_length: timedelta) -> date:
    """時段所屬的交易日：以時段開始時間的日期判斷。

    Args:
        interval_end: 時段結束時間（AEMO 時間戳記）。
        interval_length: 時段長度，例如 5 分鐘或 30 分鐘。

    Returns:
        交易日。
    """
    return (interval_end - interval_length).date()


def half_hour_end_for(five_minute_end: datetime) -> datetime:
    """5 分鐘時段所屬的 30 分鐘時段結束時間。

    結束於 T−25 到 T 分鐘的六個 5 分鐘時段，屬於結束於 T 的 30 分鐘時段。

    Args:
        five_minute_end: 5 分鐘時段結束時間，必須對齊 5 分鐘。

    Returns:
        30 分鐘時段結束時間。

    Raises:
        ValueError: 時間沒有對齊 5 分鐘時。
    """
    end_midnight = datetime.combine(five_minute_end.date(), time())
    if (five_minute_end - end_midnight) % FIVE_MINUTE_INTERVAL:
        raise ValueError(f"時段結束時間沒有對齊 5 分鐘：{five_minute_end.isoformat()}")
    interval_start = five_minute_end - FIVE_MINUTE_INTERVAL
    start_midnight = datetime.combine(interval_start.date(), time())
    half_hour_index = (interval_start - start_midnight) // HALF_HOUR_INTERVAL
    return start_midnight + (half_hour_index + 1) * HALF_HOUR_INTERVAL
