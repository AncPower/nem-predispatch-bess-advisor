"""`analysis.arbitrage_plan` 的單元測試：以共用案例確認和 `src/window_selection.js` 結果相同。"""

import json
import math
from dataclasses import asdict
from pathlib import Path
from typing import Any

import pytest

from analysis.arbitrage_plan import (
    BatterySpecification,
    round_half_up,
    segment_length_for,
    select_best_plan,
)

FIXTURE_FILE: Path = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "select_best_plan_cases.json"
FIXTURE_CASES: list[dict[str, Any]] = json.loads(FIXTURE_FILE.read_text(encoding="utf-8"))["cases"]
FOUR_HOUR_BATTERY = BatterySpecification(power_mw=5, capacity_mwh=20, marginal_loss_factor=1)


def test_fixture_has_cases() -> None:
    assert len(FIXTURE_CASES) > 0


@pytest.mark.parametrize("fixture_case", FIXTURE_CASES, ids=[fixture_case["case_name"] for fixture_case in FIXTURE_CASES])
def test_select_best_plan_matches_javascript_fixture(fixture_case: dict[str, Any]) -> None:
    battery_specification = BatterySpecification(**fixture_case["battery_specification"])

    plan_result = select_best_plan(
        fixture_case["price_values"], battery_specification, fixture_case["minimum_cycle_spread"]
    )

    plan_fields = asdict(plan_result)
    assert {**plan_fields, "cycles": list(plan_fields["cycles"])} == fixture_case["expected"]


def test_segment_length_for_four_hour_battery_is_eight_half_hours() -> None:
    assert segment_length_for(FOUR_HOUR_BATTERY) == 8


def test_segment_length_for_short_battery_is_at_least_one() -> None:
    short_battery = BatterySpecification(power_mw=100, capacity_mwh=1, marginal_loss_factor=1)

    assert segment_length_for(short_battery) == 1


@pytest.mark.parametrize(
    ("input_value", "expected_integer"),
    [(2.5, 3), (3.5, 4), (-2.5, -2), (-2.6, -3), (0.49999999999999994, 0), (7.0, 7)],
)
def test_round_half_up_matches_javascript_math_round(input_value: float, expected_integer: int) -> None:
    assert round_half_up(input_value) == expected_integer


@pytest.mark.parametrize("bad_price", [math.nan, math.inf, -math.inf])
def test_select_best_plan_rejects_non_finite_price(bad_price: float) -> None:
    with pytest.raises(ValueError, match="非數值"):
        select_best_plan([10.0, bad_price], FOUR_HOUR_BATTERY)


@pytest.mark.parametrize("bad_spread", [-1.0, math.nan])
def test_select_best_plan_rejects_invalid_minimum_spread(bad_spread: float) -> None:
    with pytest.raises(ValueError, match="最低價差"):
        select_best_plan([10.0, 20.0], FOUR_HOUR_BATTERY, bad_spread)
