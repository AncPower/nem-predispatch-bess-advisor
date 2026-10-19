"""資料列（「欄名 → 字串值」）的欄位讀取與型別轉換，錯誤訊息一律帶出位置與欄名。"""

import math
from collections.abc import Mapping
from datetime import date


def read_record_field(data_record: Mapping[str, str], field_name: str, record_label: str) -> str:
    """取出資料列的欄位字串。

    Args:
        data_record: 一筆資料列。
        field_name: 欄名。
        record_label: 錯誤訊息用的位置說明，例如表名與時間。

    Returns:
        欄位字串。

    Raises:
        ValueError: 沒有這個欄位時。
    """
    field_value = data_record.get(field_name)
    if field_value is None:
        raise ValueError(f"{record_label}：缺少欄位 {field_name}")
    return field_value


def parse_finite_field(data_record: Mapping[str, str], field_name: str, record_label: str) -> float:
    """取出欄位並轉成有限浮點數。

    Args:
        data_record: 一筆資料列。
        field_name: 欄名。
        record_label: 錯誤訊息用的位置說明。

    Returns:
        浮點數。

    Raises:
        ValueError: 欄位缺漏、不是數字，或為 NaN／無限大時。
    """
    field_text = read_record_field(data_record, field_name, record_label)
    try:
        field_number = float(field_text)
    except ValueError as parse_error:
        raise ValueError(f"{record_label}：{field_name} 不是數字「{field_text}」") from parse_error
    if not math.isfinite(field_number):
        raise ValueError(f"{record_label}：{field_name} 不是有限數值「{field_text}」")
    return field_number


def parse_iso_date_field(data_record: Mapping[str, str], field_name: str, record_label: str) -> date:
    """取出欄位並轉成日期（`YYYY-MM-DD`）。

    Args:
        data_record: 一筆資料列。
        field_name: 欄名。
        record_label: 錯誤訊息用的位置說明。

    Returns:
        日期。

    Raises:
        ValueError: 欄位缺漏或不是 ISO 日期時。
    """
    field_text = read_record_field(data_record, field_name, record_label)
    try:
        return date.fromisoformat(field_text)
    except ValueError as parse_error:
        raise ValueError(f"{record_label}：{field_name} 不是 YYYY-MM-DD 日期「{field_text}」") from parse_error
