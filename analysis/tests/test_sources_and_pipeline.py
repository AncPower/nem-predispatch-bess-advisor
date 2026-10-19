"""`analysis.aemo_csv`、`analysis.local_sources` 與命令列流程的測試（以暫存目錄的小型 MMS 檔模擬 input/）。"""

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest

from analysis.aemo_csv import iterate_selected_columns, parse_aemo_timestamp
from analysis.build_factor_weights import main, round_weights_to_unit_sum, run_pipeline
from analysis.local_sources import INPUT_DIRECTORY_VARIABLE, read_battery_units, read_daily_five_minute_prices, read_gas_prices, read_region_snapshots, resolve_input_directory

SAMPLE_DATES = (date(2024, 7, 15), date(2024, 8, 15), date(2024, 9, 15), date(2024, 10, 15))
AEMO_TIME_FORMAT = "%Y/%m/%d %H:%M:%S"


def interval_ends_for(sample_date: date) -> list[datetime]:
    """某一天 288 個時段的結束時間（第一個是 00:05，最後一個是隔天 00:00）。"""
    day_start = datetime.combine(sample_date, datetime.min.time())
    return [day_start + timedelta(minutes=5 * (interval_index + 1)) for interval_index in range(288)]


def write_trading_price_file(period_directory: Path, sample_dates: tuple[date, ...]) -> None:
    """寫一份 trading_price.csv：每天 10:00–14:00 低價、18:00–22:00 高價，高價隨日子遞增；另含一列其他區域。"""
    csv_lines = ["I,TRADING,PRICE,2,SETTLEMENTDATE,RUNNO,REGIONID,PERIODID,RRP"]
    for sample_date in sample_dates:
        day_index = SAMPLE_DATES.index(sample_date)
        for interval_end in interval_ends_for(sample_date):
            interval_hour = (interval_end - timedelta(minutes=5)).hour
            price_value = 10 if 10 <= interval_hour < 14 else 100 + 100 * day_index if 18 <= interval_hour < 22 else 50
            csv_lines.append(f"D,TRADING,PRICE,2,{interval_end.strftime(AEMO_TIME_FORMAT)},1,NSW1,1,{price_value}")
    csv_lines.append(f"D,TRADING,PRICE,2,{interval_ends_for(sample_dates[0])[0].strftime(AEMO_TIME_FORMAT)},1,QLD1,1,999")
    (period_directory / "trading_price.csv").write_text("\n".join(csv_lines) + "\n", encoding="utf-8")


def write_region_solution_file(period_directory: Path, sample_dates: tuple[date, ...]) -> None:
    """寫一份 p5min_region_solution.csv：每個時段一列第一時段，另含一列後續時段與一列介入，兩者都應被排除。"""
    csv_lines = ["I,P5MIN,REGIONSOLUTION,7,RUN_DATETIME,INTERVENTION,INTERVAL_DATETIME,REGIONID,TOTALDEMAND,AVAILABLEGENERATION,NETINTERCHANGE"]
    for sample_date in sample_dates:
        day_index = SAMPLE_DATES.index(sample_date)
        for interval_end in interval_ends_for(sample_date):
            timestamp_text = interval_end.strftime(AEMO_TIME_FORMAT)
            later_text = (interval_end + timedelta(minutes=5)).strftime(AEMO_TIME_FORMAT)
            csv_lines.append(f"D,P5MIN,REGIONSOLUTION,7,{timestamp_text},0,{timestamp_text},NSW1,{7000 + 100 * day_index},{10000 - 300 * day_index},{-500 + 50 * day_index}")
            csv_lines.append(f"D,P5MIN,REGIONSOLUTION,7,{timestamp_text},0,{later_text},NSW1,1,1,1")
            csv_lines.append(f"D,P5MIN,REGIONSOLUTION,7,{timestamp_text},1,{timestamp_text},NSW1,2,2,2")
    (period_directory / "p5min_region_solution.csv").write_text("\n".join(csv_lines) + "\n", encoding="utf-8")


@pytest.fixture
def sample_input_directory(tmp_path: Path) -> Path:
    """兩個期間資料夾，第一天的資料在兩邊重複，用來驗證去除重複。"""
    input_directory = tmp_path / "input"
    for period_name, period_dates in (("2024-07_2024-08", SAMPLE_DATES[:2]), ("2024-08_2024-10", SAMPLE_DATES[1:])):
        period_directory = input_directory / period_name
        period_directory.mkdir(parents=True)
        write_trading_price_file(period_directory, period_dates)
        write_region_solution_file(period_directory, period_dates)
    return input_directory


def test_parse_aemo_timestamp_accepts_quoted_text() -> None:
    assert parse_aemo_timestamp('"2024/07/01 00:05:00"') == datetime(2024, 7, 1, 0, 5)


def test_parse_aemo_timestamp_rejects_wrong_format() -> None:
    with pytest.raises(ValueError, match="格式不符"):
        parse_aemo_timestamp("2024-07-01T00:05:00")


def test_iterate_selected_columns_rejects_file_without_matching_header(tmp_path: Path) -> None:
    mms_path = tmp_path / "other.csv"
    mms_path.write_text("I,OTHER,TABLE,1,COLUMN_A\nD,OTHER,TABLE,1,5\n", encoding="utf-8")

    with pytest.raises(ValueError, match="沒有包含欄位"):
        list(iterate_selected_columns(mms_path, ["RRP"]))


def test_read_daily_five_minute_prices_keeps_nsw_full_days(sample_input_directory: Path) -> None:
    prices_by_date = read_daily_five_minute_prices(sample_input_directory)

    assert sorted(prices_by_date) == list(SAMPLE_DATES)
    assert all(len(day_prices) == 288 for day_prices in prices_by_date.values())
    assert 999 not in prices_by_date[SAMPLE_DATES[0]]


def test_read_region_snapshots_keeps_first_interval_without_intervention(sample_input_directory: Path) -> None:
    region_snapshots = read_region_snapshots(sample_input_directory)

    assert len(region_snapshots) == 288 * len(SAMPLE_DATES)
    assert {region_snapshot.total_demand for region_snapshot in region_snapshots} == {7000, 7100, 7200, 7300}


def test_resolve_input_directory_requires_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(INPUT_DIRECTORY_VARIABLE, raising=False)

    with pytest.raises(ValueError, match=INPUT_DIRECTORY_VARIABLE):
        resolve_input_directory()


def test_repository_external_files_parse() -> None:
    gas_prices = read_gas_prices()
    battery_units = read_battery_units()

    assert gas_prices[date(2024, 1, 1)] == 9.5
    assert "ERB01" in {battery_unit.duid for battery_unit in battery_units}


def test_main_writes_factor_weights_file(sample_input_directory: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(INPUT_DIRECTORY_VARIABLE, str(sample_input_directory))
    output_path = tmp_path / "factor_weights.json"

    exit_code = main(["--output", str(output_path)])

    output_document = json.loads(output_path.read_text(encoding="utf-8"))
    assert exit_code == 0
    assert output_document["data_period"] == {"start": "2024-07-15", "end": "2024-10-15", "day_count": 4}
    assert output_document["generated_at"].endswith("Z")
    assert round(sum(factor_entry["weight"] for factor_entry in output_document["factors"]), 6) == 1.0
    assert {"weight", "direction", "monthly_baseline"} <= set(output_document["factors"][0])


def test_run_pipeline_writes_given_generation_time(sample_input_directory: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(INPUT_DIRECTORY_VARIABLE, str(sample_input_directory))
    output_path = tmp_path / "factor_weights.json"

    run_pipeline(output_path, datetime(2026, 10, 19, 13, 0, 5, tzinfo=UTC))

    assert json.loads(output_path.read_text(encoding="utf-8"))["generated_at"] == "2026-10-19T13:00:05Z"


def test_iterate_selected_columns_rejects_short_data_row(tmp_path: Path) -> None:
    mms_path = tmp_path / "short.csv"
    mms_path.write_text("I,TRADING,PRICE,2,SETTLEMENTDATE,REGIONID,RRP\nD,TRADING,PRICE,2,2024/07/01 00:05:00\n", encoding="utf-8")

    with pytest.raises(ValueError, match="第 2 列欄位數不足"):
        list(iterate_selected_columns(mms_path, ["SETTLEMENTDATE", "RRP"]))


def test_read_gas_prices_names_missing_column(tmp_path: Path) -> None:
    gas_price_path = tmp_path / "gas.csv"
    gas_price_path.write_text("gas_date,price\n2024-01-01,9.5\n", encoding="utf-8")

    with pytest.raises(ValueError, match="exante_price_aud_per_gj"):
        read_gas_prices(gas_price_path)


def test_main_returns_one_when_input_directory_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(INPUT_DIRECTORY_VARIABLE, str(tmp_path / "missing"))

    assert main(["--output", str(tmp_path / "factor_weights.json")]) == 1


def test_round_weights_to_unit_sum_moves_rounding_error_to_largest_weight() -> None:
    rounded_weights = round_weights_to_unit_sum([0.2500003, 0.5000004, 0.2499993])

    assert rounded_weights == [0.25, 0.500001, 0.249999]
