"""`analysis.mms_csv` 的單元測試。"""

from pathlib import Path

import pytest

from analysis.mms_csv import MmsRecord, MmsTableName, NumberedRow, iterate_mms_file, parse_mms_records

TRADING_PRICE_TABLE = MmsTableName(group_name="TRADING", table_name="PRICE")


def number_rows(csv_rows: list[list[str]]) -> list[NumberedRow]:
    """每列各佔一行時的行號（1 起算）。"""
    return [NumberedRow(line_number, csv_row) for line_number, csv_row in enumerate(csv_rows, start=1)]


def test_parse_mms_records_maps_values_by_header_name() -> None:
    """資料列依 I 列的欄名對應成字典，C 列略過。"""
    csv_rows = [
        ["C", "NEMP.WORLD", "TRADING"],
        ["I", "TRADING", "PRICE", "2", "SETTLEMENTDATE", "REGIONID", "RRP"],
        ["D", "TRADING", "PRICE", "2", "2024/01/01 00:05:00", "NSW1", "58"],
    ]

    price_records = list(parse_mms_records(number_rows(csv_rows), TRADING_PRICE_TABLE, "測試檔"))

    assert price_records == [
        MmsRecord({"SETTLEMENTDATE": "2024/01/01 00:05:00", "REGIONID": "NSW1", "RRP": "58"}, "測試檔 第 3 行")
    ]


def test_parse_mms_records_follows_header_change_within_file() -> None:
    """檔案中途換版本、欄位順序改變：改用新的欄名對應。"""
    csv_rows = [
        ["I", "TRADING", "PRICE", "2", "SETTLEMENTDATE", "RRP", "REGIONID"],
        ["D", "TRADING", "PRICE", "2", "2024/09/01 00:00:00", "10", "NSW1"],
        ["I", "TRADING", "PRICE", "3", "SETTLEMENTDATE", "REGIONID", "RRP"],
        ["D", "TRADING", "PRICE", "3", "2024/09/01 00:05:00", "NSW1", "20"],
    ]

    price_records = list(parse_mms_records(number_rows(csv_rows), TRADING_PRICE_TABLE, "測試檔"))

    assert [price_record.field_values["RRP"] for price_record in price_records] == ["10", "20"]


def test_parse_mms_records_skips_other_tables_and_blank_rows() -> None:
    """其他表的列與空列：略過，只留指定表的資料。"""
    csv_rows = [
        [],
        ["I", "P5MIN", "REGIONSOLUTION", "7", "RUN_DATETIME"],
        ["D", "P5MIN", "REGIONSOLUTION", "7", "2024/01/01 00:05:00"],
        ["I", "TRADING", "PRICE", "2", "RRP"],
        ["D", "TRADING", "PRICE", "2", "58"],
    ]

    price_records = list(parse_mms_records(number_rows(csv_rows), TRADING_PRICE_TABLE, "測試檔"))

    assert price_records == [MmsRecord({"RRP": "58"}, "測試檔 第 5 行")]


def test_parse_mms_records_rejects_data_before_header() -> None:
    """資料列出現在欄名列之前：丟出帶來源與列號的 ValueError。"""
    csv_rows = [["D", "TRADING", "PRICE", "2", "58"]]

    with pytest.raises(ValueError, match="測試檔 第 1 行"):
        list(parse_mms_records(number_rows(csv_rows), TRADING_PRICE_TABLE, "測試檔"))


def test_parse_mms_records_rejects_column_count_mismatch() -> None:
    """資料欄數與欄名數不同：丟出帶兩邊欄數的 ValueError。"""
    csv_rows = [
        ["I", "TRADING", "PRICE", "2", "SETTLEMENTDATE", "RRP"],
        ["D", "TRADING", "PRICE", "2", "2024/01/01 00:05:00"],
    ]

    with pytest.raises(ValueError, match="第 2 行.*1 欄.*2 欄"):
        list(parse_mms_records(number_rows(csv_rows), TRADING_PRICE_TABLE, "測試檔"))


def test_iterate_mms_file_streams_records_from_disk(tmp_path: Path) -> None:
    """從磁碟上的 CSV 檔讀出指定表的資料列。"""
    price_file = tmp_path / "trading_price.csv"
    price_file.write_text("I,TRADING,PRICE,2,REGIONID,RRP\nD,TRADING,PRICE,2,NSW1,58\n", encoding="utf-8")

    price_records = list(iterate_mms_file(price_file, TRADING_PRICE_TABLE))

    assert price_records == [MmsRecord({"REGIONID": "NSW1", "RRP": "58"}, f"{price_file} 第 2 行")]


def test_iterate_mms_file_reports_physical_line_after_multiline_field(tmp_path: Path) -> None:
    """前面有引號內含換行的欄位：錯誤訊息的行號是檔案的實體行號，不是列數。"""
    price_file = tmp_path / "trading_price.csv"
    price_file.write_text('C,"first line\nsecond line"\nD,TRADING,PRICE,2,58\n', encoding="utf-8")

    with pytest.raises(ValueError, match="第 3 行"):
        list(iterate_mms_file(price_file, TRADING_PRICE_TABLE))
