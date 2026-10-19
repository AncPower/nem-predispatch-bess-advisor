"""命令列進入點：讀資料、算每日收益與因素、求權重，輸出 `data/factor_weights.json`。

執行：`NSW_DISPATCH_INPUT_DIRECTORY=<input/ 目錄> uv run python -m analysis.build_factor_weights`
成功時結束碼為 0；失敗時把錯誤寫到 stderr，結束碼為 1。
"""

import argparse
import json
import logging
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from analysis.arbitrage_revenue import DEFAULT_BATTERY_SPEC, average_into_half_hours, select_best_plan
from analysis.battery_fleet import BATTERY_POWER_FACTOR, month_end_power_by_date
from analysis.daily_factors import DEMAND_MEAN_FACTOR, EVENING_PEAK_DEMAND_FACTOR, NET_INTERCHANGE_FACTOR, SUPPLY_MARGIN_FACTOR, summarize_daily_factors
from analysis.factor_weights import FactorWeight, FactorWeightFit, fit_factor_weights
from analysis.local_sources import REPOSITORY_ROOT, read_battery_units, read_daily_five_minute_prices, read_gas_prices, read_region_snapshots, resolve_input_directory

GAS_PRICE_FACTOR = "gas_price_aud_per_gj"
DEFAULT_OUTPUT_PATH = REPOSITORY_ROOT / "data" / "factor_weights.json"
UTC_TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
OUTPUT_DECIMAL_PLACES = 6
REVENUE_TRANSFORM_DESCRIPTION = (
    "收益取 log(1 + AUD) 後轉 z 分數。預測收益（AUD）= exp(log_mean + log_standard_deviation × "
    "(intercept + Σ weight × direction × (因素值 − mean) ÷ standard_deviation)) − 1"
)

pipeline_logger = logging.getLogger("analysis.build_factor_weights")


@dataclass(frozen=True)
class FactorDescription:
    """寫進輸出檔的因素說明。"""

    display_label: str
    unit_name: str
    source_description: str


FACTOR_DESCRIPTIONS: dict[str, FactorDescription] = {
    DEMAND_MEAN_FACTOR: FactorDescription("日均需求", "MW", "AEMO P5MIN TOTALDEMAND"),
    EVENING_PEAK_DEMAND_FACTOR: FactorDescription("晚間尖峰需求（17:00–21:00 最大值）", "MW", "AEMO P5MIN TOTALDEMAND"),
    SUPPLY_MARGIN_FACTOR: FactorDescription("供給餘裕（可用發電量 − 需求的當日最小值）", "MW", "AEMO P5MIN AVAILABLEGENERATION、TOTALDEMAND"),
    NET_INTERCHANGE_FACTOR: FactorDescription("淨進出口日均", "MW", "AEMO P5MIN NETINTERCHANGE"),
    GAS_PRICE_FACTOR: FactorDescription("雪梨天然氣事前價", "AUD/GJ", "AEMO STTM（data/external/sttm_sydney_daily_price.csv）"),
    BATTERY_POWER_FACTOR: FactorDescription("NSW 電池放電功率（月底值）", "MW", "AEMO MMSDM DUDETAIL（data/external/nsw_battery_units.csv）"),
}


def compute_daily_revenue(prices_by_date: Mapping[date, Sequence[float]]) -> dict[date, float]:
    """每天以 5 MW／20 MWh、MLF 1 的最佳計畫收益（AUD）。

    Args:
        prices_by_date: 日期對應當天 288 個 5 分鐘電價。

    Returns:
        日期對應的收益。
    """
    return {price_date: select_best_plan(average_into_half_hours(day_prices), DEFAULT_BATTERY_SPEC).total_value for price_date, day_prices in prices_by_date.items()}


def collect_factor_series(input_directory: Path, revenue_dates: Sequence[date]) -> dict[str, dict[date, float]]:
    """讀取並彙整六個因素的每日值。

    Args:
        input_directory: AEMO 資料的 `input/` 目錄。
        revenue_dates: 有收益的日期，用來給電池月底值。

    Returns:
        因素名稱對應「日期 → 值」。
    """
    daily_summary = summarize_daily_factors(read_region_snapshots(input_directory))
    if daily_summary.incomplete_dates:
        pipeline_logger.warning("event=incomplete_days count=%d first_dates=%s", len(daily_summary.incomplete_dates), [str(skipped_date) for skipped_date in daily_summary.incomplete_dates[:5]])
    factor_series: dict[str, dict[date, float]] = {
        factor_name: {factor_date: day_values[factor_name] for factor_date, day_values in daily_summary.factor_values_by_date.items()}
        for factor_name in (DEMAND_MEAN_FACTOR, EVENING_PEAK_DEMAND_FACTOR, SUPPLY_MARGIN_FACTOR, NET_INTERCHANGE_FACTOR)
    }
    factor_series[GAS_PRICE_FACTOR] = read_gas_prices()
    factor_series[BATTERY_POWER_FACTOR] = month_end_power_by_date(read_battery_units(), revenue_dates)
    return factor_series


def round_output(raw_value: float) -> float:
    """輸出檔的數值取到小數第 6 位。

    Args:
        raw_value: 原始值。

    Returns:
        四捨五入後的值。
    """
    return round(raw_value, OUTPUT_DECIMAL_PLACES)


def build_output_document(weight_fit: FactorWeightFit, generated_at: datetime) -> dict[str, Any]:
    """組出 `factor_weights.json` 的內容。

    Args:
        weight_fit: 擬合結果。
        generated_at: 產生時間（UTC）。

    Returns:
        可直接序列化成 JSON 的字典。
    """
    return {
        "generated_at": generated_at.strftime(UTC_TIMESTAMP_FORMAT),
        "data_period": {"start": weight_fit.fit_dates[0].isoformat(), "end": weight_fit.fit_dates[-1].isoformat(), "day_count": len(weight_fit.fit_dates)},
        "battery_spec": asdict(DEFAULT_BATTERY_SPEC),
        "revenue": {
            "transform": REVENUE_TRANSFORM_DESCRIPTION,
            "log_mean": round_output(weight_fit.revenue_log_mean),
            "log_standard_deviation": round_output(weight_fit.revenue_log_standard_deviation),
            "median_aud": round_output(weight_fit.revenue_median_aud),
        },
        "intercept": round_output(weight_fit.intercept_value),
        "fit_quality": {
            "r_squared": round_output(weight_fit.r_squared),
            "mean_absolute_error_standardized": round_output(weight_fit.mean_absolute_error_standardized),
            "mean_absolute_error_aud": round_output(weight_fit.mean_absolute_error_aud),
        },
        "factors": [
            build_factor_entry(factor_weight, rounded_weight)
            for factor_weight, rounded_weight in zip(weight_fit.factor_weights, round_weights_to_unit_sum([factor_weight.weight_value for factor_weight in weight_fit.factor_weights]))
        ],
    }


def round_weights_to_unit_sum(weight_values: Sequence[float]) -> list[float]:
    """權重取到小數第 6 位，並把捨入誤差補到最大的權重，讓輸出的權重加總剛好為 1。

    Args:
        weight_values: 加總為 1 的原始權重。

    Returns:
        取整後的權重，與輸入同順序。
    """
    rounded_weights = [round_output(weight_value) for weight_value in weight_values]
    largest_index = max(range(len(rounded_weights)), key=lambda weight_index: rounded_weights[weight_index])
    rounded_weights[largest_index] = round_output(1 - sum(rounded_weights) + rounded_weights[largest_index])
    return rounded_weights


def build_factor_entry(factor_weight: FactorWeight, rounded_weight: float) -> dict[str, Any]:
    """單一因素在輸出檔中的內容。

    Args:
        factor_weight: 單一因素的擬合結果。
        rounded_weight: 輸出用的權重（已處理捨入誤差）。

    Returns:
        因素的字典。
    """
    factor_description = FACTOR_DESCRIPTIONS[factor_weight.factor_name]
    return {
        "factor_name": factor_weight.factor_name,
        "label": factor_description.display_label,
        "unit": factor_description.unit_name,
        "source": factor_description.source_description,
        "weight": rounded_weight,
        "direction": factor_weight.direction_sign,
        "spearman_correlation": round_output(factor_weight.spearman_correlation),
        "mean": round_output(factor_weight.factor_mean),
        "standard_deviation": round_output(factor_weight.factor_standard_deviation),
        "monthly_baseline": {month_key: round_output(month_value) for month_key, month_value in factor_weight.monthly_baseline.items()},
    }


def run_pipeline(output_path: Path, generated_at: datetime) -> None:
    """執行整條流程並寫出結果；同一份資料與產生時間重跑，輸出內容相同。

    Args:
        output_path: 輸出檔路徑。
        generated_at: 寫進輸出檔的產生時間（UTC）。
    """
    input_directory = resolve_input_directory()
    revenue_by_date = compute_daily_revenue(read_daily_five_minute_prices(input_directory))
    pipeline_logger.info("event=revenue_computed day_count=%d", len(revenue_by_date))
    factor_series = collect_factor_series(input_directory, sorted(revenue_by_date))
    weight_fit = fit_factor_weights(factor_series, revenue_by_date)
    output_document = build_output_document(weight_fit, generated_at)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output_document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    pipeline_logger.info("event=output_written path=%s day_count=%d r_squared=%.4f", output_path, len(weight_fit.fit_dates), weight_fit.r_squared)


def configure_logging() -> None:
    """key=value 格式的日誌，時間為 UTC。"""
    logging.basicConfig(level=logging.INFO, format="time=%(asctime)s level=%(levelname)s %(message)s", datefmt=UTC_TIMESTAMP_FORMAT, stream=sys.stderr)
    logging.Formatter.converter = time.gmtime


def main(argument_values: Sequence[str] | None = None) -> int:
    """命令列進入點。

    Args:
        argument_values: 命令列參數；None 時讀 `sys.argv`。

    Returns:
        結束碼：成功 0，失敗 1。
    """
    argument_parser = argparse.ArgumentParser(description="求各因素對 NSW1 每日套利收益的權重")
    argument_parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_PATH, help="輸出檔路徑")
    parsed_arguments = argument_parser.parse_args(argument_values)
    configure_logging()
    try:
        run_pipeline(parsed_arguments.output, datetime.now(UTC))
    except (ValueError, RuntimeError, OSError) as pipeline_error:
        pipeline_logger.error("event=pipeline_failed error=%s", pipeline_error)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
