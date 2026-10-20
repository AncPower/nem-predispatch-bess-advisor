"""產生 `data/daily_summary.json` 的進入點（#30、roadmap L1）。

執行：`NEM_INPUT_DIRECTORY=<原始資料目錄> uv run python -m analysis.build_daily_summary`

原始資料目錄與 `analysis.build_factor_weights` 相同；這裡只讀每個期間資料夾的 `trading_price.csv`。
成功時結束碼為 0，失敗時把錯誤寫到 stderr 並以 1 結束。
"""

import logging
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from analysis.battery_configuration import BATTERY_CONFIGURATION_RELATIVE_PATH, read_battery_specification
from analysis.build_factor_weights import (
    FAILURE_EXIT_CODE,
    INPUT_DIRECTORY_VARIABLE,
    REGION_ID,
    REPOSITORY_ROOT,
    TRADING_PRICE_TABLE,
    configure_logging,
    find_raw_input_files,
    iterate_records,
    read_input_directory,
    write_report_document,
)
from analysis.daily_revenue import (
    average_half_hour_prices,
    compute_daily_plans,
    count_five_minute_prices_by_trading_date,
    merge_interval_prices,
)
from analysis.daily_summary_report import SummaryMetadata, SummarySources, build_summary_document
from analysis.input_fingerprint import build_raw_manifest, compute_source_fingerprint

EXTERNAL_INPUT_RELATIVE_PATHS: tuple[str, ...] = (BATTERY_CONFIGURATION_RELATIVE_PATH,)
OUTPUT_RELATIVE_PATH: str = "data/daily_summary.json"
REGENERATE_COMMAND: str = f"{INPUT_DIRECTORY_VARIABLE}=<原始資料目錄> uv run python -m analysis.build_daily_summary"

pipeline_logger: logging.Logger = logging.getLogger("analysis.build_daily_summary")


def build_document(input_directory: Path, repository_root: Path, generated_at: datetime) -> dict[str, object]:
    """從原始電價算出完整的 JSON 文件內容。

    Args:
        input_directory: 原始資料目錄。
        repository_root: repo 根目錄，用來找 `config/battery.json` 與 `analysis/`。
        generated_at: 產生時間（帶時區）。

    Returns:
        JSON 文件內容。
    """
    trading_price_files = find_raw_input_files(input_directory).trading_price_files
    battery_specification = read_battery_specification(repository_root / BATTERY_CONFIGURATION_RELATIVE_PATH)
    five_minute_prices = merge_interval_prices(iterate_records(trading_price_files, TRADING_PRICE_TABLE), REGION_ID)
    daily_plans = compute_daily_plans(average_half_hour_prices(five_minute_prices), battery_specification)
    pipeline_logger.info(
        "step=daily_plans days=%d incomplete_days=%d", len(daily_plans.plans_by_date), len(daily_plans.incomplete_dates)
    )
    summary_sources = SummarySources(REGION_ID, daily_plans, count_five_minute_prices_by_trading_date(five_minute_prices))
    return build_summary_document(
        summary_sources,
        compute_source_fingerprint(repository_root, EXTERNAL_INPUT_RELATIVE_PATHS),
        build_raw_manifest(trading_price_files, input_directory),
        SummaryMetadata(generated_at, battery_specification),
    )


def main() -> int:
    """執行整條流程並寫出 JSON。

    Returns:
        結束碼：成功 0，失敗 1。
    """
    configure_logging()
    started_at = time.monotonic()
    output_path = REPOSITORY_ROOT / OUTPUT_RELATIVE_PATH
    try:
        summary_document = build_document(read_input_directory(), REPOSITORY_ROOT, datetime.now(UTC))
        write_report_document(summary_document, output_path)
    except (ValueError, OSError, RuntimeError) as build_error:
        pipeline_logger.error(
            "step=build_daily_summary status=failed error=%s rerun=%s", build_error, REGENERATE_COMMAND
        )
        return FAILURE_EXIT_CODE
    elapsed_seconds = time.monotonic() - started_at
    pipeline_logger.info("step=build_daily_summary status=done output=%s seconds=%.1f", output_path, elapsed_seconds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
