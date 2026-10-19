"""產生 `data/factor_weights.json` 的進入點。

執行：`NEM_INPUT_DIRECTORY=<原始資料目錄> uv run python -m analysis.build_factor_weights`

原始資料目錄底下每個期間資料夾（例如 `2024-01_2024-12/`）都要有 `trading_price.csv` 與
`p5min_region_solution.csv`。成功時結束碼為 0，失敗時把錯誤寫到 stderr 並以 1 結束。
"""

import itertools
import json
import logging
import os
import sys
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path

from analysis.arbitrage_plan import BatterySpecification
from analysis.daily_revenue import average_half_hour_prices, compute_daily_revenue, merge_interval_prices
from analysis.external_factors import daily_battery_power, parse_battery_units, parse_gas_prices, read_csv_records
from analysis.factor_dataset import FactorSources, build_factor_dataset
from analysis.factor_weights_report import ReportMetadata, build_report_document
from analysis.input_fingerprint import build_raw_manifest, compute_source_fingerprint
from analysis.mms_csv import MmsTableName, iterate_mms_file
from analysis.region_factors import collect_region_snapshots, compute_region_day_factors
from analysis.weight_solver import solve_factor_weights

INPUT_DIRECTORY_VARIABLE: str = "NEM_INPUT_DIRECTORY"
REGION_ID: str = "NSW1"
REVENUE_BATTERY_SPECIFICATION = BatterySpecification(power_mw=5, capacity_mwh=20, marginal_loss_factor=1)
REPOSITORY_ROOT: Path = Path(__file__).resolve().parents[1]
GAS_PRICE_RELATIVE_PATH: str = "data/external/sttm_sydney_daily_price.csv"
BATTERY_UNITS_RELATIVE_PATH: str = "data/external/nsw_battery_units.csv"
EXTERNAL_INPUT_RELATIVE_PATHS: tuple[str, ...] = (GAS_PRICE_RELATIVE_PATH, BATTERY_UNITS_RELATIVE_PATH)
OUTPUT_RELATIVE_PATH: str = "data/factor_weights.json"
TRADING_PRICE_FILE_NAME: str = "trading_price.csv"
REGION_SOLUTION_FILE_NAME: str = "p5min_region_solution.csv"
TRADING_PRICE_TABLE = MmsTableName(group_name="TRADING", table_name="PRICE")
REGION_SOLUTION_TABLE = MmsTableName(group_name="P5MIN", table_name="REGIONSOLUTION")
SOLVER_PACKAGE_NAME: str = "highspy"
REGENERATE_COMMAND: str = f"{INPUT_DIRECTORY_VARIABLE}=<原始資料目錄> uv run python -m analysis.build_factor_weights"
UTC_LOG_FORMAT: str = "%Y-%m-%dT%H:%M:%SZ"
FAILURE_EXIT_CODE: int = 1

logger = logging.getLogger("analysis.build_factor_weights")


@dataclass(frozen=True)
class RawInputFiles:
    """各期間資料夾的兩種原始檔，依資料夾名稱排序。"""

    trading_price_files: tuple[Path, ...]
    region_solution_files: tuple[Path, ...]

    def all_files(self) -> tuple[Path, ...]:
        """全部原始檔。

        Returns:
            電價檔在前、區域解檔在後。
        """
        return self.trading_price_files + self.region_solution_files


def read_input_directory() -> Path:
    """由環境變數讀取原始資料目錄。

    Returns:
        目錄路徑。

    Raises:
        ValueError: 環境變數沒有設定，或不是目錄時。
    """
    directory_text = os.getenv(INPUT_DIRECTORY_VARIABLE)
    if not directory_text:
        raise ValueError(f"沒有設定環境變數 {INPUT_DIRECTORY_VARIABLE}；執行方式：{REGENERATE_COMMAND}")
    input_directory = Path(directory_text)
    if not input_directory.is_dir():
        raise ValueError(f"{INPUT_DIRECTORY_VARIABLE} 不是目錄：{input_directory}")
    return input_directory


def find_raw_input_files(input_directory: Path) -> RawInputFiles:
    """找出每個期間資料夾的電價檔與區域解檔。

    Args:
        input_directory: 原始資料目錄。

    Returns:
        原始檔清單。

    Raises:
        ValueError: 沒有任何期間資料夾，或某個資料夾缺其中一個檔案時。
    """
    period_directories = sorted(child_path for child_path in input_directory.iterdir() if child_path.is_dir())
    if not period_directories:
        raise ValueError(f"{input_directory} 底下沒有期間資料夾")
    for period_directory in period_directories:
        for file_name in (TRADING_PRICE_FILE_NAME, REGION_SOLUTION_FILE_NAME):
            if not (period_directory / file_name).is_file():
                raise ValueError(f"{period_directory} 缺少 {file_name}")
    return RawInputFiles(
        trading_price_files=tuple(period_directory / TRADING_PRICE_FILE_NAME for period_directory in period_directories),
        region_solution_files=tuple(period_directory / REGION_SOLUTION_FILE_NAME for period_directory in period_directories),
    )


def iterate_records(file_paths: tuple[Path, ...], table_name: MmsTableName) -> Iterator[dict[str, str]]:
    """依序串流讀取多個 MMS 檔的同一張表。

    Args:
        file_paths: 檔案路徑。
        table_name: 表名。

    Yields:
        每個資料列一筆。
    """
    yield from itertools.chain.from_iterable(iterate_mms_file(file_path, table_name) for file_path in file_paths)


def load_factor_sources(raw_input_files: RawInputFiles, repository_root: Path) -> FactorSources:
    """讀入全部來源並算出每日收益與各因素。

    Args:
        raw_input_files: 原始檔清單。
        repository_root: repo 根目錄，用來找 `data/external/`。

    Returns:
        組資料集用的四個來源。
    """
    price_records = iterate_records(raw_input_files.trading_price_files, TRADING_PRICE_TABLE)
    five_minute_prices = merge_interval_prices(price_records, REGION_ID)
    daily_revenue = compute_daily_revenue(average_half_hour_prices(five_minute_prices), REVENUE_BATTERY_SPECIFICATION)
    logger.info(
        "step=daily_revenue days=%d incomplete_days=%d",
        len(daily_revenue.revenue_by_date),
        len(daily_revenue.incomplete_dates),
    )
    region_records = iterate_records(raw_input_files.region_solution_files, REGION_SOLUTION_TABLE)
    region_factors = compute_region_day_factors(collect_region_snapshots(region_records, REGION_ID))
    logger.info(
        "step=region_factors days=%d incomplete_days=%d",
        len(region_factors.factors_by_date),
        len(region_factors.incomplete_run_counts),
    )
    gas_prices = parse_gas_prices(read_csv_records(repository_root / GAS_PRICE_RELATIVE_PATH))
    battery_units = parse_battery_units(read_csv_records(repository_root / BATTERY_UNITS_RELATIVE_PATH))
    battery_power = daily_battery_power(battery_units, daily_revenue.revenue_by_date)
    logger.info("step=external_factors gas_days=%d battery_days=%d", len(gas_prices), len(battery_power))
    return FactorSources(daily_revenue, region_factors, gas_prices, battery_power)


def build_document(input_directory: Path, repository_root: Path, generated_at: datetime) -> dict[str, object]:
    """從原始資料算出完整的 JSON 文件內容。

    Args:
        input_directory: 原始資料目錄。
        repository_root: repo 根目錄。
        generated_at: 產生時間（帶時區）。

    Returns:
        JSON 文件內容。
    """
    raw_input_files = find_raw_input_files(input_directory)
    factor_dataset = build_factor_dataset(load_factor_sources(raw_input_files, repository_root))
    logger.info(
        "step=factor_dataset days=%d excluded_days=%d",
        len(factor_dataset.trading_dates),
        len(factor_dataset.excluded_days),
    )
    weight_solution = solve_factor_weights(factor_dataset.factor_values, factor_dataset.revenue_values)
    logger.info(
        "step=weight_solver r_squared=%.4f scale=%.4f", weight_solution.fit_quality.r_squared, weight_solution.scale
    )
    return build_report_document(
        factor_dataset,
        weight_solution,
        compute_source_fingerprint(repository_root, EXTERNAL_INPUT_RELATIVE_PATHS),
        build_raw_manifest(raw_input_files.all_files(), input_directory),
        ReportMetadata(generated_at, version(SOLVER_PACKAGE_NAME), REVENUE_BATTERY_SPECIFICATION),
    )


def write_report_document(report_document: dict[str, object], output_path: Path) -> None:
    """先寫暫存檔再改名，避免中途失敗留下半份 JSON。

    Args:
        report_document: JSON 文件內容。
        output_path: 輸出路徑。
    """
    temporary_path = output_path.with_suffix(".json.tmp")
    temporary_path.write_text(json.dumps(report_document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary_path.replace(output_path)


def configure_logging() -> None:
    """設定 `key=value` 格式、UTC 時間的日誌，輸出到 stderr。"""
    log_handler = logging.StreamHandler(sys.stderr)
    log_formatter = logging.Formatter("%(asctime)s level=%(levelname)s %(message)s", datefmt=UTC_LOG_FORMAT)
    log_formatter.converter = time.gmtime
    log_handler.setFormatter(log_formatter)
    logging.basicConfig(level=logging.INFO, handlers=[log_handler], force=True)


def main() -> int:
    """執行整條流程並寫出 JSON。

    Returns:
        結束碼：成功 0，失敗 1。
    """
    configure_logging()
    started_at = time.monotonic()
    output_path = REPOSITORY_ROOT / OUTPUT_RELATIVE_PATH
    try:
        report_document = build_document(read_input_directory(), REPOSITORY_ROOT, datetime.now(UTC))
        write_report_document(report_document, output_path)
    except (ValueError, OSError, RuntimeError) as build_error:
        logger.error("step=build_factor_weights status=failed error=%s", build_error)
        return FAILURE_EXIT_CODE
    elapsed_seconds = time.monotonic() - started_at
    logger.info("step=build_factor_weights status=done output=%s seconds=%.1f", output_path, elapsed_seconds)
    return 0


if __name__ == "__main__":
    sys.exit(main())
