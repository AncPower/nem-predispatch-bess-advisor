"""`analysis.weight_solver` 的單元測試。"""

import math

import numpy as np
import pytest

from analysis.weight_solver import (
    compute_directions,
    compute_scale,
    evaluate_fit,
    solve_factor_weights,
    solve_l1_nonnegative,
    standardize_columns,
    standardize_target,
)

RANDOM_SEED = 20261019
SAMPLE_COUNT = 400


def build_random_factors(column_count: int) -> np.ndarray:
    """以固定種子產生 `SAMPLE_COUNT` 列、`column_count` 欄的常態亂數因素。"""
    random_generator = np.random.default_rng(RANDOM_SEED)
    return random_generator.normal(size=(SAMPLE_COUNT, column_count))


def test_standardize_columns_gives_zero_mean_unit_deviation() -> None:
    """每欄標準化：平均 0、母體標準差 1，並記下原本的平均與標準差。"""
    value_matrix = np.array([[1.0, 10.0], [3.0, 30.0], [5.0, 20.0]])

    standardized_matrix = standardize_columns(value_matrix)

    assert np.allclose(standardized_matrix.standardized_values.mean(axis=0), 0.0)
    assert np.allclose(standardized_matrix.standardized_values.std(axis=0), 1.0)
    assert np.allclose(standardized_matrix.column_means, [3.0, 20.0])


def test_standardize_columns_rejects_constant_column() -> None:
    """某欄所有值相同：無法標準化，丟出帶欄號的 ValueError。"""
    with pytest.raises(ValueError, match="第 2 欄"):
        standardize_columns(np.array([[1.0, 5.0], [2.0, 5.0]]))


def test_standardize_target_returns_vector_mean_and_deviation() -> None:
    """一維目標：回傳一維 z 分數與原本的平均、標準差。"""
    standardized_target = standardize_target(np.array([1.0, 3.0]))

    assert standardized_target.standardized_values.tolist() == [-1.0, 1.0]
    assert standardized_target.target_mean == 2.0
    assert standardized_target.target_standard_deviation == 1.0


def test_compute_directions_follows_correlation_sign() -> None:
    """與目標正相關為 +1、負相關為 −1、相關係數為 0 時取 +1。"""
    standardized_target = np.array([-1.0, -1.0, 1.0, 1.0])
    standardized_factors = np.array([[-1.0, 1.0, -1.0], [-1.0, 1.0, 1.0], [1.0, -1.0, -1.0], [1.0, -1.0, 1.0]])

    factor_directions = compute_directions(standardized_factors, standardized_target)

    assert np.allclose(factor_directions.correlations, [1.0, -1.0, 0.0])
    assert list(factor_directions.directions) == [1, -1, 1]


def test_solve_l1_nonnegative_recovers_exact_linear_relation() -> None:
    """目標恰為 1 + 2·x1 + 0.5·x2：解回截距與兩個係數。"""
    design_matrix = build_random_factors(2)
    target_values = 1.0 + 2.0 * design_matrix[:, 0] + 0.5 * design_matrix[:, 1]

    linear_fit = solve_l1_nonnegative(design_matrix, target_values)

    assert linear_fit.intercept == pytest.approx(1.0, abs=1e-6)
    assert np.allclose(linear_fit.coefficients, [2.0, 0.5], atol=1e-6)


def test_solve_l1_nonnegative_keeps_coefficients_non_negative() -> None:
    """目標與某欄反向：該欄係數被限制為 0，不會變成負值。"""
    design_matrix = build_random_factors(2)
    target_values = 3.0 * design_matrix[:, 0] - 1.0 * design_matrix[:, 1]

    linear_fit = solve_l1_nonnegative(design_matrix, target_values)

    assert linear_fit.coefficients[1] == pytest.approx(0.0, abs=1e-9)
    assert np.all(linear_fit.coefficients >= 0.0)


def test_solve_l1_nonnegative_rejects_shape_mismatch() -> None:
    """設計矩陣列數與目標長度不同：丟出 ValueError。"""
    with pytest.raises(ValueError, match="列數"):
        solve_l1_nonnegative(np.zeros((3, 2)), np.zeros(4))


def test_compute_scale_rejects_all_zero_coefficients() -> None:
    """所有係數都是 0：權重無法正規化，丟出 ValueError。"""
    with pytest.raises(ValueError, match="全為 0"):
        compute_scale(np.zeros(3))


def test_compute_scale_is_sum_of_coefficients() -> None:
    """scale 為係數總和。"""
    assert compute_scale(np.array([0.5, 0.25, 0.0])) == pytest.approx(0.75)


def test_evaluate_fit_perfect_prediction() -> None:
    """預測完全等於實際：R² 為 1，兩種 MAE 都為 0。"""
    revenue_values = np.array([0.0, 100.0, 2500.0])
    log_target = np.log1p(revenue_values)

    fit_quality = evaluate_fit(log_target, log_target, revenue_values)

    assert fit_quality.r_squared == pytest.approx(1.0)
    assert fit_quality.mean_absolute_error_log == pytest.approx(0.0)
    assert fit_quality.mean_absolute_error_aud == pytest.approx(0.0)


def test_evaluate_fit_reports_errors_in_log_and_aud() -> None:
    """預測偏差：log 尺度的 MAE 與換回 AUD 的 MAE 各自依定義計算。"""
    revenue_values = np.array([math.e - 1.0, math.e**3 - 1.0])
    log_target = np.array([1.0, 3.0])
    predicted_log = np.array([2.0, 2.0])

    fit_quality = evaluate_fit(log_target, predicted_log, revenue_values)

    assert fit_quality.r_squared == pytest.approx(0.0)
    assert fit_quality.mean_absolute_error_log == pytest.approx(1.0)
    assert fit_quality.mean_absolute_error_aud == pytest.approx(((math.e**2 - math.e) + (math.e**3 - math.e**2)) / 2)


def test_solve_factor_weights_gives_non_negative_weights_summing_to_one() -> None:
    """log 收益由兩個因素正向、一個反向決定，第四個無關：權重非負、加總為 1，方向與相關一致。"""
    factor_values = build_random_factors(4)
    log_revenue = 8.0 + 0.6 * factor_values[:, 0] + 0.3 * factor_values[:, 1] - 0.3 * factor_values[:, 2]
    revenue_values = np.expm1(log_revenue)

    weight_solution = solve_factor_weights(factor_values, revenue_values)

    factor_weights = np.array([factor_fit.factor_weight for factor_fit in weight_solution.factor_fits])
    assert np.all(factor_weights >= 0.0)
    assert factor_weights.sum() == pytest.approx(1.0)
    assert [factor_fit.direction for factor_fit in weight_solution.factor_fits][:3] == [1, 1, -1]
    assert factor_weights[0] == pytest.approx(0.5, abs=0.02)
    assert factor_weights[3] == pytest.approx(0.0, abs=0.02)
    assert weight_solution.fit_quality.r_squared == pytest.approx(1.0, abs=1e-6)


def test_solve_factor_weights_prediction_reconstructs_log_revenue() -> None:
    """用輸出的平均、標準差、方向、權重、scale、截距重建預測：與實際 log 收益相同（完全線性時）。"""
    factor_values = build_random_factors(2)
    log_revenue = 5.0 + 0.4 * factor_values[:, 0] - 0.2 * factor_values[:, 1]

    weight_solution = solve_factor_weights(factor_values, np.expm1(log_revenue))

    weighted_sum = sum(
        factor_fit.factor_weight
        * factor_fit.direction
        * (factor_values[:, column_index] - factor_fit.factor_mean)
        / factor_fit.factor_standard_deviation
        for column_index, factor_fit in enumerate(weight_solution.factor_fits)
    )
    predicted_standardized = weight_solution.intercept + weight_solution.scale * weighted_sum
    predicted_log = weight_solution.target_mean + weight_solution.target_standard_deviation * predicted_standardized
    assert np.allclose(predicted_log, log_revenue, atol=1e-6)


def test_solve_factor_weights_rejects_negative_revenue() -> None:
    """收益為負：log1p 前提不成立，丟出 ValueError。"""
    with pytest.raises(ValueError, match="收益"):
        solve_factor_weights(build_random_factors(2)[:3], np.array([10.0, -1.0, 5.0]))
