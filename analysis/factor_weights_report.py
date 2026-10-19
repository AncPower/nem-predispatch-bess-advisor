"""組出 `data/factor_weights.json` 的內容（純計算，不寫檔）。

- `monthly_baseline`：擬合期間內每個日曆月份（"01"–"12"，跨年合併）每日原始值的中位數。
- `latest_value`：擬合期間最後一個年月每日原始值的中位數；電池當月每天相同，即該月月底值。
  天然氣價與電池裝置量隨時間單調變化，跨年月份中位數不適合當它們的預測基準，#12 可改用這個值（2026-10-19 決定）。
"""

import statistics
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime

import numpy as np

from analysis.arbitrage_plan import BatterySpecification
from analysis.factor_dataset import FACTOR_DEFINITIONS, FactorDataset
from analysis.input_fingerprint import RawFileEntry, SourceFingerprint
from analysis.weight_solver import WeightSolution

SCHEMA_VERSION: int = 1
UTC_TIMESTAMP_FORMAT: str = "%Y-%m-%dT%H:%M:%SZ"
MONTH_KEY_FORMAT: str = "%m"
YEAR_MONTH_FORMAT: str = "%Y-%m"
TARGET_NAME: str = "daily_arbitrage_revenue_aud"
TARGET_TRANSFORM: str = "log1p"
PREDICTION_FORMULA: str = (
    "log1p(收益) = target.mean + target.standard_deviation × "
    "(model.intercept + model.scale × Σ weight × direction × (因素值 − mean) ÷ standard_deviation)"
)


@dataclass(frozen=True)
class PendingFactor:
    """尚未加入公式、權重視為 0 的因素。"""

    factor_name: str
    reason: str


PENDING_FACTORS: tuple[PendingFactor, ...] = (
    PendingFactor("special_events", "事件清單尚未整理，見 #14"),
    PendingFactor("temperature_anomaly", "Open-Meteo 歷史氣溫，之後的 PR 加入"),
    PendingFactor("solar_wind_generation", "AEMO 機組 SCADA，燃料類型的判斷表尚未確認"),
    PendingFactor("rooftop_pv_generation", "AEMO ROOFTOP_PV_ACTUAL，MEASUREMENT 與 SATELLITE 尚未選定"),
)


@dataclass(frozen=True)
class LatestValue:
    """最近一個年月與該月每日值的中位數。"""

    year_month: str
    value: float


@dataclass(frozen=True)
class ReportMetadata:
    """不來自資料的輸出欄位。"""

    generated_at: datetime
    solver_version: str
    battery_specification: BatterySpecification


def format_utc_timestamp(timestamp_value: datetime) -> str:
    """格式化成 ISO 8601 UTC（Z 結尾）。

    Args:
        timestamp_value: 帶時區的時間。

    Returns:
        例如 `2026-10-19T03:04:05Z`。

    Raises:
        ValueError: 時間沒有時區時。
    """
    if timestamp_value.tzinfo is None:
        raise ValueError(f"時間必須帶時區：{timestamp_value.isoformat()}")
    return timestamp_value.astimezone(UTC).strftime(UTC_TIMESTAMP_FORMAT)


def group_by_date_format(
    trading_dates: Sequence[date], column_values: np.ndarray, date_format: str
) -> dict[str, list[float]]:
    """依日期格式（月份或年月）把每日值分組。

    Args:
        trading_dates: 交易日。
        column_values: 與交易日對應的值。
        date_format: `strftime` 格式。

    Returns:
        依鍵排序的「鍵 → 值清單」。
    """
    grouped_values: defaultdict[str, list[float]] = defaultdict(list)
    for trading_date, column_value in zip(trading_dates, column_values, strict=True):
        grouped_values[trading_date.strftime(date_format)].append(float(column_value))
    return dict(sorted(grouped_values.items()))


def compute_monthly_baseline(trading_dates: Sequence[date], column_values: np.ndarray) -> dict[str, float]:
    """每個日曆月份的中位數（跨年合併）。

    Args:
        trading_dates: 交易日。
        column_values: 與交易日對應的值。

    Returns:
        「兩位數月份 → 中位數」，只含有資料的月份。
    """
    grouped_values = group_by_date_format(trading_dates, column_values, MONTH_KEY_FORMAT)
    return {month_key: statistics.median(month_values) for month_key, month_values in grouped_values.items()}


def compute_latest_value(trading_dates: Sequence[date], column_values: np.ndarray) -> LatestValue:
    """最後一個年月每日值的中位數。

    Args:
        trading_dates: 交易日。
        column_values: 與交易日對應的值。

    Returns:
        年月與中位數。
    """
    grouped_values = group_by_date_format(trading_dates, column_values, YEAR_MONTH_FORMAT)
    latest_year_month = max(grouped_values)
    return LatestValue(latest_year_month, statistics.median(grouped_values[latest_year_month]))


def build_period_section(factor_dataset: FactorDataset) -> dict[str, object]:
    """期間區段。

    Args:
        factor_dataset: 資料集。

    Returns:
        起訖日、天數與排除日。
    """
    return {
        "start_date": factor_dataset.trading_dates[0].isoformat(),
        "end_date": factor_dataset.trading_dates[-1].isoformat(),
        "day_count": len(factor_dataset.trading_dates),
        "excluded_days": [
            {"date": excluded_day.trading_date.isoformat(), "reason": excluded_day.reason}
            for excluded_day in factor_dataset.excluded_days
        ],
    }


def build_factor_entries(factor_dataset: FactorDataset, weight_solution: WeightSolution) -> list[dict[str, object]]:
    """每個因素一筆輸出。

    Args:
        factor_dataset: 資料集。
        weight_solution: 求解結果，順序同 `FACTOR_DEFINITIONS`。

    Returns:
        因素清單。
    """
    factor_entries: list[dict[str, object]] = []
    for column_index, factor_definition in enumerate(FACTOR_DEFINITIONS):
        factor_fit = weight_solution.factor_fits[column_index]
        column_values = factor_dataset.factor_values[:, column_index]
        factor_entries.append(
            {
                **asdict(factor_definition),
                "weight": factor_fit.factor_weight,
                "direction": factor_fit.direction,
                "correlation": factor_fit.correlation,
                "mean": factor_fit.factor_mean,
                "standard_deviation": factor_fit.factor_standard_deviation,
                "monthly_baseline": compute_monthly_baseline(factor_dataset.trading_dates, column_values),
                "latest_value": asdict(compute_latest_value(factor_dataset.trading_dates, column_values)),
            }
        )
    return factor_entries


def build_fingerprint_section(
    source_fingerprint: SourceFingerprint, raw_manifest: Sequence[RawFileEntry]
) -> dict[str, object]:
    """輸入指紋區段。

    Args:
        source_fingerprint: 程式與外部資料的指紋。
        raw_manifest: 原始資料檔清單。

    Returns:
        指紋與原始檔清單。
    """
    return {**asdict(source_fingerprint), "raw_input_files": [asdict(raw_entry) for raw_entry in raw_manifest]}


def build_report_document(
    factor_dataset: FactorDataset,
    weight_solution: WeightSolution,
    source_fingerprint: SourceFingerprint,
    raw_manifest: Sequence[RawFileEntry],
    report_metadata: ReportMetadata,
) -> dict[str, object]:
    """組出完整的 JSON 文件內容。

    Args:
        factor_dataset: 資料集。
        weight_solution: 求解結果。
        source_fingerprint: 程式與外部資料的指紋。
        raw_manifest: 原始資料檔清單。
        report_metadata: 產生時間、求解器版本與電池規格。

    Returns:
        可直接 `json.dump` 的字典。
    """
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": format_utc_timestamp(report_metadata.generated_at),
        "period": build_period_section(factor_dataset),
        "battery_specification": asdict(report_metadata.battery_specification),
        "target": {
            "name": TARGET_NAME,
            "transform": TARGET_TRANSFORM,
            "mean": weight_solution.target_mean,
            "standard_deviation": weight_solution.target_standard_deviation,
            "median_aud": float(np.median(factor_dataset.revenue_values)),
        },
        "model": {
            "objective": "least_absolute_deviation",
            "solver": "highs",
            "solver_version": report_metadata.solver_version,
            "intercept": weight_solution.intercept,
            "scale": weight_solution.scale,
            "prediction_formula": PREDICTION_FORMULA,
        },
        "factors": build_factor_entries(factor_dataset, weight_solution),
        "pending_factors": [{**asdict(pending_factor), "weight": 0} for pending_factor in PENDING_FACTORS],
        "fit_quality": asdict(weight_solution.fit_quality),
        "input_fingerprint": build_fingerprint_section(source_fingerprint, raw_manifest),
    }
