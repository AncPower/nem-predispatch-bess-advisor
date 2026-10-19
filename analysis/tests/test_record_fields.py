"""`analysis.record_fields` 的單元測試。"""

from datetime import date

import pytest

from analysis.record_fields import parse_finite_field, parse_iso_date_field, read_record_field


def test_read_record_field_returns_value() -> None:
    """欄位存在：回傳字串值。"""
    assert read_record_field({"RRP": "58"}, "RRP", "測試列") == "58"


def test_read_record_field_rejects_missing_field() -> None:
    """欄位不存在：丟出帶欄名與位置的 ValueError。"""
    with pytest.raises(ValueError, match="測試列.*RRP"):
        read_record_field({}, "RRP", "測試列")


def test_parse_finite_field_reads_number() -> None:
    """數字字串：轉成浮點數。"""
    assert parse_finite_field({"RRP": "-12.5"}, "RRP", "測試列") == -12.5


@pytest.mark.parametrize("bad_text", ["abc", "", "nan", "inf"])
def test_parse_finite_field_rejects_non_finite_or_text(bad_text: str) -> None:
    """非數字、空字串、NaN 或無限大：丟出帶位置、欄名與原字串的 ValueError。"""
    with pytest.raises(ValueError, match="測試列.*RRP"):
        parse_finite_field({"RRP": bad_text}, "RRP", "測試列")


def test_parse_iso_date_field_reads_date() -> None:
    """ISO 日期字串：轉成 date。"""
    assert parse_iso_date_field({"gas_date": "2024-07-01"}, "gas_date", "測試列") == date(2024, 7, 1)


def test_parse_iso_date_field_rejects_other_format() -> None:
    """不是 ISO 日期：丟出帶原字串的 ValueError。"""
    with pytest.raises(ValueError, match="2024/07/01"):
        parse_iso_date_field({"gas_date": "2024/07/01"}, "gas_date", "測試列")
