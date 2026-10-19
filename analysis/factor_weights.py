"""以 HiGHS 求各因素對每日套利收益的權重（純計算，不讀寫檔案）。

做法：
- 收益先取 log(1 + 收益)：每日收益極度右偏，不轉換時少數價格尖峰日會主導擬合
  （實測數字與決定紀錄見 `docs/data_sources.md`〈分析輸出〉）。
- 收益與每個因素都轉成 z 分數；因素的正負號依它和收益的 Spearman 相關方向調整，讓方向一致。
- 解有限制條件的 L1 迴歸：權重非負、加總為 1，另有一個不受限的截距，最小化絕對誤差總和。
  L1 寫成線性規劃：每天的誤差拆成正、負兩個非負變數。
- 只用所有因素與收益都有值的日子擬合；每月基準值則用各因素自己的全部資料。
"""

import math
import statistics
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date

import highspy
import numpy

MONTH_KEYS = tuple(f"{month_number:02d}" for month_number in range(1, 13))
POSITIVE_DIRECTION = 1
NEGATIVE_DIRECTION = -1


@dataclass(frozen=True)
class StandardizedSeries:
    """z 分數與還原用的平均數、標準差（母體標準差）。"""

    series_mean: float
    standard_deviation: float
    standard_scores: list[float]


@dataclass(frozen=True)
class L1Solution:
    """L1 迴歸的權重（與輸入因素同順序）與截距。"""

    weight_values: list[float]
    intercept_value: float


@dataclass(frozen=True)
class FactorWeight:
    """單一因素的擬合結果。`direction_sign` 為 1 或 -1：1 代表因素越高、收益越高。"""

    factor_name: str
    weight_value: float
    direction_sign: int
    spearman_correlation: float
    factor_mean: float
    factor_standard_deviation: float
    monthly_baseline: dict[str, float]


@dataclass(frozen=True)
class FitQuality:
    """擬合品質：R² 與平均絕對誤差，兩者都在輸入值的尺度上計算。"""

    r_squared: float
    mean_absolute_error: float


@dataclass(frozen=True)
class FactorWeightFit:
    """整體擬合結果。

    收益在 log(1 + 收益) 尺度上標準化；R² 與 `mean_absolute_error_standardized` 在這個尺度計算，
    `mean_absolute_error_aud` 則是把預測值換算回 AUD 後與實際收益的平均絕對誤差。
    """

    fit_dates: list[date]
    revenue_log_mean: float
    revenue_log_standard_deviation: float
    revenue_median_aud: float
    intercept_value: float
    r_squared: float
    mean_absolute_error_standardized: float
    mean_absolute_error_aud: float
    factor_weights: list[FactorWeight]


def standardize_values(raw_values: Sequence[float]) -> StandardizedSeries:
    """轉成 z 分數。

    Args:
        raw_values: 原始值，至少兩筆。

    Returns:
        z 分數與平均數、標準差。

    Raises:
        ValueError: 少於兩筆，或所有值相同（標準差為 0）時。
    """
    if len(raw_values) < 2:
        raise ValueError(f"標準化至少需要兩筆資料：{len(raw_values)}")
    series_mean = statistics.fmean(raw_values)
    series_deviation = statistics.pstdev(raw_values, mu=series_mean)
    if series_deviation == 0:
        raise ValueError(f"所有值都相同（{raw_values[0]}），無法標準化")
    return StandardizedSeries(
        series_mean=series_mean,
        standard_deviation=series_deviation,
        standard_scores=[(raw_value - series_mean) / series_deviation for raw_value in raw_values],
    )


def rank_values(raw_values: Sequence[float]) -> list[float]:
    """由小到大排名（從 1 起算），同值取平均名次。

    Args:
        raw_values: 原始值。

    Returns:
        與輸入同順序的名次。
    """
    indexes_by_value = sorted(range(len(raw_values)), key=lambda original_index: raw_values[original_index])
    rank_list = [0.0] * len(raw_values)
    group_start = 0
    while group_start < len(indexes_by_value):
        group_end = group_start
        while group_end + 1 < len(indexes_by_value) and raw_values[indexes_by_value[group_end + 1]] == raw_values[indexes_by_value[group_start]]:
            group_end += 1
        average_rank = (group_start + group_end) / 2 + 1
        for sorted_index in range(group_start, group_end + 1):
            rank_list[indexes_by_value[sorted_index]] = average_rank
        group_start = group_end + 1
    return rank_list


def spearman_correlation(first_values: Sequence[float], second_values: Sequence[float]) -> float:
    """Spearman 等級相關係數；對收益的極端尖峰不敏感。

    Args:
        first_values: 第一組值。
        second_values: 第二組值，筆數與第一組相同。

    Returns:
        -1 到 1 之間的相關係數。
    """
    return statistics.correlation(rank_values(first_values), rank_values(second_values))


def solve_l1_weights(signed_scores: Sequence[Sequence[float]], target_scores: Sequence[float]) -> L1Solution:
    """用 HiGHS 解「權重非負、加總為 1、含截距」的 L1 迴歸。

    變數順序：K 個權重、1 個截距、n 個正誤差、n 個負誤差。
    第 i 列：Σ 權重 × 因素 + 截距 + 正誤差 − 負誤差 = 收益；最後一列：Σ 權重 = 1。

    Args:
        signed_scores: n 天 × K 個因素的 z 分數（已依方向調整正負號）。
        target_scores: n 天收益的 z 分數。

    Returns:
        權重與截距。

    Raises:
        ValueError: 沒有資料、沒有因素，或各列因素數不一致時。
        RuntimeError: HiGHS 沒有找到最佳解時。
    """
    day_count = len(target_scores)
    if day_count == 0 or len(signed_scores) != day_count:
        raise ValueError(f"因素列數 {len(signed_scores)} 與收益筆數 {day_count} 不一致或為 0")
    factor_count = len(signed_scores[0])
    if factor_count == 0 or any(len(day_scores) != factor_count for day_scores in signed_scores):
        raise ValueError(f"每一列的因素數必須相同且至少 1 個：第一列為 {factor_count}")
    highs_solver = highspy.Highs()
    highs_solver.setOptionValue("output_flag", False)
    add_l1_columns(highs_solver, factor_count, day_count)
    add_l1_rows(highs_solver, signed_scores, target_scores, factor_count)
    highs_solver.run()
    model_status = highs_solver.getModelStatus()
    if model_status != highspy.HighsModelStatus.kOptimal:
        raise RuntimeError(f"HiGHS 沒有找到最佳解：{highs_solver.modelStatusToString(model_status)}")
    column_values = list(highs_solver.getSolution().col_value)
    return L1Solution(weight_values=column_values[:factor_count], intercept_value=column_values[factor_count])


def add_l1_columns(highs_solver: highspy.Highs, factor_count: int, day_count: int) -> None:
    """加入 L1 迴歸的變數：權重 [0, 1]、截距不受限、誤差 ≥ 0（目標係數 1）。

    Args:
        highs_solver: HiGHS 求解器。
        factor_count: 因素數。
        day_count: 天數。
    """
    positive_infinity = highspy.kHighsInf
    column_count = factor_count + 1 + 2 * day_count
    column_costs = numpy.concatenate([numpy.zeros(factor_count + 1), numpy.ones(2 * day_count)])
    lower_bounds = numpy.concatenate([numpy.zeros(factor_count), [-positive_infinity], numpy.zeros(2 * day_count)])
    upper_bounds = numpy.concatenate([numpy.ones(factor_count), numpy.full(1 + 2 * day_count, positive_infinity)])
    empty_indexes = numpy.array([], dtype=numpy.int32)
    highs_solver.addCols(column_count, column_costs, lower_bounds, upper_bounds, 0, empty_indexes, empty_indexes, numpy.array([]))


def add_l1_rows(highs_solver: highspy.Highs, signed_scores: Sequence[Sequence[float]], target_scores: Sequence[float], factor_count: int) -> None:
    """加入每天的等式限制與「權重加總為 1」。

    Args:
        highs_solver: HiGHS 求解器。
        signed_scores: n 天 × K 個因素的 z 分數。
        target_scores: n 天收益的 z 分數。
        factor_count: 因素數。
    """
    day_count = len(target_scores)
    intercept_column = factor_count
    row_starts: list[int] = []
    column_indexes: list[int] = []
    coefficient_values: list[float] = []
    for day_index, day_scores in enumerate(signed_scores):
        row_starts.append(len(column_indexes))
        column_indexes.extend([*range(factor_count), intercept_column, intercept_column + 1 + day_index, intercept_column + 1 + day_count + day_index])
        coefficient_values.extend([*day_scores, 1.0, 1.0, -1.0])
    row_starts.append(len(column_indexes))
    column_indexes.extend(range(factor_count))
    coefficient_values.extend([1.0] * factor_count)
    row_bounds = numpy.array([*target_scores, 1.0])
    highs_solver.addRows(
        day_count + 1,
        row_bounds,
        row_bounds,
        len(column_indexes),
        numpy.array(row_starts, dtype=numpy.int32),
        numpy.array(column_indexes, dtype=numpy.int32),
        numpy.array(coefficient_values),
    )


def evaluate_fit(predicted_scores: Sequence[float], actual_scores: Sequence[float]) -> FitQuality:
    """擬合品質。

    Args:
        predicted_scores: 預測值。
        actual_scores: 實際值。

    Returns:
        R² 與平均絕對誤差。
    """
    actual_mean = statistics.fmean(actual_scores)
    residual_sum = sum((actual_score - predicted_score) ** 2 for actual_score, predicted_score in zip(actual_scores, predicted_scores))
    total_sum = sum((actual_score - actual_mean) ** 2 for actual_score in actual_scores)
    mean_absolute_error = statistics.fmean(abs(actual_score - predicted_score) for actual_score, predicted_score in zip(actual_scores, predicted_scores))
    return FitQuality(r_squared=1 - residual_sum / total_sum, mean_absolute_error=mean_absolute_error)


def monthly_medians(values_by_date: Mapping[date, float]) -> dict[str, float]:
    """各月份（1–12 月，不分年份）的中位數。

    Args:
        values_by_date: 日期對應的值。

    Returns:
        `"01"` 到 `"12"` 對應的中位數；沒有資料的月份不在結果內。
    """
    values_by_month: dict[str, list[float]] = {}
    for value_date, raw_value in values_by_date.items():
        values_by_month.setdefault(f"{value_date.month:02d}", []).append(raw_value)
    return {month_key: statistics.median(values_by_month[month_key]) for month_key in MONTH_KEYS if month_key in values_by_month}


def transform_revenue(revenue_values: Sequence[float]) -> list[float]:
    """收益取 log(1 + 收益)，避免少數價格尖峰日主導擬合。

    Args:
        revenue_values: 每日套利收益（AUD），不得為負。

    Returns:
        log 尺度的收益。

    Raises:
        ValueError: 有負的收益時。
    """
    if any(revenue_value < 0 for revenue_value in revenue_values):
        raise ValueError("每日套利收益不得為負")
    return [math.log1p(revenue_value) for revenue_value in revenue_values]


def restore_revenue(predicted_scores: Sequence[float], revenue_series: StandardizedSeries) -> list[float]:
    """把 log 尺度 z 分數的預測值換算回 AUD。

    Args:
        predicted_scores: 預測的 z 分數。
        revenue_series: log 尺度收益的平均數與標準差。

    Returns:
        預測收益（AUD）。
    """
    return [math.expm1(revenue_series.series_mean + revenue_series.standard_deviation * predicted_score) for predicted_score in predicted_scores]


def direction_of(correlation_value: float) -> int:
    """相關係數的方向：0 以上為 1，負值為 -1。

    Args:
        correlation_value: 相關係數。

    Returns:
        1 或 -1。
    """
    return POSITIVE_DIRECTION if correlation_value >= 0 else NEGATIVE_DIRECTION


def standardize_factors(factor_series: Mapping[str, Mapping[date, float]], fit_dates: Sequence[date]) -> dict[str, StandardizedSeries]:
    """擬合期間內每個因素的 z 分數。

    Args:
        factor_series: 因素名稱對應「日期 → 值」。
        fit_dates: 擬合用的日期。

    Returns:
        因素名稱對應標準化結果。

    Raises:
        ValueError: 某個因素在擬合期間內無法標準化時，訊息帶出因素名稱。
    """
    standardized_factors: dict[str, StandardizedSeries] = {}
    for factor_name, values_by_date in factor_series.items():
        try:
            standardized_factors[factor_name] = standardize_values([values_by_date[fit_date] for fit_date in fit_dates])
        except ValueError as standardize_error:
            raise ValueError(f"因素 {factor_name} 在擬合期間無法標準化：{standardize_error}") from standardize_error
    return standardized_factors


def build_signed_scores(standardized_factors: Mapping[str, StandardizedSeries], factor_correlations: Mapping[str, float], day_count: int) -> list[list[float]]:
    """每天各因素的 z 分數乘上方向，組成 n × K 的矩陣。

    Args:
        standardized_factors: 因素名稱對應標準化結果。
        factor_correlations: 因素名稱對應 Spearman 相關係數。
        day_count: 天數。

    Returns:
        n 天 × K 個因素的矩陣，因素順序與 `standardized_factors` 相同。
    """
    direction_signs = [direction_of(factor_correlations[factor_name]) for factor_name in standardized_factors]
    factor_scores = [standardized_series.standard_scores for standardized_series in standardized_factors.values()]
    return [[direction_sign * score_list[day_index] for direction_sign, score_list in zip(direction_signs, factor_scores)] for day_index in range(day_count)]


def predict_scores(l1_solution: L1Solution, signed_scores: Sequence[Sequence[float]]) -> list[float]:
    """以求得的權重與截距算每天的預測值（z 分數）。

    Args:
        l1_solution: L1 迴歸的權重與截距。
        signed_scores: n 天 × K 個因素的矩陣。

    Returns:
        每天的預測值。
    """
    return [l1_solution.intercept_value + sum(weight_value * factor_score for weight_value, factor_score in zip(l1_solution.weight_values, day_scores)) for day_scores in signed_scores]


def build_factor_weight_list(
    factor_series: Mapping[str, Mapping[date, float]],
    standardized_factors: Mapping[str, StandardizedSeries],
    factor_correlations: Mapping[str, float],
    l1_solution: L1Solution,
) -> list[FactorWeight]:
    """把求解結果與各因素的統計值組成輸出用的清單（與 `factor_series` 同順序）。

    Args:
        factor_series: 因素名稱對應「日期 → 值」，用來算每月基準值。
        standardized_factors: 擬合期間各因素的標準化結果。
        factor_correlations: 各因素與收益的 Spearman 相關係數。
        l1_solution: L1 迴歸的權重與截距。

    Returns:
        各因素的擬合結果。
    """
    return [
        FactorWeight(
            factor_name=factor_name,
            weight_value=l1_solution.weight_values[factor_index],
            direction_sign=direction_of(factor_correlations[factor_name]),
            spearman_correlation=factor_correlations[factor_name],
            factor_mean=standardized_factors[factor_name].series_mean,
            factor_standard_deviation=standardized_factors[factor_name].standard_deviation,
            monthly_baseline=monthly_medians(factor_series[factor_name]),
        )
        for factor_index, factor_name in enumerate(factor_series)
    ]


def fit_factor_weights(factor_series: Mapping[str, Mapping[date, float]], revenue_by_date: Mapping[date, float]) -> FactorWeightFit:
    """求各因素的權重、方向與每月基準值。

    Args:
        factor_series: 因素名稱對應「日期 → 值」。
        revenue_by_date: 日期對應的每日套利收益（AUD）。

    Returns:
        整體擬合結果。

    Raises:
        ValueError: 沒有任何日子同時具備所有因素與收益，或某個因素無法標準化時。
    """
    fit_dates = sorted(set(revenue_by_date).intersection(*(set(values_by_date) for values_by_date in factor_series.values())))
    if not fit_dates:
        raise ValueError("沒有任何日子同時具備所有因素與收益")
    actual_revenues = [revenue_by_date[fit_date] for fit_date in fit_dates]
    revenue_series = standardize_values(transform_revenue(actual_revenues))
    standardized_factors = standardize_factors(factor_series, fit_dates)
    factor_correlations = {factor_name: spearman_correlation(factor_scores.standard_scores, revenue_series.standard_scores) for factor_name, factor_scores in standardized_factors.items()}
    signed_scores = build_signed_scores(standardized_factors, factor_correlations, len(fit_dates))
    l1_solution = solve_l1_weights(signed_scores, revenue_series.standard_scores)
    predicted_scores = predict_scores(l1_solution, signed_scores)
    fit_quality = evaluate_fit(predicted_scores, revenue_series.standard_scores)
    predicted_revenues = restore_revenue(predicted_scores, revenue_series)
    return FactorWeightFit(
        fit_dates=fit_dates,
        revenue_log_mean=revenue_series.series_mean,
        revenue_log_standard_deviation=revenue_series.standard_deviation,
        revenue_median_aud=statistics.median(actual_revenues),
        intercept_value=l1_solution.intercept_value,
        r_squared=fit_quality.r_squared,
        mean_absolute_error_standardized=fit_quality.mean_absolute_error,
        mean_absolute_error_aud=statistics.fmean(abs(actual_revenue - predicted_revenue) for actual_revenue, predicted_revenue in zip(actual_revenues, predicted_revenues)),
        factor_weights=build_factor_weight_list(factor_series, standardized_factors, factor_correlations, l1_solution),
    )
