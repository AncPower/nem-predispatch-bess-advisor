"""`analysis.arbitrage_plan` 的單元測試：以共用案例確認和 `src/window_selection.js` 結果相同。"""

import json
import math
from dataclasses import asdict, replace
from pathlib import Path
from typing import Any

import pytest

from analysis.arbitrage_plan import (
    BatterySpecification,
    break_even_spread,
    round_half_up,
    segment_length_for,
    select_best_plan,
)

FIXTURE_FILE: Path = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "select_best_plan_cases.json"
FIXTURE_CASES: list[dict[str, Any]] = json.loads(FIXTURE_FILE.read_text(encoding="utf-8"))["cases"]
FOUR_HOUR_BATTERY = BatterySpecification(
    power_mw=5, capacity_mwh=20, marginal_loss_factor=1, round_trip_efficiency=1, degradation_cost_aud_per_mwh=0
)
ONE_INTERVAL_BATTERY = BatterySpecification(
    power_mw=2, capacity_mwh=1, marginal_loss_factor=1, round_trip_efficiency=1, degradation_cost_aud_per_mwh=0
)


def test_fixture_has_cases() -> None:
    """共用案例檔至少有一筆案例。"""
    assert len(FIXTURE_CASES) > 0


@pytest.mark.parametrize("fixture_case", FIXTURE_CASES, ids=[fixture_case["case_name"] for fixture_case in FIXTURE_CASES])
def test_select_best_plan_matches_javascript_fixture(fixture_case: dict[str, Any]) -> None:
    """每個共用案例：Python 版的結果與 JS 版算出的預期值完全相同。"""
    battery_specification = BatterySpecification(**fixture_case["battery_specification"])

    plan_result = select_best_plan(
        fixture_case["price_values"], battery_specification, fixture_case["minimum_cycle_spread"]
    )

    plan_fields = asdict(plan_result)
    assert {**plan_fields, "cycles": list(plan_fields["cycles"])} == fixture_case["expected"]


def test_segment_length_for_four_hour_battery_is_eight_half_hours() -> None:
    """5 MW／20 MWh 的電池：每段為 8 個 30 分鐘時段。"""
    assert segment_length_for(FOUR_HOUR_BATTERY) == 8


def test_segment_length_for_short_battery_is_at_least_one() -> None:
    """滿充不到 30 分鐘的電池：每段至少 1 個時段。"""
    short_battery = replace(FOUR_HOUR_BATTERY, power_mw=100, capacity_mwh=1)

    assert segment_length_for(short_battery) == 1


@pytest.mark.parametrize(
    ("input_value", "expected_integer"),
    [(2.5, 3), (3.5, 4), (-2.5, -2), (-2.6, -3), (0.49999999999999994, 0), (7.0, 7)],
)
def test_round_half_up_matches_javascript_math_round(input_value: float, expected_integer: int) -> None:
    """取整：剛好 .5 時往正方向，結果與 JS 的 Math.round 相同。"""
    assert round_half_up(input_value) == expected_integer


@pytest.mark.parametrize("bad_price", [math.nan, math.inf, -math.inf])
def test_select_best_plan_rejects_non_finite_price(bad_price: float) -> None:
    """電價含 NaN 或無限大：丟出 ValueError。"""
    with pytest.raises(ValueError, match="非數值"):
        select_best_plan([10.0, bad_price], FOUR_HOUR_BATTERY)


@pytest.mark.parametrize("bad_spread", [-1.0, math.nan])
def test_select_best_plan_rejects_invalid_minimum_spread(bad_spread: float) -> None:
    """最低價差為負或 NaN：丟出 ValueError。"""
    with pytest.raises(ValueError, match="最低價差"):
        select_best_plan([10.0, 20.0], FOUR_HOUR_BATTERY, bad_spread)


@pytest.mark.parametrize(
    ("override_fields", "error_pattern"),
    [
        ({"round_trip_efficiency": 0}, "來回效率"),
        ({"round_trip_efficiency": 1.01}, "來回效率"),
        ({"round_trip_efficiency": math.nan}, "來回效率"),
        ({"degradation_cost_aud_per_mwh": -1}, "損耗成本"),
        ({"degradation_cost_aud_per_mwh": math.inf}, "損耗成本"),
    ],
)
def test_select_best_plan_rejects_invalid_battery_costs(override_fields: dict[str, float], error_pattern: str) -> None:
    """來回效率不在 (0, 1] 或損耗成本為負、非有限：丟出 ValueError，與 JS 相同。"""
    with pytest.raises(ValueError, match=error_pattern):
        select_best_plan([0.0, 100.0], replace(ONE_INTERVAL_BATTERY, **override_fields))


def test_select_best_plan_degradation_cost_drops_small_spread() -> None:
    """損耗成本 15：不計損耗時會排兩個循環，計入後只排價差夠大的 2→3。"""
    price_values = [50.0, 60.0, 0.0, 100.0]

    lossless_plan = select_best_plan(price_values, ONE_INTERVAL_BATTERY)
    costly_plan = select_best_plan(price_values, replace(ONE_INTERVAL_BATTERY, degradation_cost_aud_per_mwh=15))

    assert len(lossless_plan.cycles) == 2
    assert [(cycle.charge_start_index, cycle.discharge_start_index) for cycle in costly_plan.cycles] == [(2, 3)]
    assert costly_plan.total_value == 85


@pytest.mark.parametrize(
    ("charge_average_price", "override_fields", "expected_spread"),
    [
        (100.0, {}, 0.0),
        (100.0, {"round_trip_efficiency": 0.8}, 25.0),
        (100.0, {"degradation_cost_aud_per_mwh": 9, "marginal_loss_factor": 0.9}, 10.0),
        (-40.0, {"round_trip_efficiency": 0.8}, -10.0),
        (100.0, {"round_trip_efficiency": 0.8, "degradation_cost_aud_per_mwh": 5}, 30.0),
    ],
)
def test_break_even_spread_matches_javascript(
    charge_average_price: float, override_fields: dict[str, float], expected_spread: float
) -> None:
    """損益兩平價差：充電均價 ×（1 ÷ 效率 − 1）＋ 損耗成本 ÷ MLF，與 JS 測試的值相同。"""
    battery_specification = replace(ONE_INTERVAL_BATTERY, **override_fields)

    assert break_even_spread(charge_average_price, battery_specification) == expected_spread
