"""`analysis.factor_weights` 的測試。"""

import math
from datetime import date, timedelta

import pytest

from analysis.factor_weights import (
    fit_factor_weights,
    monthly_medians,
    rank_values,
    solve_l1_weights,
    spearman_correlation,
    standardize_values,
    transform_revenue,
)


def test_standardize_values_returns_zero_mean_unit_deviation() -> None:
    standardized_series = standardize_values([1.0, 2.0, 3.0])

    assert standardized_series.series_mean == 2.0
    assert standardized_series.standard_scores == pytest.approx([-math.sqrt(1.5), 0.0, math.sqrt(1.5)])


@pytest.mark.parametrize("raw_values", [[5.0], [3.0, 3.0, 3.0]])
def test_standardize_values_rejects_single_or_constant_values(raw_values: list[float]) -> None:
    with pytest.raises(ValueError):
        standardize_values(raw_values)


def test_rank_values_averages_ties() -> None:
    assert rank_values([10.0, 20.0, 10.0, 30.0]) == [1.5, 3.0, 1.5, 4.0]


def test_spearman_correlation_detects_monotonic_decrease() -> None:
    assert spearman_correlation([1.0, 2.0, 3.0, 4.0], [100.0, 10.0, 5.0, 1.0]) == pytest.approx(-1.0)


def test_transform_revenue_rejects_negative_revenue() -> None:
    with pytest.raises(ValueError, match="不得為負"):
        transform_revenue([100.0, -1.0])


def test_solve_l1_weights_recovers_known_mixture() -> None:
    first_factor = [-2.0, -1.0, 0.0, 1.0, 2.0, 0.5]
    second_factor = [1.0, -1.0, 2.0, 0.0, -2.0, 1.5]
    target_scores = [0.25 * first_value + 0.75 * second_value + 0.1 for first_value, second_value in zip(first_factor, second_factor)]

    l1_solution = solve_l1_weights([list(day_scores) for day_scores in zip(first_factor, second_factor)], target_scores)

    assert l1_solution.weight_values == pytest.approx([0.25, 0.75], abs=1e-6)
    assert l1_solution.intercept_value == pytest.approx(0.1, abs=1e-6)


def test_solve_l1_weights_fits_median_not_mean_when_outlier_present() -> None:
    l1_solution = solve_l1_weights([[0.0], [0.0], [0.0], [0.0], [0.0]], [1.0, 2.0, 3.0, 4.0, 100.0])

    assert l1_solution.weight_values == pytest.approx([1.0])
    assert l1_solution.intercept_value == pytest.approx(3.0, abs=1e-6)


def test_solve_l1_weights_rejects_ragged_rows() -> None:
    with pytest.raises(ValueError, match="因素數必須相同"):
        solve_l1_weights([[1.0, 2.0], [3.0]], [1.0, 2.0])


def test_solve_l1_weights_rejects_mismatched_rows() -> None:
    with pytest.raises(ValueError, match="不一致"):
        solve_l1_weights([[1.0], [2.0]], [1.0])


def test_monthly_medians_groups_by_calendar_month_across_years() -> None:
    values_by_date = {date(2024, 1, 5): 1.0, date(2025, 1, 5): 3.0, date(2025, 1, 6): 100.0, date(2024, 7, 1): 7.0}

    assert monthly_medians(values_by_date) == {"01": 3.0, "07": 7.0}


def test_fit_factor_weights_flips_negative_factor_and_uses_common_dates() -> None:
    fit_dates = [date(2024, 7, 1) + timedelta(days=day_offset) for day_offset in range(30)]
    revenue_by_date = {fit_date: math.expm1(5 + 0.1 * day_offset) for day_offset, fit_date in enumerate(fit_dates)}
    rising_factor = {fit_date: float(day_offset) for day_offset, fit_date in enumerate(fit_dates)}
    falling_factor = {fit_date: float(-day_offset) for day_offset, fit_date in enumerate(fit_dates)}
    falling_factor[date(2024, 6, 30)] = 99.0

    weight_fit = fit_factor_weights({"rising_factor": rising_factor, "falling_factor": falling_factor}, revenue_by_date)

    assert weight_fit.fit_dates == fit_dates
    assert [factor_weight.direction_sign for factor_weight in weight_fit.factor_weights] == [1, -1]
    assert sum(factor_weight.weight_value for factor_weight in weight_fit.factor_weights) == pytest.approx(1.0)
    assert weight_fit.r_squared == pytest.approx(1.0)
    assert weight_fit.mean_absolute_error_aud == pytest.approx(0.0, abs=1e-6)


def test_fit_factor_weights_rejects_no_common_dates() -> None:
    with pytest.raises(ValueError, match="沒有任何日子"):
        fit_factor_weights({"only_factor": {date(2024, 1, 1): 1.0}}, {date(2024, 1, 2): 10.0})


def test_fit_factor_weights_names_constant_factor() -> None:
    fit_dates = [date(2024, 7, 1) + timedelta(days=day_offset) for day_offset in range(5)]
    revenue_by_date = {fit_date: 100.0 + day_offset for day_offset, fit_date in enumerate(fit_dates)}

    with pytest.raises(ValueError, match="constant_factor"):
        fit_factor_weights({"constant_factor": dict.fromkeys(fit_dates, 7.0)}, revenue_by_date)
