"""把每日收益與六個因素對齊成擬合用的資料集（純計算）。

- 擬合期間：從第一個「所有來源都有值」的日子，到最後一個這樣的日子。
- 期間內缺任何一項的日子排除，記下原因；期間外（例如 2024-07 以前沒有電池裝置量）不列入排除清單。
- 不補值，也不用 0 代替缺漏。
"""

from dataclasses import dataclass
from datetime import date, timedelta

import numpy as np

from analysis.daily_revenue import DailyRevenueResult
from analysis.nem_day import FIVE_MINUTE_INTERVALS_PER_DAY
from analysis.region_factors import RegionFactorResult

REASON_SEPARATOR: str = "；"
ONE_DAY: timedelta = timedelta(days=1)


@dataclass(frozen=True)
class FactorDefinition:
    """因素的名稱、單位與說明；名稱同 `DailyFactorValues` 的欄位。"""

    factor_name: str
    unit: str
    description: str


@dataclass(frozen=True)
class DailyFactorValues:
    """一個交易日的六個因素原始值。"""

    demand_mean_mw: float
    evening_peak_demand_mw: float
    supply_margin_min_mw: float
    net_interchange_mean_mw: float
    gas_price_aud_per_gj: float
    battery_power_mw: float


FACTOR_DEFINITIONS: tuple[FactorDefinition, ...] = (
    FactorDefinition("demand_mean_mw", "MW", "NSW1 當天 TOTALDEMAND 的平均（P5MIN 每次求解的第一個時段）"),
    FactorDefinition("evening_peak_demand_mw", "MW", "時段開始於 17:00–21:00 的 TOTALDEMAND 最大值"),
    FactorDefinition("supply_margin_min_mw", "MW", "當天 AVAILABLEGENERATION − TOTALDEMAND 的最小值"),
    FactorDefinition("net_interchange_mean_mw", "MW", "當天 NETINTERCHANGE 的平均；正值為 NSW 淨送出、負值為淨輸入"),
    FactorDefinition("gas_price_aud_per_gj", "AUD/GJ", "STTM 雪梨天然氣事前價，gas_date 與交易日同一天"),
    FactorDefinition("battery_power_mw", "MW", "NSW1 已併網電池放電功率加總的當月月底值"),
)


@dataclass(frozen=True)
class FactorSources:
    """組資料集用的四個來源。"""

    daily_revenue: DailyRevenueResult
    region_factors: RegionFactorResult
    gas_prices: dict[date, float]
    battery_power: dict[date, float]


@dataclass(frozen=True)
class ExcludedDay:
    """擬合期間內被排除的日子與原因。"""

    trading_date: date
    reason: str


@dataclass(frozen=True)
class FactorDataset:
    """對齊後的資料集：列為交易日，因素欄依 `FACTOR_DEFINITIONS` 的順序。"""

    trading_dates: tuple[date, ...]
    factor_values: np.ndarray
    revenue_values: np.ndarray
    excluded_days: tuple[ExcludedDay, ...]


def find_missing_reasons(trading_date: date, factor_sources: FactorSources) -> list[str]:
    """某天缺少哪些資料。

    Args:
        trading_date: 交易日。
        factor_sources: 四個來源。

    Returns:
        缺漏原因；四個來源都有值時為空清單。
    """
    missing_reasons: list[str] = []
    if trading_date in factor_sources.daily_revenue.incomplete_dates:
        missing_reasons.append("30 分鐘電價不足 48 段")
    elif trading_date not in factor_sources.daily_revenue.revenue_by_date:
        missing_reasons.append("沒有電價資料")
    run_count = factor_sources.region_factors.incomplete_run_counts.get(trading_date)
    if run_count is not None:
        missing_reasons.append(f"P5MIN 求解只有 {run_count} 次（應為 {FIVE_MINUTE_INTERVALS_PER_DAY} 次）")
    elif trading_date not in factor_sources.region_factors.factors_by_date:
        missing_reasons.append("沒有 P5MIN 區域解")
    if trading_date not in factor_sources.gas_prices:
        missing_reasons.append("沒有雪梨天然氣事前價")
    if trading_date not in factor_sources.battery_power:
        missing_reasons.append("當月月底沒有電池裝置量")
    return missing_reasons


def collect_factor_values(trading_date: date, factor_sources: FactorSources) -> DailyFactorValues:
    """取出某天的六個因素；呼叫前須確認四個來源都有值。

    Args:
        trading_date: 交易日。
        factor_sources: 四個來源。

    Returns:
        當天的因素原始值。
    """
    region_day = factor_sources.region_factors.factors_by_date[trading_date]
    return DailyFactorValues(
        demand_mean_mw=region_day.demand_mean_mw,
        evening_peak_demand_mw=region_day.evening_peak_demand_mw,
        supply_margin_min_mw=region_day.supply_margin_min_mw,
        net_interchange_mean_mw=region_day.net_interchange_mean_mw,
        gas_price_aud_per_gj=factor_sources.gas_prices[trading_date],
        battery_power_mw=factor_sources.battery_power[trading_date],
    )


def to_factor_row(daily_values: DailyFactorValues) -> list[float]:
    """依 `FACTOR_DEFINITIONS` 的順序排成一列。

    Args:
        daily_values: 一天的因素值。

    Returns:
        因素值清單。
    """
    return [getattr(daily_values, definition.factor_name) for definition in FACTOR_DEFINITIONS]


def list_candidate_dates(factor_sources: FactorSources) -> list[date]:
    """任一個來源有資料的日子。

    Args:
        factor_sources: 四個來源。

    Returns:
        排序後的日子。
    """
    candidate_dates = set(factor_sources.daily_revenue.revenue_by_date)
    candidate_dates |= set(factor_sources.daily_revenue.incomplete_dates)
    candidate_dates |= set(factor_sources.region_factors.factors_by_date)
    candidate_dates |= set(factor_sources.region_factors.incomplete_run_counts)
    candidate_dates |= set(factor_sources.gas_prices) | set(factor_sources.battery_power)
    return sorted(candidate_dates)


def list_excluded_days(period_start: date, period_end: date, factor_sources: FactorSources) -> tuple[ExcludedDay, ...]:
    """擬合期間內（含頭尾）缺資料的每一天與原因，包含所有來源都沒有資料的日子。

    Args:
        period_start: 期間第一天。
        period_end: 期間最後一天。
        factor_sources: 四個來源。

    Returns:
        依日期排序的排除日。
    """
    excluded_days: list[ExcludedDay] = []
    period_date = period_start
    while period_date <= period_end:
        missing_reasons = find_missing_reasons(period_date, factor_sources)
        if missing_reasons:
            excluded_days.append(ExcludedDay(period_date, REASON_SEPARATOR.join(missing_reasons)))
        period_date += ONE_DAY
    return tuple(excluded_days)


def build_factor_dataset(factor_sources: FactorSources) -> FactorDataset:
    """對齊收益與因素，決定擬合期間並記下期間內被排除的日子。

    Args:
        factor_sources: 四個來源。

    Returns:
        資料集。

    Raises:
        ValueError: 沒有任何一天四個來源都有值時。
    """
    included_dates = [
        candidate_date
        for candidate_date in list_candidate_dates(factor_sources)
        if not find_missing_reasons(candidate_date, factor_sources)
    ]
    if not included_dates:
        raise ValueError("沒有任何一天同時有收益與六個因素的資料")
    factor_rows = [to_factor_row(collect_factor_values(included_date, factor_sources)) for included_date in included_dates]
    revenue_by_date = factor_sources.daily_revenue.revenue_by_date
    return FactorDataset(
        trading_dates=tuple(included_dates),
        factor_values=np.array(factor_rows),
        revenue_values=np.array([revenue_by_date[included_date] for included_date in included_dates]),
        excluded_days=list_excluded_days(included_dates[0], included_dates[-1], factor_sources),
    )
