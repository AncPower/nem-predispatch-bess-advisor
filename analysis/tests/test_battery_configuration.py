"""`analysis.battery_configuration` 的單元測試。"""

import json
import re
from pathlib import Path

import pytest

from analysis.arbitrage_plan import BatterySpecification
from analysis.battery_configuration import (
    BATTERY_CONFIGURATION_RELATIVE_PATH,
    BATTERY_FIELD_NAMES,
    parse_battery_specification,
    read_battery_specification,
)

REPOSITORY_ROOT: Path = Path(__file__).resolve().parents[2]
JAVASCRIPT_FIELD_LIST_PATTERN: re.Pattern[str] = re.compile(r"const BATTERY_FIELD_NAMES = Object\.freeze\(\[(.*?)\]\);", re.DOTALL)


def build_battery_payload(**override_fields: object) -> dict[str, object]:
    """合法的設備參數，可覆寫或加欄位。"""
    return {
        "schema_version": 1,
        "power_mw": 5,
        "capacity_mwh": 20,
        "round_trip_efficiency": 0.85,
        "degradation_cost_aud_per_mwh": 8,
        "marginal_loss_factor": 0.98,
        **override_fields,
    }


def test_repository_battery_configuration_is_valid() -> None:
    """repo 的 config/battery.json 可以讀出規格。"""
    battery_specification = read_battery_specification(REPOSITORY_ROOT / BATTERY_CONFIGURATION_RELATIVE_PATH)

    assert battery_specification == BatterySpecification(
        power_mw=5, capacity_mwh=20, marginal_loss_factor=1, round_trip_efficiency=1, degradation_cost_aud_per_mwh=0
    )


def test_battery_field_names_match_javascript_reader() -> None:
    """JS 與 Python 驗證同一份檔案：欄位清單與 src/shared_configuration.js 的 BATTERY_FIELD_NAMES 相同。"""
    javascript_source = (REPOSITORY_ROOT / "src" / "shared_configuration.js").read_text(encoding="utf-8")
    field_list_match = JAVASCRIPT_FIELD_LIST_PATTERN.search(javascript_source)

    assert field_list_match is not None
    assert set(re.findall(r'"(\w+)"', field_list_match.group(1))) == set(BATTERY_FIELD_NAMES)


def test_parse_battery_specification_reads_every_field() -> None:
    """合法內容：取出功率、容量、MLF、來回效率與損耗成本。"""
    assert parse_battery_specification(build_battery_payload()) == BatterySpecification(
        power_mw=5, capacity_mwh=20, marginal_loss_factor=0.98, round_trip_efficiency=0.85, degradation_cost_aud_per_mwh=8
    )


def test_parse_battery_specification_accepts_boundary_values() -> None:
    """效率剛好 1、損耗剛好 0 是合法邊界。"""
    parse_battery_specification(build_battery_payload(round_trip_efficiency=1, degradation_cost_aud_per_mwh=0))


def test_parse_battery_specification_rejects_missing_field() -> None:
    """缺欄位：報錯並列出欄名，不套預設值。"""
    configuration_payload = build_battery_payload()
    del configuration_payload["marginal_loss_factor"]

    with pytest.raises(ValueError, match="缺少欄位：marginal_loss_factor"):
        parse_battery_specification(configuration_payload)


def test_parse_battery_specification_rejects_unknown_field() -> None:
    """多出未知欄位：報錯，避免打錯欄名被忽略。"""
    with pytest.raises(ValueError, match="未知欄位：efficiency"):
        parse_battery_specification(build_battery_payload(efficiency=0.9))


@pytest.mark.parametrize("schema_version", [2, "1", True])
def test_parse_battery_specification_rejects_other_schema_version(schema_version: object) -> None:
    """schema_version 不是整數 1：報錯。"""
    with pytest.raises(ValueError, match="schema_version"):
        parse_battery_specification(build_battery_payload(schema_version=schema_version))


@pytest.mark.parametrize(
    "override_fields",
    [
        {"power_mw": 0},
        {"capacity_mwh": -1},
        {"round_trip_efficiency": 0},
        {"round_trip_efficiency": 1.01},
        {"degradation_cost_aud_per_mwh": -0.5},
        {"marginal_loss_factor": 0},
        {"power_mw": "5"},
        {"capacity_mwh": None},
        {"power_mw": True},
        {"capacity_mwh": float("nan")},
    ],
)
def test_parse_battery_specification_rejects_out_of_range_values(override_fields: dict[str, object]) -> None:
    """超出範圍、非數值、布林值或 NaN：報錯並指出欄名。"""
    field_name = next(iter(override_fields))

    with pytest.raises(ValueError, match=field_name):
        parse_battery_specification(build_battery_payload(**override_fields))


@pytest.mark.parametrize("configuration_payload", [None, [], "config", 5])
def test_parse_battery_specification_rejects_non_object(configuration_payload: object) -> None:
    """不是 JSON 物件：報錯。"""
    with pytest.raises(ValueError, match="必須是 JSON 物件"):
        parse_battery_specification(configuration_payload)


def test_read_battery_specification_rejects_invalid_json(tmp_path: Path) -> None:
    """檔案不是合法 JSON：丟出帶路徑的 ValueError。"""
    configuration_path = tmp_path / "battery.json"
    configuration_path.write_text("{power_mw: 5}", encoding="utf-8")

    with pytest.raises(ValueError, match="不是 UTF-8 編碼的合法 JSON"):
        read_battery_specification(configuration_path)


def test_read_battery_specification_accepts_utf8_bom(tmp_path: Path) -> None:
    """檔頭有 UTF-8 BOM：和瀏覽器一樣照常讀取。"""
    configuration_path = tmp_path / "battery.json"
    configuration_path.write_bytes(b"\xef\xbb\xbf" + json.dumps(build_battery_payload()).encode("utf-8"))

    assert read_battery_specification(configuration_path).power_mw == 5


def test_read_battery_specification_rejects_integer_beyond_float_range(tmp_path: Path) -> None:
    """整數大到超出浮點範圍（瀏覽器讀成 Infinity）：丟出指出欄名的 ValueError，不是 OverflowError。"""
    configuration_path = tmp_path / "battery.json"
    configuration_text = json.dumps(build_battery_payload(power_mw=0)).replace('"power_mw": 0', '"power_mw": 1' + "0" * 400)
    configuration_path.write_text(configuration_text, encoding="utf-8")

    with pytest.raises(ValueError, match="power_mw"):
        read_battery_specification(configuration_path)


def test_read_battery_specification_rejects_utf16_file_with_path(tmp_path: Path) -> None:
    """檔案存成 UTF-16（例如 PowerShell 的預設輸出）：丟出帶路徑的 ValueError。"""
    configuration_path = tmp_path / "battery.json"
    configuration_path.write_bytes(json.dumps(build_battery_payload()).encode("utf-16"))

    with pytest.raises(ValueError, match="battery.json 不是 UTF-8 編碼的合法 JSON"):
        read_battery_specification(configuration_path)
