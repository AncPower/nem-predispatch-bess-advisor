"""`analysis.daily_summary_report` 的單元測試。"""

from datetime import UTC, date, datetime, timedelta

import pytest

from analysis.arbitrage_plan import BatterySpecification
from analysis.daily_revenue import DailyPlanResult, compute_daily_plans
from analysis.daily_summary_report import SummaryMetadata, SummarySources, build_summary_document
from analysis.input_fingerprint import RawFileEntry, SourceFingerprint
from analysis.nem_day import FIVE_MINUTE_INTERVALS_PER_DAY, HALF_HOUR_INTERVAL, HALF_HOURS_PER_DAY

FOUR_HOUR_BATTERY = BatterySpecification(
    power_mw=5, capacity_mwh=20, marginal_loss_factor=1, round_trip_efficiency=1, degradation_cost_aud_per_mwh=0
)
ONE_HOUR_BATTERY = BatterySpecification(
    power_mw=5, capacity_mwh=5, marginal_loss_factor=1, round_trip_efficiency=1, degradation_cost_aud_per_mwh=0
)
FIRST_DAY = date(2025, 4, 10)
GENERATED_AT = datetime(2026, 10, 20, 0, 0, 0, tzinfo=UTC)
FINGERPRINT = SourceFingerprint(code_files={"analysis/a.py": "1"}, external_files={"config/battery.json": "2"}, combined_sha256="3")
RAW_MANIFEST = (RawFileEntry("2025-01_2025-12/trading_price.csv", 10, "4"),)
ONE_CYCLE_PRICES = [0.0] * 8 + [100.0] * 8 + [50.0] * (HALF_HOURS_PER_DAY - 16)


def build_half_hour_day(trading_date: date, price_values: list[float]) -> dict[datetime, float]:
    """把一天的 30 分鐘電價依序放到結束時間 00:30、01:00、…、24:00。"""
    day_start = datetime.combine(trading_date, datetime.min.time())
    return {
        day_start + (half_hour_index + 1) * HALF_HOUR_INTERVAL: price_value
        for half_hour_index, price_value in enumerate(price_values)
    }


def build_document(
    daily_plans: DailyPlanResult,
    five_minute_counts: dict[date, int] | None = None,
    start_date: date = FIRST_DAY,
    battery_specification: BatterySpecification = FOUR_HOUR_BATTERY,
) -> dict[str, object]:
    """以測試用的指紋與產生時間組出文件；沒給筆數時每個有計畫的日子都當作 288 筆。"""
    counts = five_minute_counts
    if counts is None:
        counts = {trading_date: FIVE_MINUTE_INTERVALS_PER_DAY for trading_date in daily_plans.plans_by_date}
    return build_summary_document(
        SummarySources("NSW1", daily_plans, counts),
        FINGERPRINT,
        RAW_MANIFEST,
        SummaryMetadata(GENERATED_AT, battery_specification),
        start_date,
    )


def test_one_cycle_day_records_times_prices_spread_and_net_value() -> None:
    """00:00 充、04:00 放的單循環日：記錄 NEM 時間、兩段均價、價差 100 與淨收益 2000。"""
    daily_plans = compute_daily_plans(build_half_hour_day(FIRST_DAY, ONE_CYCLE_PRICES), FOUR_HOUR_BATTERY)

    day_entry = build_document(daily_plans)["days"][0]

    assert day_entry == {
        "date": "2025-04-10",
        "excluded": False,
        "exclusion_reason": None,
        "net_value_aud": 2000.0,
        "best_spread_aud_per_mwh": 100.0,
        "cycles": [
            {
                "charge_start": "2025-04-10T00:00",
                "discharge_start": "2025-04-10T04:00",
                "charge_average_price_aud_per_mwh": 0.0,
                "discharge_average_price_aud_per_mwh": 100.0,
                "spread_aud_per_mwh": 100.0,
                "net_value_aud": 2000.0,
            }
        ],
    }


def test_two_cycle_day_records_each_cycle_spread_and_minimum_as_best() -> None:
    """兩個循環（價差 100 與 60）：各循環分別記錄價差，best_spread 取較小的 60，供 #32 判斷每個循環 ≥ 標準。"""
    price_values = [0.0, 0.0, 100.0, 100.0, 0.0, 0.0, 60.0, 60.0] + [30.0] * (HALF_HOURS_PER_DAY - 8)
    daily_plans = compute_daily_plans(build_half_hour_day(FIRST_DAY, price_values), ONE_HOUR_BATTERY)

    day_entry = build_document(daily_plans, battery_specification=ONE_HOUR_BATTERY)["days"][0]

    assert [cycle_entry["spread_aud_per_mwh"] for cycle_entry in day_entry["cycles"]] == [100.0, 60.0]
    assert day_entry["best_spread_aud_per_mwh"] == 60.0
    assert day_entry["net_value_aud"] == pytest.approx(sum(cycle["net_value_aud"] for cycle in day_entry["cycles"]))


def test_complete_day_without_profitable_cycle_is_included_with_zero_value() -> None:
    """資料完整但電價持平：不排除，淨收益 0、沒有循環、best_spread 為 null。"""
    flat_day = build_half_hour_day(FIRST_DAY, [50.0] * HALF_HOURS_PER_DAY)

    day_entry = build_document(compute_daily_plans(flat_day, FOUR_HOUR_BATTERY))["days"][0]

    assert day_entry["excluded"] is False
    assert day_entry["net_value_aud"] == 0
    assert day_entry["cycles"] == []
    assert day_entry["best_spread_aud_per_mwh"] is None


def test_missing_and_incomplete_days_are_excluded_with_reasons() -> None:
    """期間中間完全沒資料的日子與 5 分鐘電價只有 287 筆的日子：都列出、標為排除並寫明原因。"""
    first_day = build_half_hour_day(FIRST_DAY, ONE_CYCLE_PRICES)
    incomplete_day = build_half_hour_day(FIRST_DAY + timedelta(days=1), ONE_CYCLE_PRICES[:-1])
    last_day = build_half_hour_day(FIRST_DAY + timedelta(days=3), ONE_CYCLE_PRICES)
    daily_plans = compute_daily_plans({**first_day, **incomplete_day, **last_day}, FOUR_HOUR_BATTERY)
    five_minute_counts = {FIRST_DAY: 288, FIRST_DAY + timedelta(days=1): 287, FIRST_DAY + timedelta(days=3): 288}

    summary_document = build_document(daily_plans, five_minute_counts)

    excluded_entries = [day_entry for day_entry in summary_document["days"] if day_entry["excluded"]]
    assert [(day_entry["date"], day_entry["exclusion_reason"]) for day_entry in excluded_entries] == [
        ("2025-04-11", "5 分鐘電價只有 287 筆（應為 288 筆）"),
        ("2025-04-12", "沒有電價資料"),
    ]
    assert all(day_entry["net_value_aud"] is None and day_entry["cycles"] == [] for day_entry in excluded_entries)
    assert summary_document["period"] == {
        "start_date": "2025-04-10",
        "end_date": "2025-04-13",
        "day_count": 4,
        "included_day_count": 2,
        "excluded_day_count": 2,
    }


def test_days_before_start_date_are_left_out() -> None:
    """期間第一天之前的完整交易日不輸出，也不算在天數裡。"""
    earlier_day = build_half_hour_day(FIRST_DAY - timedelta(days=1), ONE_CYCLE_PRICES)
    start_day = build_half_hour_day(FIRST_DAY, ONE_CYCLE_PRICES)
    daily_plans = compute_daily_plans({**earlier_day, **start_day}, FOUR_HOUR_BATTERY)

    summary_document = build_document(daily_plans)

    assert [day_entry["date"] for day_entry in summary_document["days"]] == ["2025-04-10"]


def test_period_ends_at_last_complete_day() -> None:
    """最後一天資料不完整：期間訖日停在前一個完整交易日，不把尾端的不完整日列為排除。"""
    complete_day = build_half_hour_day(FIRST_DAY, ONE_CYCLE_PRICES)
    trailing_day = build_half_hour_day(FIRST_DAY + timedelta(days=1), ONE_CYCLE_PRICES[:10])
    daily_plans = compute_daily_plans({**complete_day, **trailing_day}, FOUR_HOUR_BATTERY)

    summary_document = build_document(daily_plans, {FIRST_DAY: 288, FIRST_DAY + timedelta(days=1): 60})

    assert summary_document["period"]["end_date"] == "2025-04-10"
    assert summary_document["period"]["excluded_day_count"] == 0


def test_no_complete_day_after_start_raises() -> None:
    """期間第一天之後沒有任何完整交易日：丟出指出起始日的 ValueError。"""
    daily_plans = compute_daily_plans(build_half_hour_day(FIRST_DAY, ONE_CYCLE_PRICES), FOUR_HOUR_BATTERY)

    with pytest.raises(ValueError, match="2025-04-11"):
        build_document(daily_plans, start_date=FIRST_DAY + timedelta(days=1))


def test_document_records_metadata_battery_and_fingerprint() -> None:
    """文件帶格式版本、UTC 產生時間、區域、電池規格與輸入指紋（含原始檔清單）。"""
    daily_plans = compute_daily_plans(build_half_hour_day(FIRST_DAY, ONE_CYCLE_PRICES), FOUR_HOUR_BATTERY)

    summary_document = build_document(daily_plans)

    assert summary_document["schema_version"] == 1
    assert summary_document["generated_at"] == "2026-10-20T00:00:00Z"
    assert summary_document["region_id"] == "NSW1"
    assert summary_document["battery_specification"]["capacity_mwh"] == 20
    assert summary_document["input_fingerprint"]["combined_sha256"] == "3"
    assert summary_document["input_fingerprint"]["raw_input_files"] == [
        {"relative_path": "2025-01_2025-12/trading_price.csv", "size_bytes": 10, "sha256": "4"}
    ]
