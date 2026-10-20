"""讀取兩頁與分析層共用的設備參數 `config/battery.json`。

驗證規則與 `src/shared_configuration.js` 的 `parse_battery_configuration` 相同：欄位缺漏、多出未知欄位、
版本不符或數值超出範圍時直接報錯，不套預設值。來回效率與損耗成本由選窗計入淨收益（#27）。
"""

import json
import math
from collections.abc import Callable, Mapping
from pathlib import Path

from analysis.arbitrage_plan import BatterySpecification

BATTERY_CONFIGURATION_RELATIVE_PATH: str = "config/battery.json"
SUPPORTED_SCHEMA_VERSION: int = 1
# Windows 編輯器可能在檔頭加 BOM；瀏覽器的 fetch().json() 會略過它，這裡比照辦理。
UTF8_WITH_OPTIONAL_BOM: str = "utf-8-sig"
BATTERY_FIELD_NAMES: tuple[str, ...] = (
    "schema_version",
    "power_mw",
    "capacity_mwh",
    "round_trip_efficiency",
    "degradation_cost_aud_per_mwh",
    "marginal_loss_factor",
)


def read_battery_specification(configuration_path: Path) -> BatterySpecification:
    """讀檔並驗證設備參數。

    Args:
        configuration_path: `config/battery.json` 的路徑。

    Returns:
        電池規格。

    Raises:
        ValueError: 不是 UTF-8 編碼的合法 JSON 物件、欄位缺漏或多出、版本不符、數值超出範圍時。
        OSError: 檔案讀不到時。
    """
    try:
        configuration_payload = json.loads(configuration_path.read_text(encoding=UTF8_WITH_OPTIONAL_BOM))
    except (json.JSONDecodeError, UnicodeDecodeError) as decode_error:
        raise ValueError(f"{configuration_path} 不是 UTF-8 編碼的合法 JSON：{decode_error}") from decode_error
    return parse_battery_specification(configuration_payload)


def parse_battery_specification(configuration_payload: object) -> BatterySpecification:
    """驗證設備參數內容。

    Args:
        configuration_payload: `config/battery.json` 的 JSON 內容。

    Returns:
        電池規格。

    Raises:
        ValueError: 不是物件、欄位缺漏或多出、版本不符、數值超出範圍時。
    """
    checked_payload = check_field_names(configuration_payload)
    return BatterySpecification(
        power_mw=read_number_field(checked_payload, "power_mw", lambda field_value: field_value > 0, "大於 0"),
        capacity_mwh=read_number_field(checked_payload, "capacity_mwh", lambda field_value: field_value > 0, "大於 0"),
        marginal_loss_factor=read_number_field(
            checked_payload, "marginal_loss_factor", lambda field_value: field_value > 0, "大於 0"
        ),
        round_trip_efficiency=read_number_field(
            checked_payload, "round_trip_efficiency", lambda field_value: 0 < field_value <= 1, "大於 0 且不超過 1"
        ),
        degradation_cost_aud_per_mwh=read_number_field(
            checked_payload, "degradation_cost_aud_per_mwh", lambda field_value: field_value >= 0, "0 以上"
        ),
    )


def check_field_names(configuration_payload: object) -> Mapping[str, object]:
    """確認內容是 JSON 物件、欄位恰好是預期的那幾個，且版本相符。

    Args:
        configuration_payload: JSON 內容。

    Returns:
        同一份內容，型別收窄為欄名對應值。

    Raises:
        ValueError: 不符時。
    """
    if not isinstance(configuration_payload, dict):
        raise ValueError(f"{BATTERY_CONFIGURATION_RELATIVE_PATH} 必須是 JSON 物件")
    missing_field_names = [field_name for field_name in BATTERY_FIELD_NAMES if field_name not in configuration_payload]
    if missing_field_names:
        raise ValueError(f"{BATTERY_CONFIGURATION_RELATIVE_PATH} 缺少欄位：{'、'.join(missing_field_names)}")
    unknown_field_names = [field_name for field_name in configuration_payload if field_name not in BATTERY_FIELD_NAMES]
    if unknown_field_names:
        raise ValueError(f"{BATTERY_CONFIGURATION_RELATIVE_PATH} 有未知欄位：{'、'.join(unknown_field_names)}")
    schema_version = configuration_payload["schema_version"]
    if isinstance(schema_version, bool) or schema_version != SUPPORTED_SCHEMA_VERSION:
        raise ValueError(
            f"{BATTERY_CONFIGURATION_RELATIVE_PATH} 的 schema_version 必須是 {SUPPORTED_SCHEMA_VERSION}：{schema_version!r}"
        )
    return configuration_payload


def read_number_field(
    configuration_payload: Mapping[str, object],
    field_name: str,
    is_within_range: Callable[[float], bool],
    range_text: str,
) -> float:
    """取出數值欄位並檢查範圍。

    Args:
        configuration_payload: JSON 內容。
        field_name: 欄名。
        is_within_range: 範圍判斷。
        range_text: 範圍說明，用在錯誤訊息。

    Returns:
        欄位值，保留 JSON 裡的整數或浮點數，讓輸出的 JSON 與設定檔寫法一致。

    Raises:
        ValueError: 不是有限數值（布林值也不算）或超出範圍時。
    """
    field_value = configuration_payload[field_name]
    if (
        isinstance(field_value, bool)
        or not isinstance(field_value, int | float)
        or not is_finite_number(field_value)
        or not is_within_range(field_value)
    ):
        raise ValueError(f"{BATTERY_CONFIGURATION_RELATIVE_PATH} 的 {field_name} 必須是{range_text}的數值：{field_value!r}")
    return field_value


def is_finite_number(numeric_value: int | float) -> bool:
    """數值是否有限；超出浮點範圍的大整數視為無限，與瀏覽器的 JSON.parse 一致。

    Args:
        numeric_value: 整數或浮點數。

    Returns:
        有限時為 True。
    """
    try:
        return math.isfinite(numeric_value)
    except OverflowError:
        return False
