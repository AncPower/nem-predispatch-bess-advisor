"""以 HiGHS 求各因素對每日套利收益的權重（純計算）。

模型（2026-10-19 決定）：

1. 目標 y = log(1 + 收益)，再轉 z 分數；每個因素也轉 z 分數（母體標準差）。
2. 方向 s_k = 因素與目標的 Pearson 相關係數的正負號，相關係數為 0 時取 +1。
3. 線性規劃（L1）：min Σ|e_d|，限制 c + Σ_k v_k·s_k·z_kd + e_d = z_yd，v_k ≥ 0，截距 c 不設限。
4. 權重 w_k = v_k / Σv（非負、加總為 1）；scale β = Σv。Σv = 0 時無法正規化，直接停止。

預測：log 收益 = 目標平均 + 目標標準差 × (c + β·Σ_k w_k·s_k·z_k)。
"""

from dataclasses import dataclass

import highspy
import numpy as np

POSITIVE_DIRECTION: int = 1
INTERCEPT_COLUMN: int = 0
FIRST_COEFFICIENT_COLUMN: int = 1
NEGATIVE_DIRECTION: int = -1


@dataclass(frozen=True)
class StandardizedMatrix:
    """標準化後的矩陣與每欄原本的平均、母體標準差。"""

    standardized_values: np.ndarray
    column_means: np.ndarray
    column_standard_deviations: np.ndarray


@dataclass(frozen=True)
class StandardizedTarget:
    """標準化後的目標，與原本的平均、母體標準差。"""

    standardized_values: np.ndarray
    target_mean: float
    target_standard_deviation: float


@dataclass(frozen=True)
class FactorDirections:
    """每個因素與目標的相關係數，以及據此決定的方向（+1／−1）。"""

    correlations: np.ndarray
    directions: np.ndarray


@dataclass(frozen=True)
class LinearFit:
    """L1 迴歸的截距與非負係數。"""

    intercept: float
    coefficients: np.ndarray


@dataclass(frozen=True)
class FitQuality:
    """擬合品質：R² 與 MAE 都以 log(1 + 收益) 尺度計算，另附換回 AUD 的 MAE。"""

    r_squared: float
    mean_absolute_error_log: float
    mean_absolute_error_aud: float


@dataclass(frozen=True)
class FactorFit:
    """單一因素的求解結果。"""

    factor_weight: float
    direction: int
    correlation: float
    factor_mean: float
    factor_standard_deviation: float


@dataclass(frozen=True)
class WeightSolution:
    """整體求解結果：各因素依輸入欄的順序排列。"""

    factor_fits: tuple[FactorFit, ...]
    intercept: float
    scale: float
    target_mean: float
    target_standard_deviation: float
    fit_quality: FitQuality


def standardize_columns(value_matrix: np.ndarray) -> StandardizedMatrix:
    """每欄減平均、除以母體標準差。

    Args:
        value_matrix: 列為日子、欄為變數的矩陣；一維陣列視為單欄。

    Returns:
        標準化結果。

    Raises:
        ValueError: 某欄標準差為 0 時，訊息帶欄號（1 起算）。
    """
    column_matrix = value_matrix.reshape(len(value_matrix), -1)
    column_means = column_matrix.mean(axis=0)
    column_standard_deviations = column_matrix.std(axis=0)
    for column_index, column_deviation in enumerate(column_standard_deviations, start=1):
        if column_deviation == 0.0:
            raise ValueError(f"第 {column_index} 欄所有值相同，無法標準化")
    standardized_values = (column_matrix - column_means) / column_standard_deviations
    return StandardizedMatrix(standardized_values, column_means, column_standard_deviations)


def standardize_target(target_values: np.ndarray) -> StandardizedTarget:
    """把一維目標標準化。

    Args:
        target_values: 長度 n 的目標。

    Returns:
        標準化後的目標與其平均、標準差。

    Raises:
        ValueError: 目標所有值相同時。
    """
    standardized_matrix = standardize_columns(target_values)
    (target_mean,) = standardized_matrix.column_means
    (target_deviation,) = standardized_matrix.column_standard_deviations
    return StandardizedTarget(standardized_matrix.standardized_values.ravel(), float(target_mean), float(target_deviation))


def compute_directions(standardized_factors: np.ndarray, standardized_target: np.ndarray) -> FactorDirections:
    """各因素與目標的 Pearson 相關係數與方向。

    Args:
        standardized_factors: 標準化後的因素矩陣。
        standardized_target: 標準化後的目標。

    Returns:
        相關係數與方向；相關係數為 0 時方向取 +1。
    """
    correlations = standardized_factors.T @ standardized_target / len(standardized_target)
    directions = np.where(correlations >= 0.0, POSITIVE_DIRECTION, NEGATIVE_DIRECTION)
    return FactorDirections(correlations, directions)


@dataclass(frozen=True)
class ColumnwiseMatrix:
    """以欄為主的稀疏矩陣（HiGHS 的 `kColwise` 格式）。"""

    column_starts: np.ndarray
    row_indices: np.ndarray
    entry_values: np.ndarray


def build_constraint_matrix(design_matrix: np.ndarray) -> ColumnwiseMatrix:
    """L1 迴歸的限制式矩陣：欄依序為截距（全 1）、各係數、正誤差（+1）、負誤差（−1）。

    Args:
        design_matrix: n 列 k 欄的設計矩陣。

    Returns:
        以欄為主的稀疏矩陣。
    """
    row_count, coefficient_count = design_matrix.shape
    row_indices = np.arange(row_count)
    dense_columns = [np.ones(row_count)] + [design_matrix[:, column_index] for column_index in range(coefficient_count)]
    dense_starts = np.arange(len(dense_columns)) * row_count
    error_starts = row_count * len(dense_columns) + np.arange(2 * row_count + 1)
    return ColumnwiseMatrix(
        column_starts=np.concatenate([dense_starts, error_starts]).astype(np.int32),
        row_indices=np.concatenate([np.tile(row_indices, len(dense_columns)), row_indices, row_indices]).astype(np.int32),
        entry_values=np.concatenate(dense_columns + [np.ones(row_count), -np.ones(row_count)]),
    )


def build_l1_problem(design_matrix: np.ndarray, target_values: np.ndarray) -> highspy.HighsLp:
    """組 L1 迴歸的線性規劃：目標為正、負誤差總和最小，截距不設限，其餘變數非負。

    Args:
        design_matrix: n 列 k 欄的設計矩陣。
        target_values: 長度 n 的目標。

    Returns:
        HiGHS 的 LP 模型。
    """
    row_count, coefficient_count = design_matrix.shape
    error_count = 2 * row_count
    constraint_matrix = build_constraint_matrix(design_matrix)
    linear_problem = highspy.HighsLp()
    linear_problem.num_col_ = 1 + coefficient_count + error_count
    linear_problem.num_row_ = row_count
    linear_problem.col_cost_ = np.concatenate([np.zeros(1 + coefficient_count), np.ones(error_count)])
    linear_problem.col_lower_ = np.concatenate([[-highspy.kHighsInf], np.zeros(coefficient_count + error_count)])
    linear_problem.col_upper_ = np.full(linear_problem.num_col_, highspy.kHighsInf)
    linear_problem.row_lower_ = target_values.astype(float)
    linear_problem.row_upper_ = target_values.astype(float)
    linear_problem.a_matrix_.format_ = highspy.MatrixFormat.kColwise
    linear_problem.a_matrix_.start_ = constraint_matrix.column_starts
    linear_problem.a_matrix_.index_ = constraint_matrix.row_indices
    linear_problem.a_matrix_.value_ = constraint_matrix.entry_values
    return linear_problem


def solve_l1_nonnegative(design_matrix: np.ndarray, target_values: np.ndarray) -> LinearFit:
    """解「截距不設限、係數非負」的最小絕對誤差迴歸。

    Args:
        design_matrix: n 列 k 欄的設計矩陣。
        target_values: 長度 n 的目標。

    Returns:
        截距與係數。

    Raises:
        ValueError: 列數與目標長度不同時。
        RuntimeError: HiGHS 沒有找到最佳解時，訊息帶求解狀態。
    """
    row_count, coefficient_count = design_matrix.shape
    if row_count != len(target_values):
        raise ValueError(f"設計矩陣列數 {row_count} 與目標長度 {len(target_values)} 不同")
    highs_solver = highspy.Highs()
    highs_solver.setOptionValue("output_flag", False)
    highs_solver.passModel(build_l1_problem(design_matrix, target_values))
    highs_solver.run()
    model_status = highs_solver.getModelStatus()
    if model_status != highspy.HighsModelStatus.kOptimal:
        raise RuntimeError(f"HiGHS 求解失敗，狀態為 {highs_solver.modelStatusToString(model_status)}")
    column_values = np.array(highs_solver.getSolution().col_value)
    coefficient_values = column_values[FIRST_COEFFICIENT_COLUMN : FIRST_COEFFICIENT_COLUMN + coefficient_count]
    return LinearFit(float(column_values[INTERCEPT_COLUMN]), np.clip(coefficient_values, 0.0, None))


def compute_scale(coefficients: np.ndarray) -> float:
    """非負係數的總和 β，用來把係數正規化成加總為 1 的權重。

    Args:
        coefficients: 非負係數。

    Returns:
        係數總和。

    Raises:
        ValueError: 總和不大於 0（係數全為 0）時。
    """
    scale = float(coefficients.sum())
    if scale <= 0.0:
        raise ValueError("所有因素的係數全為 0，權重無法正規化")
    return scale


def evaluate_fit(log_target: np.ndarray, predicted_log: np.ndarray, revenue_values: np.ndarray) -> FitQuality:
    """計算擬合品質。

    Args:
        log_target: 實際的 log(1 + 收益)。
        predicted_log: 預測的 log(1 + 收益)。
        revenue_values: 實際收益（AUD）。

    Returns:
        R²、log 尺度 MAE、換回 AUD 的 MAE。
    """
    residuals = log_target - predicted_log
    total_variation = float(((log_target - log_target.mean()) ** 2).sum())
    return FitQuality(
        r_squared=1.0 - float((residuals**2).sum()) / total_variation,
        mean_absolute_error_log=float(np.abs(residuals).mean()),
        mean_absolute_error_aud=float(np.abs(revenue_values - np.expm1(predicted_log)).mean()),
    )


def build_factor_fits(
    linear_fit: LinearFit, factor_directions: FactorDirections, standardized_factors: StandardizedMatrix, scale: float
) -> tuple[FactorFit, ...]:
    """把係數、方向與標準化參數整理成每個因素一筆結果。

    Args:
        linear_fit: L1 迴歸結果。
        factor_directions: 相關係數與方向。
        standardized_factors: 因素的標準化參數。
        scale: 係數總和 β。

    Returns:
        依輸入欄順序的因素結果；權重為係數 ÷ β。
    """
    return tuple(
        FactorFit(
            factor_weight=float(linear_fit.coefficients[column_index] / scale),
            direction=int(factor_directions.directions[column_index]),
            correlation=float(factor_directions.correlations[column_index]),
            factor_mean=float(standardized_factors.column_means[column_index]),
            factor_standard_deviation=float(standardized_factors.column_standard_deviations[column_index]),
        )
        for column_index in range(len(linear_fit.coefficients))
    )


def solve_factor_weights(factor_values: np.ndarray, revenue_values: np.ndarray) -> WeightSolution:
    """依模組說明的模型求權重。

    Args:
        factor_values: n 列 k 欄，欄為因素的原始值。
        revenue_values: 長度 n 的每日收益（AUD，不得為負）。

    Returns:
        各因素的權重、方向、相關係數與標準化參數，以及截距、scale 與擬合品質。

    Raises:
        ValueError: 收益為負、某欄為常數，或係數全為 0 時。
    """
    if np.any(revenue_values < 0.0):
        raise ValueError("每日收益不得為負，log(1 + 收益) 的前提不成立")
    log_target = np.log1p(revenue_values)
    standardized_target = standardize_target(log_target)
    target_z = standardized_target.standardized_values
    standardized_factors = standardize_columns(factor_values)
    factor_directions = compute_directions(standardized_factors.standardized_values, target_z)
    signed_factors = standardized_factors.standardized_values * factor_directions.directions
    linear_fit = solve_l1_nonnegative(signed_factors, target_z)
    scale = compute_scale(linear_fit.coefficients)
    target_mean = standardized_target.target_mean
    target_deviation = standardized_target.target_standard_deviation
    predicted_log = target_mean + target_deviation * (linear_fit.intercept + signed_factors @ linear_fit.coefficients)
    return WeightSolution(
        factor_fits=build_factor_fits(linear_fit, factor_directions, standardized_factors, scale),
        intercept=linear_fit.intercept,
        scale=scale,
        target_mean=target_mean,
        target_standard_deviation=target_deviation,
        fit_quality=evaluate_fit(log_target, predicted_log, revenue_values),
    )
