"""`analysis.build_factor_weights` 的單元測試：以暫存目錄中的小型合成資料跑完整條流程。"""

import json
import math
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from analysis import build_factor_weights
from analysis.battery_configuration import BATTERY_CONFIGURATION_RELATIVE_PATH
from analysis.build_factor_weights import (
    BATTERY_UNITS_RELATIVE_PATH,
    GAS_PRICE_RELATIVE_PATH,
    INPUT_DIRECTORY_VARIABLE,
    REGION_SOLUTION_FILE_NAME,
    TRADING_PRICE_FILE_NAME,
    build_document,
    find_raw_input_files,
    read_input_directory,
    write_report_document,
)
from analysis.nem_day import FIVE_MINUTE_INTERVAL, FIVE_MINUTE_INTERVALS_PER_DAY

SYNTHETIC_DAYS: tuple[date, ...] = tuple(date(2024, 7, 25) + timedelta(days=day_offset) for day_offset in range(12))
MMS_TIMESTAMP_FORMAT = "%Y/%m/%d %H:%M:%S"
GENERATED_AT = datetime(2026, 10, 19, 0, 0, 0, tzinfo=UTC)
SYNTHETIC_BATTERY_CONFIGURATION: dict[str, float] = {
    "schema_version": 1,
    "power_mw": 10,
    "capacity_mwh": 20,
    "round_trip_efficiency": 1,
    "degradation_cost_aud_per_mwh": 0,
    "marginal_loss_factor": 0.95,
}


def synthetic_price(day_index: int, step_index: int) -> float:
    """合成的 5 分鐘電價：每天一個傍晚高峰，高峰大小隨日子變化。"""
    hour_of_day = step_index * 5 / 60
    return 50.0 + (100.0 + 40.0 * (day_index % 5)) * math.exp(-((hour_of_day - 18.0) ** 2) / 4.0)


def write_trading_price_file(file_path: Path) -> None:
    """寫一個合成的 TRADING.PRICE MMS 檔。"""
    csv_lines = ["I,TRADING,PRICE,3,SETTLEMENTDATE,REGIONID,RRP"]
    for day_index, trading_date in enumerate(SYNTHETIC_DAYS):
        day_start = datetime.combine(trading_date, datetime.min.time())
        for step_index in range(1, FIVE_MINUTE_INTERVALS_PER_DAY + 1):
            interval_end = day_start + step_index * FIVE_MINUTE_INTERVAL
            csv_lines.append(
                f"D,TRADING,PRICE,3,{interval_end.strftime(MMS_TIMESTAMP_FORMAT)},NSW1,{synthetic_price(day_index, step_index)}"
            )
    file_path.write_text("\n".join(csv_lines) + "\n", encoding="utf-8")


def write_region_solution_file(file_path: Path) -> None:
    """寫一個合成的 P5MIN.REGIONSOLUTION MMS 檔；各因素隨日子以不同週期變化。"""
    csv_lines = ["I,P5MIN,REGIONSOLUTION,10,RUN_DATETIME,INTERVAL_DATETIME,REGIONID,TOTALDEMAND,AVAILABLEGENERATION,NETINTERCHANGE"]
    for day_index, trading_date in enumerate(SYNTHETIC_DAYS):
        day_start = datetime.combine(trading_date, datetime.min.time())
        for step_index in range(1, FIVE_MINUTE_INTERVALS_PER_DAY + 1):
            run_text = (day_start + step_index * FIVE_MINUTE_INTERVAL).strftime(MMS_TIMESTAMP_FORMAT)
            total_demand = 7000.0 + 30.0 * (day_index % 4) + 500.0 * math.sin(step_index / 46.0)
            available_generation = 11000.0 - 20.0 * (day_index % 3)
            net_interchange = -400.0 + 15.0 * (day_index % 6)
            csv_lines.append(
                f"D,P5MIN,REGIONSOLUTION,10,{run_text},{run_text},NSW1,{total_demand},{available_generation},{net_interchange}"
            )
    file_path.write_text("\n".join(csv_lines) + "\n", encoding="utf-8")


def write_external_files(repository_root: Path) -> None:
    """寫合成的天然氣價、電池機組 CSV 與設備參數；8 月起多一台電池，讓裝置量有變化。"""
    gas_file = repository_root / GAS_PRICE_RELATIVE_PATH
    gas_file.parent.mkdir(parents=True)
    gas_lines = ["gas_date,exante_price_aud_per_gj,expost_price_aud_per_gj"]
    gas_lines += [f"{trading_date.isoformat()},{10.0 + 0.3 * (day_index % 7)},10" for day_index, trading_date in enumerate(SYNTHETIC_DAYS)]
    gas_file.write_text("\n".join(gas_lines) + "\n", encoding="utf-8")
    battery_lines = [
        "duid,station_id,effective_date,registered_capacity_mw,max_capacity_mw,max_storage_capacity_mwh,region_start_date,region_end_date",
        "UNITA1,STATIONA,2024-07-01,60,50,100,2024-07-01,2999-12-31",
        "UNITB1,STATIONB,2024-08-01,40,30,60,2024-08-01,2999-12-31",
    ]
    (repository_root / BATTERY_UNITS_RELATIVE_PATH).write_text("\n".join(battery_lines) + "\n", encoding="utf-8")
    configuration_file = repository_root / BATTERY_CONFIGURATION_RELATIVE_PATH
    configuration_file.parent.mkdir(parents=True)
    configuration_file.write_text(json.dumps(SYNTHETIC_BATTERY_CONFIGURATION), encoding="utf-8")


def build_synthetic_inputs(tmp_path: Path) -> tuple[Path, Path]:
    """建合成的原始資料目錄與 repo 根目錄，回傳（原始資料目錄, repo 根目錄）。"""
    input_directory = tmp_path / "input"
    period_directory = input_directory / "2024-07_2024-08"
    period_directory.mkdir(parents=True)
    write_trading_price_file(period_directory / TRADING_PRICE_FILE_NAME)
    write_region_solution_file(period_directory / REGION_SOLUTION_FILE_NAME)
    repository_root = tmp_path / "repository"
    (repository_root / "analysis").mkdir(parents=True)
    write_external_files(repository_root)
    return input_directory, repository_root


def test_read_input_directory_rejects_unset_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    """沒有設定 NEM_INPUT_DIRECTORY：丟出帶執行指令的 ValueError。"""
    monkeypatch.delenv(INPUT_DIRECTORY_VARIABLE, raising=False)

    with pytest.raises(ValueError, match=INPUT_DIRECTORY_VARIABLE):
        read_input_directory()


def test_read_input_directory_rejects_missing_directory(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """NEM_INPUT_DIRECTORY 指向不存在的路徑：丟出 ValueError。"""
    monkeypatch.setenv(INPUT_DIRECTORY_VARIABLE, str(tmp_path / "missing"))

    with pytest.raises(ValueError, match="不是目錄"):
        read_input_directory()


def test_find_raw_input_files_rejects_period_without_region_file(tmp_path: Path) -> None:
    """期間資料夾缺 p5min_region_solution.csv：丟出指出資料夾與檔名的 ValueError。"""
    period_directory = tmp_path / "2024-01_2024-12"
    period_directory.mkdir()
    (period_directory / TRADING_PRICE_FILE_NAME).write_text("", encoding="utf-8")

    with pytest.raises(ValueError, match=REGION_SOLUTION_FILE_NAME):
        find_raw_input_files(tmp_path)


def test_find_raw_input_files_rejects_empty_directory(tmp_path: Path) -> None:
    """原始資料目錄沒有任何期間資料夾：丟出 ValueError。"""
    with pytest.raises(ValueError, match="沒有期間資料夾"):
        find_raw_input_files(tmp_path)


def test_build_document_runs_whole_pipeline_on_synthetic_data(tmp_path: Path) -> None:
    """合成的 12 天資料：產出的文件涵蓋全部日子，權重非負且加總為 1，並記下兩個原始檔。"""
    input_directory, repository_root = build_synthetic_inputs(tmp_path)

    report_document = build_document(input_directory, repository_root, GENERATED_AT)

    factor_weights = [factor_entry["weight"] for factor_entry in report_document["factors"]]
    assert report_document["period"]["day_count"] == len(SYNTHETIC_DAYS)
    assert all(factor_weight >= 0.0 for factor_weight in factor_weights)
    assert sum(factor_weights) == pytest.approx(1.0)
    assert len(report_document["input_fingerprint"]["raw_input_files"]) == 2
    assert sorted(report_document["input_fingerprint"]["external_files"]) == sorted(
        [GAS_PRICE_RELATIVE_PATH, BATTERY_UNITS_RELATIVE_PATH, BATTERY_CONFIGURATION_RELATIVE_PATH]
    )


def test_build_document_takes_battery_specification_from_configuration_file(tmp_path: Path) -> None:
    """每日收益用的電池規格取自 config/battery.json，不是程式裡寫死的 5 MW／20 MWh／MLF 1。"""
    input_directory, repository_root = build_synthetic_inputs(tmp_path)

    report_document = build_document(input_directory, repository_root, GENERATED_AT)

    assert report_document["battery_specification"] == {"power_mw": 10, "capacity_mwh": 20, "marginal_loss_factor": 0.95}


def test_build_document_rejects_invalid_battery_configuration(tmp_path: Path) -> None:
    """config/battery.json 的功率為 0：丟出指出欄名的 ValueError，不產出文件。"""
    input_directory, repository_root = build_synthetic_inputs(tmp_path)
    invalid_configuration = {**SYNTHETIC_BATTERY_CONFIGURATION, "power_mw": 0}
    (repository_root / BATTERY_CONFIGURATION_RELATIVE_PATH).write_text(json.dumps(invalid_configuration), encoding="utf-8")

    with pytest.raises(ValueError, match="power_mw"):
        build_document(input_directory, repository_root, GENERATED_AT)


def test_write_report_document_writes_readable_utf8_json(tmp_path: Path) -> None:
    """寫出的 JSON：UTF-8、中文不轉義，讀回內容相同，且不留下暫存檔。"""
    output_path = tmp_path / "factor_weights.json"
    report_document = {"reason": "沒有雪梨天然氣事前價"}

    write_report_document(report_document, output_path)

    assert "沒有雪梨天然氣事前價" in output_path.read_text(encoding="utf-8")
    assert json.loads(output_path.read_text(encoding="utf-8")) == report_document
    assert list(tmp_path.iterdir()) == [output_path]


def test_main_returns_failure_code_without_input_directory(monkeypatch: pytest.MonkeyPatch) -> None:
    """沒有設定原始資料目錄就執行：回傳結束碼 1，不寫出 JSON。"""
    monkeypatch.delenv(INPUT_DIRECTORY_VARIABLE, raising=False)
    written_documents: list[object] = []
    monkeypatch.setattr(build_factor_weights, "write_report_document", lambda *arguments: written_documents.append(arguments))

    assert build_factor_weights.main() == 1
    assert written_documents == []
