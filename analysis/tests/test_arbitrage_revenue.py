"""`analysis.arbitrage_revenue` 的測試：與 JS 版共用案例一致，以及 5 分鐘轉 30 分鐘。"""

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

import pytest

from analysis.arbitrage_revenue import BatterySpec, average_into_half_hours, select_best_plan

FIXTURE_PATH = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "select_best_plan_cases.json"
FIXTURE_CASES: list[dict[str, Any]] = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


@pytest.mark.parametrize("fixture_case", FIXTURE_CASES, ids=[fixture_case["case_name"] for fixture_case in FIXTURE_CASES])
def test_select_best_plan_matches_javascript_fixture(fixture_case: dict[str, Any]) -> None:
    battery_spec = BatterySpec(**fixture_case["battery_spec"])

    plan_result = select_best_plan(fixture_case["price_values"], battery_spec, fixture_case["minimum_cycle_spread"])

    assert asdict(plan_result) == fixture_case["expected_plan"]


def test_select_best_plan_rejects_non_finite_price() -> None:
    with pytest.raises(ValueError, match="非數值"):
        select_best_plan([10.0, float("nan")], BatterySpec(power_mw=2, capacity_mwh=1, marginal_loss_factor=1))


def test_select_best_plan_rejects_negative_minimum_spread() -> None:
    with pytest.raises(ValueError, match="最低價差"):
        select_best_plan([10.0, 20.0], BatterySpec(power_mw=2, capacity_mwh=1, marginal_loss_factor=1), minimum_cycle_spread=-1)


def test_select_best_plan_returns_no_cycle_for_empty_prices() -> None:
    plan_result = select_best_plan([], BatterySpec(power_mw=5, capacity_mwh=20, marginal_loss_factor=1))

    assert plan_result.cycles == [] and plan_result.total_value == 0


def test_average_into_half_hours_averages_each_six_prices() -> None:
    half_hour_prices = average_into_half_hours([1, 2, 3, 4, 5, 6, 10, 10, 10, 10, 10, 10])

    assert half_hour_prices == [3.5, 10]


def test_average_into_half_hours_rejects_partial_block() -> None:
    with pytest.raises(ValueError, match="6 的倍數"):
        average_into_half_hours([1, 2, 3])
