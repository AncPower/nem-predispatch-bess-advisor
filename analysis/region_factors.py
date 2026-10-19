"""P5MIN 區域解的四個日因素（純計算）：日均需求、晚間尖峰需求、最小供給餘裕、日均淨進出口。

- 每次求解（`RUN_DATETIME`）只取第一個時段（`INTERVAL_DATETIME` 等於求解時間），代表當下的狀態。
- 有 `INTERVENTION` 欄（舊版 v7）時只留 0；新版沒有這一欄，照收。
- 一天要有 288 次求解才算因素；不足的日子記下實際次數，不補值。
- 晚間尖峰窗為時段開始時間落在 [17:00, 21:00)。
"""

import statistics
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, time

from analysis.nem_day import (
    FIVE_MINUTE_INTERVAL,
    FIVE_MINUTE_INTERVALS_PER_DAY,
    parse_mms_timestamp,
    trading_date_for,
)
from analysis.record_fields import parse_finite_field, read_record_field

REGION_TABLE_LABEL: str = "P5MIN.REGIONSOLUTION"
RUN_FIELD: str = "RUN_DATETIME"
INTERVAL_FIELD: str = "INTERVAL_DATETIME"
REGION_FIELD: str = "REGIONID"
INTERVENTION_FIELD: str = "INTERVENTION"
NO_INTERVENTION: str = "0"
DEMAND_FIELD: str = "TOTALDEMAND"
AVAILABLE_GENERATION_FIELD: str = "AVAILABLEGENERATION"
NET_INTERCHANGE_FIELD: str = "NETINTERCHANGE"
EVENING_WINDOW_START: time = time(17, 0)
EVENING_WINDOW_END: time = time(21, 0)


@dataclass(frozen=True)
class RegionSnapshot:
    """某次求解第一個時段的區域狀態（MW）。`net_interchange_mw` 正值為淨送出、負值為淨輸入。"""

    total_demand_mw: float
    available_generation_mw: float
    net_interchange_mw: float


@dataclass(frozen=True)
class RegionDayFactors:
    """一個交易日的四個區域因素（MW）。"""

    demand_mean_mw: float
    evening_peak_demand_mw: float
    supply_margin_min_mw: float
    net_interchange_mean_mw: float


@dataclass(frozen=True)
class RegionFactorResult:
    """各交易日的區域因素，以及求解次數不足 288 的日子與其實際次數。"""

    factors_by_date: dict[date, RegionDayFactors]
    incomplete_run_counts: dict[date, int]


def is_current_state_record(region_record: Mapping[str, str], region_id: str) -> bool:
    """這一列是否為指定區域、無介入、求解第一個時段的資料。

    Args:
        region_record: P5MIN.REGIONSOLUTION 的一列。
        region_id: 區域，例如 `NSW1`。

    Returns:
        符合時為 True。
    """
    if read_record_field(region_record, REGION_FIELD, REGION_TABLE_LABEL) != region_id:
        return False
    if region_record.get(INTERVENTION_FIELD, NO_INTERVENTION) != NO_INTERVENTION:
        return False
    run_text = read_record_field(region_record, RUN_FIELD, REGION_TABLE_LABEL)
    return run_text == read_record_field(region_record, INTERVAL_FIELD, REGION_TABLE_LABEL)


def parse_region_snapshot(region_record: Mapping[str, str], record_label: str) -> RegionSnapshot:
    """把資料列的三個數值欄轉成快照。

    Args:
        region_record: P5MIN.REGIONSOLUTION 的一列。
        record_label: 錯誤訊息用的位置說明。

    Returns:
        區域快照。

    Raises:
        ValueError: 任一數值欄缺漏或不是有限數值時。
    """
    return RegionSnapshot(
        total_demand_mw=parse_finite_field(region_record, DEMAND_FIELD, record_label),
        available_generation_mw=parse_finite_field(region_record, AVAILABLE_GENERATION_FIELD, record_label),
        net_interchange_mw=parse_finite_field(region_record, NET_INTERCHANGE_FIELD, record_label),
    )


def collect_region_snapshots(
    region_records: Iterable[Mapping[str, str]], region_id: str
) -> dict[datetime, RegionSnapshot]:
    """從多個檔案的資料列收集「求解時間 → 快照」，重疊的求解去重。

    Args:
        region_records: `mms_csv` 讀出的 P5MIN.REGIONSOLUTION 資料列。
        region_id: 區域，例如 `NSW1`。

    Returns:
        依求解時間（等於第一個時段的結束時間）對應的快照。

    Raises:
        ValueError: 欄位有誤，或同一次求解出現不同的值時。
    """
    region_snapshots: dict[datetime, RegionSnapshot] = {}
    for region_record in region_records:
        if not is_current_state_record(region_record, region_id):
            continue
        run_end = parse_mms_timestamp(region_record[RUN_FIELD])
        region_snapshot = parse_region_snapshot(region_record, f"{REGION_TABLE_LABEL} {run_end.isoformat()}")
        existing_snapshot = region_snapshots.setdefault(run_end, region_snapshot)
        if existing_snapshot != region_snapshot:
            raise ValueError(f"{run_end.isoformat()} 的求解出現兩組不同的值：{existing_snapshot} 與 {region_snapshot}")
    return region_snapshots


def is_in_evening_window(interval_end: datetime) -> bool:
    """5 分鐘時段的開始時間是否落在晚間尖峰窗 [17:00, 21:00)。

    Args:
        interval_end: 時段結束時間。

    Returns:
        在窗內時為 True。
    """
    interval_start_time = (interval_end - FIVE_MINUTE_INTERVAL).time()
    return EVENING_WINDOW_START <= interval_start_time < EVENING_WINDOW_END


def summarize_region_day(day_snapshots: Mapping[datetime, RegionSnapshot]) -> RegionDayFactors:
    """把一天的 288 個快照彙整成四個因素。

    Args:
        day_snapshots: 同一交易日的「時段結束時間 → 快照」。

    Returns:
        當天的區域因素。
    """
    day_snapshot_values = list(day_snapshots.values())
    evening_demands = [
        region_snapshot.total_demand_mw
        for interval_end, region_snapshot in day_snapshots.items()
        if is_in_evening_window(interval_end)
    ]
    return RegionDayFactors(
        demand_mean_mw=statistics.fmean(region_snapshot.total_demand_mw for region_snapshot in day_snapshot_values),
        evening_peak_demand_mw=max(evening_demands),
        supply_margin_min_mw=min(
            region_snapshot.available_generation_mw - region_snapshot.total_demand_mw
            for region_snapshot in day_snapshot_values
        ),
        net_interchange_mean_mw=statistics.fmean(region_snapshot.net_interchange_mw for region_snapshot in day_snapshot_values),
    )


def compute_region_day_factors(region_snapshots: Mapping[datetime, RegionSnapshot]) -> RegionFactorResult:
    """依交易日彙整快照；求解次數不足 288 的日子不算因素。

    Args:
        region_snapshots: 「求解時間 → 快照」。

    Returns:
        各交易日的因素與不完整日的實際求解次數。
    """
    snapshots_by_date: defaultdict[date, dict[datetime, RegionSnapshot]] = defaultdict(dict)
    for run_end in sorted(region_snapshots):
        snapshots_by_date[trading_date_for(run_end, FIVE_MINUTE_INTERVAL)][run_end] = region_snapshots[run_end]
    factors_by_date = {
        trading_date: summarize_region_day(day_snapshots)
        for trading_date, day_snapshots in snapshots_by_date.items()
        if len(day_snapshots) == FIVE_MINUTE_INTERVALS_PER_DAY
    }
    incomplete_run_counts = {
        trading_date: len(day_snapshots)
        for trading_date, day_snapshots in snapshots_by_date.items()
        if trading_date not in factors_by_date
    }
    return RegionFactorResult(factors_by_date, incomplete_run_counts)
