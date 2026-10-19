"""讀取本機與 repo 內的資料檔，在邊界轉成型別明確的資料。

- AEMO 電價與區域資料：`nsw-dispatch-bess-strategy` 的 `input/`，路徑由環境變數設定。
  各期間資料夾的期間互相重疊，同一個時段以時間戳記去除重複。
- 天然氣價格與電池機組：本 repo 的 `data/external/`。
各來源的網址、內容與意義見 `docs/data_sources.md`。
"""

import csv
import os
from collections import defaultdict
from collections.abc import Iterator
from datetime import date, datetime
from pathlib import Path

from analysis.aemo_csv import iterate_selected_columns, parse_aemo_timestamp
from analysis.battery_fleet import BatteryUnitRecord
from analysis.daily_factors import FIVE_MINUTE_INTERVALS_PER_DAY, RegionSnapshot, interval_start_date

INPUT_DIRECTORY_VARIABLE = "NSW_DISPATCH_INPUT_DIRECTORY"
TARGET_REGION_ID = "NSW1"
NON_INTERVENTION_FLAG = "0"
TRADING_PRICE_FILE_NAME = "trading_price.csv"
REGION_SOLUTION_FILE_NAME = "p5min_region_solution.csv"
TRADING_PRICE_COLUMNS = ("SETTLEMENTDATE", "REGIONID", "RRP")
REGION_SOLUTION_COLUMNS = ("RUN_DATETIME", "INTERVENTION", "INTERVAL_DATETIME", "REGIONID", "TOTALDEMAND", "AVAILABLEGENERATION", "NETINTERCHANGE")
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
GAS_PRICE_PATH = REPOSITORY_ROOT / "data" / "external" / "sttm_sydney_daily_price.csv"
BATTERY_UNITS_PATH = REPOSITORY_ROOT / "data" / "external" / "nsw_battery_units.csv"
GAS_PRICE_COLUMNS = ("gas_date", "exante_price_aud_per_gj")
BATTERY_UNIT_COLUMNS = ("duid", "effective_date", "max_capacity_mw", "max_storage_capacity_mwh", "region_start_date", "region_end_date")


def resolve_input_directory() -> Path:
    """從環境變數取得 AEMO 資料的 `input/` 目錄。

    Returns:
        存在的目錄路徑。

    Raises:
        ValueError: 環境變數未設定，或路徑不是目錄時。
    """
    directory_text = os.getenv(INPUT_DIRECTORY_VARIABLE)
    if not directory_text:
        raise ValueError(f"請設定環境變數 {INPUT_DIRECTORY_VARIABLE}，指向 nsw-dispatch-bess-strategy 的 input/ 目錄")
    input_directory = Path(directory_text).expanduser()
    if not input_directory.is_dir():
        raise ValueError(f"{INPUT_DIRECTORY_VARIABLE} 指向的路徑不是目錄：{input_directory}")
    return input_directory


def find_data_files(input_directory: Path, file_name: str) -> list[Path]:
    """各期間資料夾中名為 `file_name` 的檔案，依資料夾名稱排序。

    Args:
        input_directory: `input/` 目錄。
        file_name: 檔名。

    Returns:
        檔案路徑。

    Raises:
        ValueError: 找不到任何檔案時。
    """
    data_files = sorted(input_directory.glob(f"*/{file_name}"))
    if not data_files:
        raise ValueError(f"{input_directory} 底下沒有任何 {file_name}")
    return data_files


def parse_number(raw_text: str, field_name: str, source_path: Path) -> float:
    """把欄位字串轉成數字；失敗時指出檔案與欄位。

    Args:
        raw_text: 欄位字串。
        field_name: 欄位名稱。
        source_path: 來源檔案。

    Returns:
        數值。

    Raises:
        ValueError: 不是數字時。
    """
    try:
        return float(raw_text)
    except ValueError as parse_error:
        raise ValueError(f"{source_path} 的 {field_name} 不是數字：{raw_text!r}") from parse_error


def read_daily_five_minute_prices(input_directory: Path) -> dict[date, list[float]]:
    """NSW1 每天 288 個 5 分鐘電價（依時間排序）；不足 288 個的日子不列入。

    Args:
        input_directory: `input/` 目錄。

    Returns:
        日期對應當天的 5 分鐘電價。
    """
    price_by_interval_end: dict[datetime, float] = {}
    for price_path in find_data_files(input_directory, TRADING_PRICE_FILE_NAME):
        for row_values in iterate_selected_columns(price_path, TRADING_PRICE_COLUMNS):
            if row_values["REGIONID"] != TARGET_REGION_ID:
                continue
            price_by_interval_end[parse_aemo_timestamp(row_values["SETTLEMENTDATE"])] = parse_number(row_values["RRP"], "RRP", price_path)
    prices_by_date: dict[date, list[float]] = defaultdict(list)
    for interval_end in sorted(price_by_interval_end):
        prices_by_date[interval_start_date(interval_end)].append(price_by_interval_end[interval_end])
    return {price_date: day_prices for price_date, day_prices in prices_by_date.items() if len(day_prices) == FIVE_MINUTE_INTERVALS_PER_DAY}


def read_region_snapshots(input_directory: Path) -> list[RegionSnapshot]:
    """NSW1 每個 5 分鐘時段的區域狀態。

    取每次 P5MIN 求解的第一個時段（求解時間 = 時段時間），它最接近實際調度；排除介入（INTERVENTION ≠ 0）。

    Args:
        input_directory: `input/` 目錄。

    Returns:
        不重複的時段狀態。
    """
    snapshot_by_interval_end: dict[datetime, RegionSnapshot] = {}
    for solution_path in find_data_files(input_directory, REGION_SOLUTION_FILE_NAME):
        for region_snapshot in iterate_region_snapshots(solution_path):
            snapshot_by_interval_end[region_snapshot.interval_end] = region_snapshot
    return list(snapshot_by_interval_end.values())


def iterate_region_snapshots(solution_path: Path) -> Iterator[RegionSnapshot]:
    """逐列讀出單一 P5MIN 檔中符合條件的時段狀態。

    Args:
        solution_path: `p5min_region_solution.csv` 路徑。

    Returns:
        時段狀態的迭代器。
    """
    for row_values in iterate_selected_columns(solution_path, REGION_SOLUTION_COLUMNS):
        if row_values["REGIONID"] != TARGET_REGION_ID or row_values["INTERVENTION"] != NON_INTERVENTION_FLAG:
            continue
        if row_values["RUN_DATETIME"] != row_values["INTERVAL_DATETIME"]:
            continue
        yield RegionSnapshot(
            interval_end=parse_aemo_timestamp(row_values["INTERVAL_DATETIME"]),
            total_demand=parse_number(row_values["TOTALDEMAND"], "TOTALDEMAND", solution_path),
            available_generation=parse_number(row_values["AVAILABLEGENERATION"], "AVAILABLEGENERATION", solution_path),
            net_interchange=parse_number(row_values["NETINTERCHANGE"], "NETINTERCHANGE", solution_path),
        )


def read_csv_records(csv_path: Path, required_columns: tuple[str, ...]) -> list[dict[str, str]]:
    """讀取一般 CSV（第一列為欄位名稱），並確認必要欄位都在。

    Args:
        csv_path: CSV 路徑。
        required_columns: 必要欄位。

    Returns:
        每一列的 `{欄位名稱: 字串值}`。

    Raises:
        ValueError: 缺少必要欄位時，訊息帶出檔案與欄位。
    """
    with csv_path.open(newline="", encoding="utf-8") as input_file:
        csv_reader = csv.DictReader(input_file)
        missing_columns = [column_name for column_name in required_columns if column_name not in (csv_reader.fieldnames or [])]
        if missing_columns:
            raise ValueError(f"{csv_path} 缺少欄位：{missing_columns}")
        return list(csv_reader)


def parse_iso_date(raw_text: str, field_name: str, source_path: Path) -> date:
    """把 `YYYY-MM-DD` 字串轉成日期；失敗時指出檔案與欄位。

    Args:
        raw_text: 欄位字串。
        field_name: 欄位名稱。
        source_path: 來源檔案。

    Returns:
        日期。

    Raises:
        ValueError: 格式不符時。
    """
    try:
        return date.fromisoformat(raw_text)
    except ValueError as parse_error:
        raise ValueError(f"{source_path} 的 {field_name} 不是 YYYY-MM-DD：{raw_text!r}") from parse_error


def read_gas_prices(gas_price_path: Path = GAS_PRICE_PATH) -> dict[date, float]:
    """雪梨天然氣每日事前價（AUD/GJ）。

    Args:
        gas_price_path: `sttm_sydney_daily_price.csv` 路徑。

    Returns:
        天然氣日對應的事前價。
    """
    return {
        parse_iso_date(row_values["gas_date"], "gas_date", gas_price_path): parse_number(row_values["exante_price_aud_per_gj"], "exante_price_aud_per_gj", gas_price_path)
        for row_values in read_csv_records(gas_price_path, GAS_PRICE_COLUMNS)
    }


def read_battery_units(battery_units_path: Path = BATTERY_UNITS_PATH) -> list[BatteryUnitRecord]:
    """NSW 電池機組的容量記錄。

    Args:
        battery_units_path: `nsw_battery_units.csv` 路徑。

    Returns:
        機組容量記錄。
    """
    return [
        BatteryUnitRecord(
            duid=row_values["duid"],
            effective_date=parse_iso_date(row_values["effective_date"], "effective_date", battery_units_path),
            max_capacity_mw=parse_number(row_values["max_capacity_mw"], "max_capacity_mw", battery_units_path),
            max_storage_capacity_mwh=parse_number(row_values["max_storage_capacity_mwh"], "max_storage_capacity_mwh", battery_units_path),
            region_start_date=parse_iso_date(row_values["region_start_date"], "region_start_date", battery_units_path),
            region_end_date=parse_iso_date(row_values["region_end_date"], "region_end_date", battery_units_path),
        )
        for row_values in read_csv_records(battery_units_path, BATTERY_UNIT_COLUMNS)
    ]
