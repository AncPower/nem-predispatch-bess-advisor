"""AEMO MMS CSV（以 `I`／`D` 開頭的列）的串流解析。

每個 `I` 列是之後 `D` 列的欄名。同一個檔案中途可能換版本、欄位順序也跟著變，
所以每遇到一個 `I` 列就重建欄名，資料一律依欄名取值，不用固定位置。
"""

import csv
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

INFORMATION_RECORD: str = "I"
DATA_RECORD: str = "D"
RECORD_TYPE_INDEX: int = 0
GROUP_NAME_INDEX: int = 1
TABLE_NAME_INDEX: int = 2
FIRST_FIELD_INDEX: int = 4
MINIMUM_ROW_LENGTH: int = TABLE_NAME_INDEX + 1


@dataclass(frozen=True)
class MmsTableName:
    """MMS 的表名，例如 `TRADING`／`PRICE`。"""

    group_name: str
    table_name: str

    def matches_row(self, csv_row: Sequence[str]) -> bool:
        """這一列是否屬於本表。

        Args:
            csv_row: 已拆欄的 CSV 列。

        Returns:
            第 2、3 欄等於本表的群組與表名時為 True。
        """
        if len(csv_row) < MINIMUM_ROW_LENGTH:
            return False
        return csv_row[GROUP_NAME_INDEX] == self.group_name and csv_row[TABLE_NAME_INDEX] == self.table_name


class LineNumberedReader(Protocol):
    """`csv.reader` 物件的介面：可逐列迭代，並提供目前的實體行號。"""

    line_num: int

    def __iter__(self) -> Iterator[list[str]]:
        """逐列迭代已拆欄的 CSV 列。"""
        ...


@dataclass(frozen=True)
class NumberedRow:
    """已拆欄的 CSV 列，與它在檔案中的實體行號。"""

    line_number: int
    csv_fields: Sequence[str]


def number_reader_rows(csv_reader: LineNumberedReader) -> Iterator[NumberedRow]:
    """替 `csv.reader` 讀出的每一列附上行號。

    用 reader 的 `line_num`（讀完這一列後的實體行號），不自己數列數：
    引號內含換行的欄位會讓一列跨好幾行，數列數會對不上檔案的行號。

    Args:
        csv_reader: `csv.reader` 物件。

    Yields:
        附行號的列。
    """
    for csv_fields in csv_reader:
        yield NumberedRow(line_number=csv_reader.line_num, csv_fields=csv_fields)


def parse_mms_records(
    numbered_rows: Iterable[NumberedRow], mms_table: MmsTableName, source_label: str
) -> Iterator[dict[str, str]]:
    """把 MMS 的列轉成「欄名 → 字串值」，只留指定表的資料列。

    Args:
        numbered_rows: 附行號的 CSV 列，依檔案順序。
        mms_table: 要讀的表。
        source_label: 錯誤訊息裡用來指出來源的名稱，例如檔案路徑。

    Yields:
        每個資料列一筆，鍵為欄名。

    Raises:
        ValueError: 資料列出現在欄名列之前，或欄數和欄名數不同時，訊息帶來源與行號。
    """
    column_names: tuple[str, ...] | None = None
    for numbered_row in numbered_rows:
        csv_row = numbered_row.csv_fields
        if not mms_table.matches_row(csv_row):
            continue
        if csv_row[RECORD_TYPE_INDEX] == INFORMATION_RECORD:
            column_names = tuple(csv_row[FIRST_FIELD_INDEX:])
        elif csv_row[RECORD_TYPE_INDEX] == DATA_RECORD:
            yield build_data_record(csv_row, column_names, f"{source_label} 第 {numbered_row.line_number} 行")


def build_data_record(
    csv_row: Sequence[str], column_names: tuple[str, ...] | None, row_label: str
) -> dict[str, str]:
    """把一個資料列依欄名組成字典。

    Args:
        csv_row: `D` 開頭的列。
        column_names: 最近一個 `I` 列的欄名；還沒遇到時為 None。
        row_label: 錯誤訊息用的位置說明。

    Returns:
        「欄名 → 字串值」。

    Raises:
        ValueError: 沒有欄名，或欄數不符時。
    """
    if column_names is None:
        raise ValueError(f"{row_label}：資料列出現在欄名列之前")
    field_values = csv_row[FIRST_FIELD_INDEX:]
    if len(field_values) != len(column_names):
        raise ValueError(f"{row_label}：資料有 {len(field_values)} 欄，欄名有 {len(column_names)} 欄")
    return dict(zip(column_names, field_values, strict=True))


def iterate_mms_file(file_path: Path, mms_table: MmsTableName) -> Iterator[dict[str, str]]:
    """逐列讀取 MMS CSV 檔，不把整個檔案載入記憶體。

    Args:
        file_path: CSV 檔路徑。
        mms_table: 要讀的表。

    Yields:
        每個資料列一筆，鍵為欄名。
    """
    with file_path.open(newline="", encoding="utf-8") as csv_file:
        yield from parse_mms_records(number_reader_rows(csv.reader(csv_file)), mms_table, str(file_path))
