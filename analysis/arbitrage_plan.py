"""`src/window_selection.js` 的 `select_best_plan` 的 Python 版（純計算）。

算法與 JS 版逐步相同，兩邊以 `tests/fixtures/select_best_plan_cases.json` 驗證結果一致：

- 每段窗口長度相同（容量 ÷ 功率）、連續、滿功率、不重疊且依序排列。
- 一個循環是「充、放」兩段；兩個循環是「充、放、充、放」四段一起選，求淨收益的最大值。
- 每個循環的價差必須為正、不低於每循環最低價差，且淨收益必須為正。
- 同分取最早的組合；一個與兩個循環同分取一個；沒有任何組合符合時不排。
- 電價先放大成整數再加總，取整用 JS `Math.round` 的規則（.5 一律往正方向），不用 Python 的 `round`。
- 效率與損耗（#27）：充電量為容量，放電量為容量 × 來回效率；
  淨收益＝放電量 × 放電均價 × MLF − 充電量 × 充電均價 × MLF − 放電量 × 每 MWh 損耗成本。
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

from analysis.nem_day import INTERVAL_HOURS

PRICE_SCALE_FACTOR: int = 1_000_000
HALF_FRACTION: float = 0.5


@dataclass(frozen=True)
class BatterySpecification:
    """電池規格；欄位名稱與 JS 的 `BatterySpec` 相同。"""

    power_mw: float
    capacity_mwh: float
    marginal_loss_factor: float
    round_trip_efficiency: float
    degradation_cost_aud_per_mwh: float


@dataclass(frozen=True)
class CandidateCycle:
    """一組「充電段、放電段」配對與其淨收益分數（與淨收益成正比）。"""

    charge_start: int
    discharge_start: int
    cycle_score: float


@dataclass(frozen=True)
class PlannedCycle:
    """選中的循環；欄位名稱與 JS 的 `PlannedCycle` 相同。"""

    charge_start_index: int
    discharge_start_index: int
    charge_average_price: float
    discharge_average_price: float
    net_value: float


@dataclass(frozen=True)
class ArbitragePlan:
    """`select_best_plan` 的結果；欄位名稱與 JS 回傳的物件相同。

    `energy_mwh` 為每次充電量，`discharge_energy_mwh` 為每次放電量。
    """

    segment_length: int
    energy_mwh: float
    discharge_energy_mwh: float
    cycles: tuple[PlannedCycle, ...]
    total_value: float


@dataclass(frozen=True)
class ScoreSettings:
    """排序用分數的參數；見 `build_score_settings`。"""

    marginal_loss_factor: float
    round_trip_efficiency: float
    degradation_score: float


def round_half_up(input_value: float) -> int:
    """與 JS `Math.round` 相同的取整：取最接近的整數，剛好 .5 時往正方向。

    不寫成 `math.floor(input_value + 0.5)`：加 0.5 本身會有浮點誤差（例如 0.49999999999999994）。

    Args:
        input_value: 有限的浮點數。

    Returns:
        取整後的整數。
    """
    floor_value = math.floor(input_value)
    return floor_value + 1 if input_value - floor_value >= HALF_FRACTION else floor_value


def segment_length_for(battery_specification: BatterySpecification) -> int:
    """每段窗口的時段數：滿充所需時間 ÷ 30 分鐘，至少 1 段。

    Args:
        battery_specification: 電池規格。

    Returns:
        每段時段數。
    """
    charge_hours = battery_specification.capacity_mwh / battery_specification.power_mw
    return max(1, round_half_up(charge_hours / INTERVAL_HOURS))


def break_even_spread(charge_average_price: float, battery_specification: BatterySpecification) -> float:
    """損益兩平價差：放電均價 − 充電均價至少要高於這個值，淨收益才會為正。

    充電均價 ×（1 ÷ 效率 − 1）＋ 損耗成本 ÷ MLF；MLF 為 1 時即 roadmap D3 的公式。與 JS 版運算順序相同。

    Args:
        charge_average_price: 充電段均價（AUD/MWh）。
        battery_specification: 電池規格。

    Returns:
        損益兩平價差（AUD/MWh）。

    Raises:
        ValueError: 來回效率或損耗成本不合法時。
    """
    validate_battery_costs(battery_specification)
    return (
        charge_average_price * (1 / battery_specification.round_trip_efficiency - 1)
        + battery_specification.degradation_cost_aud_per_mwh / battery_specification.marginal_loss_factor
    )


def select_best_plan(
    price_values: Sequence[float],
    battery_specification: BatterySpecification,
    minimum_cycle_spread: float = 0.0,
) -> ArbitragePlan:
    """選出淨收益最高的計畫（最多兩個循環）。

    Args:
        price_values: 依時間排序的 30 分鐘電價（AUD/MWh）。
        battery_specification: 電池規格。
        minimum_cycle_spread: 每循環最低價差（AUD/MWh），預設 0。

    Returns:
        每段時段數、每次充電量與放電量、選中的循環與總淨收益（AUD）。

    Raises:
        ValueError: 電價含非有限數值、最低價差為負或非數值，或來回效率、損耗成本不合法時。
    """
    validate_plan_inputs(price_values, minimum_cycle_spread)
    validate_battery_costs(battery_specification)
    segment_length = segment_length_for(battery_specification)
    energy_mwh = min(
        battery_specification.capacity_mwh, battery_specification.power_mw * segment_length * INTERVAL_HOURS
    )
    discharge_energy_mwh = energy_mwh * battery_specification.round_trip_efficiency
    scaled_prices = [round_half_up(price_value * PRICE_SCALE_FACTOR) for price_value in price_values]
    segment_sums = compute_segment_sums(scaled_prices, segment_length)
    minimum_cycle_score = round_half_up(minimum_cycle_spread * PRICE_SCALE_FACTOR) * segment_length
    score_settings = build_score_settings(battery_specification, segment_length)
    candidate_cycles = enumerate_candidate_cycles(segment_sums, segment_length, minimum_cycle_score, score_settings)
    chosen_cycles = choose_best_cycles(candidate_cycles, len(segment_sums), segment_length)
    planned_cycles = tuple(
        build_planned_cycle(
            candidate_cycle, segment_sums, segment_length, (energy_mwh, discharge_energy_mwh), battery_specification
        )
        for candidate_cycle in chosen_cycles
    )
    total_value = sum((planned_cycle.net_value for planned_cycle in planned_cycles), 0)
    return ArbitragePlan(segment_length, energy_mwh, discharge_energy_mwh, planned_cycles, total_value)


def validate_plan_inputs(price_values: Sequence[float], minimum_cycle_spread: float) -> None:
    """檢查選窗輸入。

    Args:
        price_values: 電價。
        minimum_cycle_spread: 每循環最低價差。

    Raises:
        ValueError: 電價含非有限數值，或最低價差為負或非數值時。
    """
    if not all(math.isfinite(price_value) for price_value in price_values):
        raise ValueError("選窗用的電價含有非數值")
    if not math.isfinite(minimum_cycle_spread) or minimum_cycle_spread < 0:
        raise ValueError(f"每循環最低價差必須是 0 以上的數值：{minimum_cycle_spread}")


def validate_battery_costs(battery_specification: BatterySpecification) -> None:
    """檢查來回效率與損耗成本；設定檔讀取時已驗證，這裡再擋一次，與 JS 版相同。

    Args:
        battery_specification: 電池規格。

    Raises:
        ValueError: 來回效率不在 (0, 1]，或損耗成本為負或非數值時。
    """
    efficiency = battery_specification.round_trip_efficiency
    if not math.isfinite(efficiency) or efficiency <= 0 or efficiency > 1:
        raise ValueError(f"來回效率必須大於 0 且不超過 1：{efficiency}")
    degradation_cost = battery_specification.degradation_cost_aud_per_mwh
    if not math.isfinite(degradation_cost) or degradation_cost < 0:
        raise ValueError(f"每 MWh 損耗成本必須是 0 以上的數值：{degradation_cost}")


def build_score_settings(battery_specification: BatterySpecification, segment_length: int) -> ScoreSettings:
    """排序用分數的參數。

    分數＝MLF ×（效率 × 放電段總和 − 充電段總和）− 效率 × 損耗成本 × 段長（皆已放大），
    與淨收益成正比，所以依分數排序就是依淨收益排序。運算順序與 JS 版相同。

    Args:
        battery_specification: 電池規格。
        segment_length: 每段時段數。

    Returns:
        分數參數。
    """
    scaled_degradation_cost = round_half_up(battery_specification.degradation_cost_aud_per_mwh * PRICE_SCALE_FACTOR)
    return ScoreSettings(
        marginal_loss_factor=battery_specification.marginal_loss_factor,
        round_trip_efficiency=battery_specification.round_trip_efficiency,
        degradation_score=battery_specification.round_trip_efficiency * scaled_degradation_cost * segment_length,
    )


def compute_segment_sums(scaled_prices: Sequence[int], segment_length: int) -> list[int]:
    """每個合法起點的段內價格總和（整數運算，沒有浮點誤差）。

    Args:
        scaled_prices: 放大成整數的電價。
        segment_length: 每段時段數。

    Returns:
        長度為「時段數 − 段長 + 1」的總和清單；時段不足一段時為空。
    """
    segment_sums: list[int] = []
    running_sum = 0
    for price_index, scaled_price in enumerate(scaled_prices):
        running_sum += scaled_price
        if price_index >= segment_length:
            running_sum -= scaled_prices[price_index - segment_length]
        if price_index >= segment_length - 1:
            segment_sums.append(running_sum)
    return segment_sums


def enumerate_candidate_cycles(
    segment_sums: Sequence[int], segment_length: int, minimum_cycle_score: int, score_settings: ScoreSettings
) -> list[CandidateCycle]:
    """列出所有符合條件的配對，依（充電起點、放電起點）由早到晚排序。

    Args:
        segment_sums: 每個起點的段內價格總和。
        segment_length: 每段時段數。
        minimum_cycle_score: 每循環最低的段總和差（放大後的整數）。
        score_settings: 分數參數。

    Returns:
        價差為正、不低於門檻且淨收益為正的配對。
    """
    candidate_cycles: list[CandidateCycle] = []
    for charge_start, charge_sum in enumerate(segment_sums):
        for discharge_start in range(charge_start + segment_length, len(segment_sums)):
            discharge_sum = segment_sums[discharge_start]
            spread_score = discharge_sum - charge_sum
            if spread_score <= 0 or spread_score < minimum_cycle_score:
                continue
            cycle_score = (
                score_settings.marginal_loss_factor * (score_settings.round_trip_efficiency * discharge_sum - charge_sum)
                - score_settings.degradation_score
            )
            if cycle_score > 0:
                candidate_cycles.append(CandidateCycle(charge_start, discharge_start, cycle_score))
    return candidate_cycles


def choose_best_cycles(
    candidate_cycles: Sequence[CandidateCycle], start_count: int, segment_length: int
) -> list[CandidateCycle]:
    """比較最佳單循環與最佳雙循環；雙循環必須嚴格較高才採用。

    Args:
        candidate_cycles: 依起點排序的候選配對。
        start_count: 合法起點數。
        segment_length: 每段時段數。

    Returns:
        選中的 0 到 2 個循環。
    """
    if not candidate_cycles:
        return []
    best_single = candidate_cycles[0]
    for candidate_cycle in candidate_cycles[1:]:
        if candidate_cycle.cycle_score > best_single.cycle_score:
            best_single = candidate_cycle
    best_from_start = build_best_from_start(candidate_cycles, start_count)
    best_pair: list[CandidateCycle] = []
    best_pair_score = 0.0
    for first_cycle in candidate_cycles:
        second_start = first_cycle.discharge_start + segment_length
        second_cycle = best_from_start[second_start] if second_start <= start_count else None
        if second_cycle is None:
            continue
        pair_score = first_cycle.cycle_score + second_cycle.cycle_score
        if not best_pair or pair_score > best_pair_score:
            best_pair, best_pair_score = [first_cycle, second_cycle], pair_score
    return best_pair if best_pair and best_pair_score > best_single.cycle_score else [best_single]


def build_best_from_start(
    candidate_cycles: Sequence[CandidateCycle], start_count: int
) -> list[CandidateCycle | None]:
    """`result[t]` 為充電起點不早於 t 的最佳配對，同分取最早；沒有時為 None。

    Args:
        candidate_cycles: 依起點排序的候選配對。
        start_count: 合法起點數。

    Returns:
        長度為 start_count + 1 的後綴表。
    """
    best_from_start: list[CandidateCycle | None] = [None] * (start_count + 1)
    for candidate_cycle in reversed(candidate_cycles):
        current_best = best_from_start[candidate_cycle.charge_start]
        if current_best is None or candidate_cycle.cycle_score >= current_best.cycle_score:
            best_from_start[candidate_cycle.charge_start] = candidate_cycle
    for start_index in range(start_count - 1, -1, -1):
        later_best = best_from_start[start_index + 1]
        own_best = best_from_start[start_index]
        if later_best is not None and (own_best is None or later_best.cycle_score > own_best.cycle_score):
            best_from_start[start_index] = later_best
    return best_from_start


def build_planned_cycle(
    candidate_cycle: CandidateCycle,
    segment_sums: Sequence[int],
    segment_length: int,
    cycle_energy: tuple[float, float],
    battery_specification: BatterySpecification,
) -> PlannedCycle:
    """把候選配對換算成均價與淨收益；運算順序與 JS 相同，浮點結果才會一致。

    Args:
        candidate_cycle: 選中的配對。
        segment_sums: 每個起點的段內價格總和。
        segment_length: 每段時段數。
        cycle_energy: （每次充電量, 每次放電量）。
        battery_specification: 電池規格。

    Returns:
        循環。
    """
    energy_mwh, discharge_energy_mwh = cycle_energy
    charge_average_price = segment_sums[candidate_cycle.charge_start] / segment_length / PRICE_SCALE_FACTOR
    discharge_average_price = segment_sums[candidate_cycle.discharge_start] / segment_length / PRICE_SCALE_FACTOR
    settled_spread = battery_specification.round_trip_efficiency * discharge_average_price - charge_average_price
    return PlannedCycle(
        charge_start_index=candidate_cycle.charge_start,
        discharge_start_index=candidate_cycle.discharge_start,
        charge_average_price=charge_average_price,
        discharge_average_price=discharge_average_price,
        net_value=energy_mwh * battery_specification.marginal_loss_factor * settled_spread
        - discharge_energy_mwh * battery_specification.degradation_cost_aud_per_mwh,
    )
