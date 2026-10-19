"""逐列讀取 AEMO MMS 格式的 CSV（以 `I` 列為欄位標題、`D` 列為資料）。

檔案可能有數百 MB，所以一律串流讀取，只留下呼叫端需要的欄位。
"""

import csv
from collections.abc import Iterator, Sequence
from datetime import datetime
from pathlib import Path

HEADER_ROW_MARKER = "I"
DATA_ROW_MARKER = "D"
AEMO_TIMESTAMP_FORMAT = "%Y/%m/%d %H:%M:%S"


def parse_aemo_timestamp(timestamp_text: str) -> datetime:
    """把 AEMO 的時間字串（NEM 時間，UTC+10，無日光節約）轉成不帶時區的 datetime。

    Args:
        timestamp_text: 例如 `2024/01/01 00:05:00`，可帶雙引號。

    Returns:
        NEM 時間的 datetime。

    Raises:
        ValueError: 格式不符時，訊息帶出原始字串。
    """
    try:
        return datetime.strptime(timestamp_text.strip('"'), AEMO_TIMESTAMP_FORMAT)
    except ValueError as parse_error:
        raise ValueError(f"AEMO 時間格式不符：{timestamp_text!r}") from parse_error


def iterate_selected_columns(file_path: Path, column_names: Sequence[str]) -> Iterator[dict[str, str]]:
    """逐列產生 `D` 列中指定欄位的值。

    遇到不含全部指定欄位的 `I` 標題時，跳過其後的 `D` 列，直到下一個符合的標題。

    Args:
        file_path: MMS CSV 檔案路徑。
        column_names: 要取出的欄位名稱。

    Returns:
        每一列 `{欄位名稱: 字串值}` 的迭代器。

    Raises:
        ValueError: 整份檔案沒有任何標題包含全部指定欄位，或某列欄位數不足時。
    """
    column_indexes: list[int] | None = None
    found_matching_header = False
    with file_path.open(newline="", encoding="utf-8") as input_file:
        csv_reader = csv.reader(input_file)
        for row_values in csv_reader:
            if not row_values:
                continue
            if row_values[0] == HEADER_ROW_MARKER:
                column_indexes = find_column_indexes(row_values, column_names)
                found_matching_header = found_matching_header or column_indexes is not None
                continue
            if row_values[0] != DATA_ROW_MARKER or column_indexes is None:
                continue
            if len(row_values) <= max(column_indexes):
                raise ValueError(f"{file_path} 第 {csv_reader.line_num} 列欄位數不足：{len(row_values)}")
            yield {column_name: row_values[column_index] for column_name, column_index in zip(column_names, column_indexes)}
    if not found_matching_header:
        raise ValueError(f"{file_path} 沒有包含欄位 {list(column_names)} 的標題列")


def find_column_indexes(header_values: Sequence[str], column_names: Sequence[str]) -> list[int] | None:
    """找出每個欄位在標題列中的位置。

    Args:
        header_values: `I` 標題列的所有值。
        column_names: 要找的欄位名稱。

    Returns:
        與 `column_names` 同順序的位置；任何一個欄位不存在時回傳 None。
    """
    if not all(column_name in header_values for column_name in column_names):
        return None
    return [list(header_values).index(column_name) for column_name in column_names]
