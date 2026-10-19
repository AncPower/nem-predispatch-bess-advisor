"""`data/external/` 的兩個日因素：雪梨天然氣事前價、NSW 電池放電功率（月底值）。

- 天然氣價：`sttm_sydney_daily_price.csv` 的 `exante_price_aud_per_gj`，以 `gas_date` 對應同一個交易日。
- 電池放電功率：依 `docs/data_sources.md` #8，每月月底符合條件機組的 `max_capacity_mw` 加總，當月每天都用這個值。
  月底沒有任何機組（2024-06 以前）視為缺資料，不補值也不填 0。

讀檔只有 `read_csv_records`，其餘都是純計算。
"""

import calendar
import csv
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from analysis.record_fields import parse_finite_field, parse_iso_date_field, read_record_field

GAS_TABLE_LABEL: str = "STTM 雪梨天然氣價"
GAS_DATE_FIELD: str = "gas_date"
GAS_PRICE_FIELD: str = "exante_price_aud_per_gj"
BATTERY_TABLE_LABEL: str = "NSW 電池機組"


@dataclass(frozen=True)
class BatteryUnitRecord:
    """`nsw_battery_units.csv` 的一列：某機組自 `effective_date` 起的放電功率，與它在 NSW1 的有效期間。"""

    duid: str
    effective_date: date
    max_capacity_mw: float
    region_start_date: date
    region_end_date: date

    @classmethod
    def from_csv_record(cls, unit_record: Mapping[str, str], record_label: str) -> "BatteryUnitRecord":
        """由 CSV 列建立記錄。

        Args:
            unit_record: 一列「欄名 → 字串」。
            record_label: 錯誤訊息用的位置說明。

        Returns:
            機組記錄。

        Raises:
            ValueError: 欄位缺漏或格式不符時。
        """
        return cls(
            duid=read_record_field(unit_record, "duid", record_label),
            effective_date=parse_iso_date_field(unit_record, "effective_date", record_label),
            max_capacity_mw=parse_finite_field(unit_record, "max_capacity_mw", record_label),
            region_start_date=parse_iso_date_field(unit_record, "region_start_date", record_label),
            region_end_date=parse_iso_date_field(unit_record, "region_end_date", record_label),
        )


def read_csv_records(csv_path: Path) -> list[dict[str, str]]:
    """讀取有標題列的 CSV。

    Args:
        csv_path: 檔案路徑。

    Returns:
        每列一筆「欄名 → 字串」。
    """
    with csv_path.open(newline="", encoding="utf-8") as csv_file:
        return list(csv.DictReader(csv_file))


def parse_gas_prices(gas_records: Iterable[Mapping[str, str]]) -> dict[date, float]:
    """天然氣日 → 事前價（AUD/GJ）。

    Args:
        gas_records: `sttm_sydney_daily_price.csv` 的列。

    Returns:
        依日期對應的事前價。

    Raises:
        ValueError: 欄位有誤或同一天出現兩次時。
    """
    gas_prices: dict[date, float] = {}
    for row_number, gas_record in enumerate(gas_records, start=1):
        record_label = f"{GAS_TABLE_LABEL} 第 {row_number} 筆"
        gas_date = parse_iso_date_field(gas_record, GAS_DATE_FIELD, record_label)
        if gas_date in gas_prices:
            raise ValueError(f"{record_label}：{gas_date.isoformat()} 重複出現")
        gas_prices[gas_date] = parse_finite_field(gas_record, GAS_PRICE_FIELD, record_label)
    return gas_prices


def parse_battery_units(unit_records: Iterable[Mapping[str, str]]) -> tuple[BatteryUnitRecord, ...]:
    """把機組 CSV 列轉成記錄。

    Args:
        unit_records: `nsw_battery_units.csv` 的列。

    Returns:
        機組記錄，順序同檔案。
    """
    return tuple(
        BatteryUnitRecord.from_csv_record(unit_record, f"{BATTERY_TABLE_LABEL} 第 {row_number} 筆")
        for row_number, unit_record in enumerate(unit_records, start=1)
    )


def month_end_for(any_day: date) -> date:
    """當月最後一天。

    Args:
        any_day: 任一天。

    Returns:
        同月的最後一天。
    """
    _first_weekday, days_in_month = calendar.monthrange(any_day.year, any_day.month)
    return any_day.replace(day=days_in_month)


def battery_power_at(battery_units: Iterable[BatteryUnitRecord], as_of_date: date) -> float | None:
    """某天 NSW1 已併網電池的放電功率加總（MW）。

    符合條件：`region_start_date` ≤ 查詢日 < `region_end_date`；同一機組有多列時，取生效日不晚於查詢日的最後一列。

    Args:
        battery_units: 機組記錄。
        as_of_date: 查詢日，通常是月底。

    Returns:
        放電功率加總；沒有任何符合條件的機組時為 None（缺資料，不是 0）。
    """
    latest_by_unit: dict[str, BatteryUnitRecord] = {}
    for unit_record in battery_units:
        is_in_region = unit_record.region_start_date <= as_of_date < unit_record.region_end_date
        if not is_in_region or unit_record.effective_date > as_of_date:
            continue
        current_record = latest_by_unit.get(unit_record.duid)
        if current_record is None or unit_record.effective_date > current_record.effective_date:
            latest_by_unit[unit_record.duid] = unit_record
    if not latest_by_unit:
        return None
    return sum(unit_record.max_capacity_mw for unit_record in latest_by_unit.values())


def daily_battery_power(
    battery_units: Iterable[BatteryUnitRecord], trading_dates: Iterable[date]
) -> dict[date, float]:
    """每個交易日的電池放電功率：用當月月底值；月底沒有機組的日子不列出。

    Args:
        battery_units: 機組記錄。
        trading_dates: 要計算的交易日。

    Returns:
        交易日 → 放電功率（MW），只含有值的日子。
    """
    unit_records = tuple(battery_units)
    month_end_values: dict[date, float | None] = {}
    battery_by_date: dict[date, float] = {}
    for trading_date in sorted(trading_dates):
        month_end = month_end_for(trading_date)
        if month_end not in month_end_values:
            month_end_values[month_end] = battery_power_at(unit_records, month_end)
        month_end_power = month_end_values[month_end]
        if month_end_power is not None:
            battery_by_date[trading_date] = month_end_power
    return battery_by_date
