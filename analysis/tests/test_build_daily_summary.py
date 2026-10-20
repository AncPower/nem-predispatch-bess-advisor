"""`analysis.build_daily_summary` 的單元測試：以暫存目錄中的小型合成電價跑完整條流程。"""

import json
import math
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from analysis import build_daily_summary
from analysis.battery_configuration import BATTERY_CONFIGURATION_RELATIVE_PATH
from analysis.build_daily_summary import build_document
from analysis.build_factor_weights import INPUT_DIRECTORY_VARIABLE, REGION_SOLUTION_FILE_NAME, TRADING_PRICE_FILE_NAME
from analysis.nem_day import FIVE_MINUTE_INTERVAL, FIVE_MINUTE_INTERVALS_PER_DAY

SYNTHETIC_DAYS: tuple[date, ...] = tuple(date(2024, 7, 1) + timedelta(days=day_offset) for day_offset in range(5))
MMS_TIMESTAMP_FORMAT = "%Y/%m/%d %H:%M:%S"
GENERATED_AT = datetime(2026, 10, 20, 0, 0, 0, tzinfo=UTC)
SYNTHETIC_BATTERY_CONFIGURATION: dict[str, float] = {
    "schema_version": 1,
    "power_mw": 10,
    "capacity_mwh": 20,
    "round_trip_efficiency": 0.9,
    "degradation_cost_aud_per_mwh": 5,
    "marginal_loss_factor": 1,
}
MISSING_STEP_DAY_INDEX: int = 2


def synthetic_price(day_index: int, step_index: int) -> float:
    """合成的 5 分鐘電價：每天一個傍晚高峰，高峰大小隨日子變化。"""
    hour_of_day = step_index * 5 / 60
    return 50.0 + (100.0 + 40.0 * day_index) * math.exp(-((hour_of_day - 18.0) ** 2) / 4.0)


def write_raw_inputs(input_directory: Path) -> None:
    """寫一個期間資料夾：第 3 天少一筆 5 分鐘電價，另附一個空的區域解檔（流程不讀它）。"""
    period_directory = input_directory / "2024-07_2024-07"
    period_directory.mkdir(parents=True)
    csv_lines = ["I,TRADING,PRICE,3,SETTLEMENTDATE,REGIONID,RRP"]
    for day_index, trading_date in enumerate(SYNTHETIC_DAYS):
        day_start = datetime.combine(trading_date, datetime.min.time())
        for step_index in range(1, FIVE_MINUTE_INTERVALS_PER_DAY + 1):
            if day_index == MISSING_STEP_DAY_INDEX and step_index == 100:
                continue
            interval_end = day_start + step_index * FIVE_MINUTE_INTERVAL
            csv_lines.append(
                f"D,TRADING,PRICE,3,{interval_end.strftime(MMS_TIMESTAMP_FORMAT)},NSW1,{synthetic_price(day_index, step_index)}"
            )
            csv_lines.append(f"D,TRADING,PRICE,3,{interval_end.strftime(MMS_TIMESTAMP_FORMAT)},VIC1,9999")
    (period_directory / TRADING_PRICE_FILE_NAME).write_text("\n".join(csv_lines) + "\n", encoding="utf-8")
    (period_directory / REGION_SOLUTION_FILE_NAME).write_text("", encoding="utf-8")


def build_synthetic_inputs(tmp_path: Path) -> tuple[Path, Path]:
    """建合成的原始資料目錄與 repo 根目錄，回傳（原始資料目錄, repo 根目錄）。"""
    input_directory = tmp_path / "input"
    write_raw_inputs(input_directory)
    repository_root = tmp_path / "repository"
    (repository_root / "analysis").mkdir(parents=True)
    (repository_root / "analysis" / "placeholder.py").write_text("", encoding="utf-8")
    configuration_file = repository_root / BATTERY_CONFIGURATION_RELATIVE_PATH
    configuration_file.parent.mkdir(parents=True)
    configuration_file.write_text(json.dumps(SYNTHETIC_BATTERY_CONFIGURATION), encoding="utf-8")
    return input_directory, repository_root


def test_build_document_runs_whole_pipeline_on_synthetic_prices(tmp_path: Path) -> None:
    """合成的 5 天電價：每天都列出，第 3 天缺一筆被排除並寫明 287 筆，其餘每天都有正收益的循環。"""
    input_directory, repository_root = build_synthetic_inputs(tmp_path)

    summary_document = build_document(input_directory, repository_root, GENERATED_AT)

    day_entries = summary_document["days"]
    assert [day_entry["date"] for day_entry in day_entries] == [trading_date.isoformat() for trading_date in SYNTHETIC_DAYS]
    assert day_entries[MISSING_STEP_DAY_INDEX]["exclusion_reason"] == "5 分鐘電價只有 287 筆（應為 288 筆）"
    included_entries = [day_entry for day_entry in day_entries if not day_entry["excluded"]]
    assert len(included_entries) == len(SYNTHETIC_DAYS) - 1
    assert all(day_entry["net_value_aud"] > 0 and day_entry["cycles"] for day_entry in included_entries)


def test_build_document_takes_battery_from_configuration_and_fingerprints_it(tmp_path: Path) -> None:
    """電池規格取自 config/battery.json；指紋的外部檔只有它，原始檔清單只有電價檔。"""
    input_directory, repository_root = build_synthetic_inputs(tmp_path)

    summary_document = build_document(input_directory, repository_root, GENERATED_AT)

    assert summary_document["battery_specification"]["round_trip_efficiency"] == 0.9
    assert list(summary_document["input_fingerprint"]["external_files"]) == [BATTERY_CONFIGURATION_RELATIVE_PATH]
    raw_paths = [raw_entry["relative_path"] for raw_entry in summary_document["input_fingerprint"]["raw_input_files"]]
    assert raw_paths == [f"2024-07_2024-07/{TRADING_PRICE_FILE_NAME}"]


def test_efficiency_and_degradation_lower_net_value_below_gross_spread(tmp_path: Path) -> None:
    """計入 90% 效率與損耗成本（D3）：每個循環的淨收益低於「充電量 × 價差」。"""
    input_directory, repository_root = build_synthetic_inputs(tmp_path)

    summary_document = build_document(input_directory, repository_root, GENERATED_AT)

    every_cycle = [cycle for day_entry in summary_document["days"] for cycle in day_entry["cycles"]]
    assert every_cycle
    assert all(cycle["net_value_aud"] < 20 * cycle["spread_aud_per_mwh"] for cycle in every_cycle)


def test_main_returns_failure_code_without_input_directory(monkeypatch: pytest.MonkeyPatch) -> None:
    """沒有設定原始資料目錄就執行：回傳結束碼 1，不寫出 JSON。"""
    monkeypatch.delenv(INPUT_DIRECTORY_VARIABLE, raising=False)
    written_documents: list[object] = []
    monkeypatch.setattr(build_daily_summary, "write_report_document", lambda *arguments: written_documents.append(arguments))

    assert build_daily_summary.main() == 1
    assert written_documents == []
