"""`analysis.factor_weights_report` 的單元測試。"""

from datetime import UTC, date, datetime, timedelta, timezone

import numpy as np
import pytest

from analysis.arbitrage_plan import BatterySpecification
from analysis.factor_dataset import FACTOR_DEFINITIONS, ExcludedDay, FactorDataset
from analysis.factor_weights_report import (
    PENDING_FACTORS,
    ReportMetadata,
    build_report_document,
    compute_latest_value,
    compute_monthly_baseline,
    format_utc_timestamp,
)
from analysis.input_fingerprint import RawFileEntry, SourceFingerprint
from analysis.weight_solver import FactorFit, FitQuality, WeightSolution

GENERATED_AT = datetime(2026, 10, 19, 3, 4, 5, tzinfo=UTC)


def build_sample_inputs() -> tuple[FactorDataset, WeightSolution]:
    """組兩天、六個因素的資料集與對應的求解結果。"""
    factor_count = len(FACTOR_DEFINITIONS)
    factor_dataset = FactorDataset(
        trading_dates=(date(2024, 7, 1), date(2024, 8, 1)),
        factor_values=np.arange(2 * factor_count, dtype=float).reshape(2, factor_count),
        revenue_values=np.array([1000.0, 3000.0]),
        excluded_days=(ExcludedDay(date(2024, 7, 15), "沒有雪梨天然氣事前價"),),
    )
    factor_fits = tuple(FactorFit(1.0 / factor_count, 1, 0.1, 5.0, 2.0) for _definition in FACTOR_DEFINITIONS)
    weight_solution = WeightSolution(factor_fits, 0.01, 0.8, 7.5, 0.9, FitQuality(0.5, 0.4, 1500.0))
    return factor_dataset, weight_solution


def build_sample_document() -> dict[str, object]:
    """以範例輸入組出完整的 JSON 文件。"""
    factor_dataset, weight_solution = build_sample_inputs()
    source_fingerprint = SourceFingerprint({"analysis/a.py": "aa"}, {"data/external/b.csv": "bb"}, "cc")
    raw_manifest = (RawFileEntry("2024-01_2024-12/trading_price.csv", 10, "dd"),)
    report_metadata = ReportMetadata(GENERATED_AT, "1.15.1", BatterySpecification(5, 20, 1, 1, 0))
    return build_report_document(factor_dataset, weight_solution, source_fingerprint, raw_manifest, report_metadata)


def test_format_utc_timestamp_uses_z_suffix() -> None:
    """UTC 時間：格式為 %Y-%m-%dT%H:%M:%SZ。"""
    assert format_utc_timestamp(GENERATED_AT) == "2026-10-19T03:04:05Z"


def test_format_utc_timestamp_converts_offset_time_to_utc() -> None:
    """帶時差的時間：先換成 UTC 再格式化。"""
    sydney_time = datetime(2026, 10, 19, 13, 4, 5, tzinfo=timezone(timedelta(hours=10)))

    assert format_utc_timestamp(sydney_time) == "2026-10-19T03:04:05Z"


def test_format_utc_timestamp_rejects_naive_time() -> None:
    """沒有時區的時間：丟出 ValueError。"""
    with pytest.raises(ValueError, match="時區"):
        format_utc_timestamp(datetime(2026, 10, 19, 3, 4, 5))


def test_compute_monthly_baseline_is_median_per_calendar_month() -> None:
    """不同年份的同一月份合併：每個日曆月份取中位數，鍵為兩位數月份。"""
    trading_dates = (date(2024, 7, 1), date(2024, 7, 2), date(2025, 7, 1), date(2025, 8, 1))
    column_values = np.array([1.0, 2.0, 10.0, 5.0])

    assert compute_monthly_baseline(trading_dates, column_values) == {"07": 2.0, "08": 5.0}


def test_compute_latest_value_uses_last_year_month_median() -> None:
    """最近一個年月：取該月每日值的中位數，並記下年月。"""
    trading_dates = (date(2026, 7, 31), date(2026, 8, 1), date(2026, 8, 2), date(2026, 8, 3))
    column_values = np.array([100.0, 3.0, 1.0, 2.0])

    latest_value = compute_latest_value(trading_dates, column_values)

    assert latest_value.year_month == "2026-08"
    assert latest_value.value == 2.0


def test_build_report_document_contains_required_sections() -> None:
    """JSON 文件：含產生時間、期間、目標、模型、因素、待加入因素、擬合品質與指紋。"""
    report_document = build_sample_document()

    assert report_document["generated_at"] == "2026-10-19T03:04:05Z"
    assert report_document["period"] == {
        "start_date": "2024-07-01",
        "end_date": "2024-08-01",
        "day_count": 2,
        "excluded_days": [{"date": "2024-07-15", "reason": "沒有雪梨天然氣事前價"}],
    }
    assert report_document["model"]["intercept"] == 0.01
    assert report_document["model"]["scale"] == 0.8
    assert report_document["fit_quality"] == {
        "r_squared": 0.5,
        "mean_absolute_error_log": 0.4,
        "mean_absolute_error_aud": 1500.0,
    }
    assert report_document["input_fingerprint"]["combined_sha256"] == "cc"
    assert report_document["input_fingerprint"]["raw_input_files"][0]["relative_path"] == "2024-01_2024-12/trading_price.csv"


def test_build_report_document_lists_every_factor_with_baselines() -> None:
    """每個因素一筆：名稱依定義順序，含權重、方向、相關係數、標準化參數、月份基準與最近值。"""
    factor_entries = build_sample_document()["factors"]

    assert [factor_entry["factor_name"] for factor_entry in factor_entries] == [
        definition.factor_name for definition in FACTOR_DEFINITIONS
    ]
    assert set(factor_entries[0]) == {
        "factor_name",
        "unit",
        "description",
        "weight",
        "direction",
        "correlation",
        "mean",
        "standard_deviation",
        "monthly_baseline",
        "latest_value",
    }
    assert factor_entries[0]["monthly_baseline"] == {"07": 0.0, "08": 6.0}
    assert factor_entries[0]["latest_value"] == {"year_month": "2024-08", "value": 6.0}


def test_build_report_document_marks_pending_factors_with_zero_weight() -> None:
    """尚未加入的因素：權重為 0，且包含特殊事件（#14）。"""
    pending_entries = build_sample_document()["pending_factors"]

    assert len(pending_entries) == len(PENDING_FACTORS)
    assert all(pending_entry["weight"] == 0 for pending_entry in pending_entries)
    assert "special_events" in [pending_entry["factor_name"] for pending_entry in pending_entries]
