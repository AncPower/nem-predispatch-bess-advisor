"""每日套利收益（被解釋變數）：5 分鐘電價 → 30 分鐘均價 → 每天各自跑 `select_best_plan`（純計算）。

- 30 分鐘均價：結束於 T−25 到 T 的六筆 5 分鐘 RRP 的算術平均；不足六筆的 30 分鐘時段不算。
- 每個交易日各自從空電池開始，計畫不跨過午夜；一天不足 48 段就不算收益，列為不完整。
"""

import math
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime

from analysis.arbitrage_plan import BatterySpecification, select_best_plan
from analysis.mms_csv import MmsRecord
from analysis.nem_day import (
    FIVE_MINUTE_INTERVALS_PER_HALF_HOUR,
    HALF_HOUR_INTERVAL,
    HALF_HOURS_PER_DAY,
    half_hour_end_for,
    parse_mms_timestamp,
    trading_date_for,
)

SETTLEMENT_FIELD: str = "SETTLEMENTDATE"
REGION_FIELD: str = "REGIONID"
PRICE_FIELD: str = "RRP"


@dataclass(frozen=True)
class DailyRevenueResult:
    """每日收益與因資料不完整而沒有算的交易日。"""

    revenue_by_date: dict[date, float]
    incomplete_dates: tuple[date, ...]


@dataclass(frozen=True)
class SourcedPrice:
    """一個時段的電價與它來自哪個檔案的哪一行。"""

    price_value: float
    record_location: str


def read_record_field(price_record: MmsRecord, field_name: str) -> str:
    """取出資料列的欄位值。

    Args:
        price_record: TRADING.PRICE 的一列。
        field_name: 欄名。

    Returns:
        欄位字串。

    Raises:
        ValueError: 沒有這個欄位時，訊息帶檔案與行號。
    """
    field_value = price_record.field_values.get(field_name)
    if field_value is None:
        raise ValueError(f"{price_record.record_location}：TRADING.PRICE 資料列缺少欄位 {field_name}")
    return field_value


def parse_price_value(price_text: str, interval_end: datetime, record_location: str) -> float:
    """把 RRP 字串轉成有限浮點數。

    Args:
        price_text: RRP 欄的字串。
        interval_end: 時段結束時間，用於錯誤訊息。
        record_location: 這一列的檔案與行號，用於錯誤訊息。

    Returns:
        電價（AUD/MWh）。

    Raises:
        ValueError: 不是有限數值時。
    """
    record_label = f"{record_location}（{interval_end.isoformat()}）"
    try:
        price_value = float(price_text)
    except ValueError as parse_error:
        raise ValueError(f"{record_label} 的 {PRICE_FIELD} 不是數字：{price_text}") from parse_error
    if not math.isfinite(price_value):
        raise ValueError(f"{record_label} 的 {PRICE_FIELD} 不是有限數值：{price_text}")
    return price_value


def merge_interval_prices(price_records: Iterable[MmsRecord], region_id: str) -> dict[datetime, float]:
    """把多個檔案的 TRADING.PRICE 資料列合併成「時段結束時間 → 電價」，重複的時段去重。

    相鄰的期間資料夾會重疊一個月；重疊的值必須相同，否則代表資料有問題，直接停止。

    Args:
        price_records: `mms_csv` 讀出的資料列。
        region_id: 只取這個區域，例如 `NSW1`。

    Returns:
        依時段結束時間對應的電價。

    Raises:
        ValueError: 欄位缺漏、電價不是有限數值，或同一時段出現不同電價時；訊息帶檔案與行號，衝突時兩個來源都列出。
    """
    sourced_prices: dict[datetime, SourcedPrice] = {}
    for price_record in price_records:
        if read_record_field(price_record, REGION_FIELD) != region_id:
            continue
        interval_end = parse_mms_timestamp(read_record_field(price_record, SETTLEMENT_FIELD))
        price_text = read_record_field(price_record, PRICE_FIELD)
        price_value = parse_price_value(price_text, interval_end, price_record.record_location)
        existing_price = sourced_prices.setdefault(interval_end, SourcedPrice(price_value, price_record.record_location))
        if existing_price.price_value != price_value:
            raise ValueError(
                f"{interval_end.isoformat()} 出現兩個不同的電價：{existing_price.price_value}（{existing_price.record_location}）"
                f" 與 {price_value}（{price_record.record_location}）"
            )
    return {interval_end: sourced_price.price_value for interval_end, sourced_price in sourced_prices.items()}


def average_half_hour_prices(five_minute_prices: Mapping[datetime, float]) -> dict[datetime, float]:
    """5 分鐘電價平均成 30 分鐘電價；不足六筆的 30 分鐘時段不列入。

    Args:
        five_minute_prices: 5 分鐘時段結束時間 → 電價。

    Returns:
        30 分鐘時段結束時間 → 均價。
    """
    grouped_prices: defaultdict[datetime, list[float]] = defaultdict(list)
    for interval_end in sorted(five_minute_prices):
        grouped_prices[half_hour_end_for(interval_end)].append(five_minute_prices[interval_end])
    return {
        half_hour_end: sum(price_values) / len(price_values)
        for half_hour_end, price_values in grouped_prices.items()
        if len(price_values) == FIVE_MINUTE_INTERVALS_PER_HALF_HOUR
    }


def group_prices_by_trading_date(half_hour_prices: Mapping[datetime, float]) -> dict[date, list[float]]:
    """30 分鐘電價依交易日分組，每組依時間排序。

    Args:
        half_hour_prices: 30 分鐘時段結束時間 → 均價。

    Returns:
        交易日 → 當天依序的電價。
    """
    grouped_prices: defaultdict[date, list[float]] = defaultdict(list)
    for half_hour_end in sorted(half_hour_prices):
        grouped_prices[trading_date_for(half_hour_end, HALF_HOUR_INTERVAL)].append(half_hour_prices[half_hour_end])
    return dict(grouped_prices)


def compute_daily_revenue(
    half_hour_prices: Mapping[datetime, float], battery_specification: BatterySpecification
) -> DailyRevenueResult:
    """每個完整交易日的最佳計畫收益。

    Args:
        half_hour_prices: 30 分鐘時段結束時間 → 均價。
        battery_specification: 電池規格。

    Returns:
        每日收益（AUD），以及有資料但不足 48 段、沒有算收益的交易日。完全沒有資料的日子兩邊都不會出現。
    """
    prices_by_date = group_prices_by_trading_date(half_hour_prices)
    revenue_by_date = {
        trading_date: select_best_plan(price_values, battery_specification).total_value
        for trading_date, price_values in sorted(prices_by_date.items())
        if len(price_values) == HALF_HOURS_PER_DAY
    }
    incomplete_dates = tuple(sorted(set(prices_by_date) - set(revenue_by_date)))
    return DailyRevenueResult(revenue_by_date, incomplete_dates)
