"""每日套利收益：`src/window_selection.js` 的 `select_best_plan` 的 Python 版（純計算）。

規則與 JS 版相同：每段窗口長度為容量 ÷ 功率、連續、滿功率；一個循環是「充、放」兩段，
兩個循環是「充、放、充、放」四段一起選，求「放電段總價 − 充電段總價」的最大值。
每個循環的價差必須為正且不低於每循環最低價差；同分取最早；一個與兩個循環同分取一個。
兩版的結果由 `tests/fixtures/select_best_plan_cases.json` 共用案例確認一致。
"""

import math
from collections.abc import Sequence
from dataclasses import dataclass

INTERVAL_HOURS = 0.5
FIVE_MINUTE_INTERVALS_PER_HALF_HOUR = 6
PRICE_SCALE_FACTOR = 1_000_000


@dataclass(frozen=True)
class BatterySpec:
    """電池規格。`marginal_loss_factor`（MLF）只縮放收益，不影響選窗。"""

    power_mw: float
    capacity_mwh: float
    marginal_loss_factor: float


@dataclass(frozen=True)
class PlannedCycle:
    """一個充放電循環；索引是 30 分鐘時段的位置，收益單位為 AUD。"""

    charge_start_index: int
    discharge_start_index: int
    charge_average_price: float
    discharge_average_price: float
    net_value: float


@dataclass(frozen=True)
class ArbitragePlan:
    """選窗結果：每段時段數、每次充放的電量、選中的循環與總收益。"""

    segment_length: int
    energy_mwh: float
    cycles: list[PlannedCycle]
    total_value: float


@dataclass(frozen=True)
class CandidateCycle:
    """一組「充電段、放電段」配對；分數為放大成整數的段總和差。"""

    charge_start: int
    discharge_start: int
    cycle_score: int


DEFAULT_BATTERY_SPEC = BatterySpec(power_mw=5, capacity_mwh=20, marginal_loss_factor=1)


def segment_length_for(battery_spec: BatterySpec) -> int:
    """每段窗口的 30 分鐘時段數，至少 1 段。

    Args:
        battery_spec: 電池規格。

    Returns:
        每段時段數。
    """
    return max(1, round_half_up(battery_spec.capacity_mwh / battery_spec.power_mw / INTERVAL_HOURS))


def round_half_up(raw_value: float) -> int:
    """與 JavaScript `Math.round` 相同的取整：.5 一律往正無限大進位。

    Args:
        raw_value: 要取整的數。

    Returns:
        取整後的整數。
    """
    return math.floor(raw_value + 0.5)


def select_best_plan(price_values: Sequence[float], battery_spec: BatterySpec, minimum_cycle_spread: float = 0) -> ArbitragePlan:
    """選出淨收益最高的計畫（最多兩個循環）。

    Args:
        price_values: 依時間排序的 30 分鐘電價（AUD/MWh）。
        battery_spec: 電池規格。
        minimum_cycle_spread: 每循環最低價差（AUD/MWh）。

    Returns:
        選窗結果。

    Raises:
        ValueError: 電價含非有限數值，或最低價差為負或非有限數值時。
    """
    if not all(math.isfinite(price_value) for price_value in price_values):
        raise ValueError("選窗用的電價含有非數值")
    if not math.isfinite(minimum_cycle_spread) or minimum_cycle_spread < 0:
        raise ValueError(f"每循環最低價差必須是 0 以上的數值：{minimum_cycle_spread}")
    segment_length = segment_length_for(battery_spec)
    energy_mwh = min(battery_spec.capacity_mwh, battery_spec.power_mw * segment_length * INTERVAL_HOURS)
    scaled_prices = [round_half_up(price_value * PRICE_SCALE_FACTOR) for price_value in price_values]
    segment_sums = compute_segment_sums(scaled_prices, segment_length)
    minimum_cycle_score = round_half_up(minimum_cycle_spread * PRICE_SCALE_FACTOR) * segment_length
    candidate_cycles = enumerate_candidate_cycles(segment_sums, segment_length, minimum_cycle_score)
    chosen_cycles = choose_best_cycles(candidate_cycles, len(segment_sums), segment_length)
    planned_cycles = [build_cycle(candidate_cycle, segment_sums, segment_length, energy_mwh, battery_spec.marginal_loss_factor) for candidate_cycle in chosen_cycles]
    total_value = 0.0
    for planned_cycle in planned_cycles:
        total_value += planned_cycle.net_value
    return ArbitragePlan(segment_length=segment_length, energy_mwh=energy_mwh, cycles=planned_cycles, total_value=total_value)


def compute_segment_sums(scaled_prices: Sequence[int], segment_length: int) -> list[int]:
    """每個合法起點的段內價格總和（整數運算，沒有浮點誤差）。

    Args:
        scaled_prices: 放大成整數的電價。
        segment_length: 每段時段數。

    Returns:
        長度為「時段數 − 段長 + 1」的總和串列。
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


def enumerate_candidate_cycles(segment_sums: Sequence[int], segment_length: int, minimum_cycle_score: int) -> list[CandidateCycle]:
    """列出所有符合條件的配對，依（充電起點、放電起點）由早到晚排序。

    Args:
        segment_sums: 每個起點的段內價格總和。
        segment_length: 每段時段數。
        minimum_cycle_score: 每循環最低的段總和差（放大後的整數）。

    Returns:
        價差為正且不低於門檻的配對。
    """
    candidate_cycles: list[CandidateCycle] = []
    for charge_start, charge_sum in enumerate(segment_sums):
        for discharge_start in range(charge_start + segment_length, len(segment_sums)):
            cycle_score = segment_sums[discharge_start] - charge_sum
            if cycle_score > 0 and cycle_score >= minimum_cycle_score:
                candidate_cycles.append(CandidateCycle(charge_start, discharge_start, cycle_score))
    return candidate_cycles


def choose_best_cycles(candidate_cycles: Sequence[CandidateCycle], start_count: int, segment_length: int) -> list[CandidateCycle]:
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
    best_pair_score: int | None = None
    best_pair: list[CandidateCycle] = []
    for first_cycle in candidate_cycles:
        next_start = first_cycle.discharge_start + segment_length
        second_cycle = best_from_start[next_start] if next_start <= start_count else None
        if second_cycle is None:
            continue
        pair_score = first_cycle.cycle_score + second_cycle.cycle_score
        if best_pair_score is None or pair_score > best_pair_score:
            best_pair_score, best_pair = pair_score, [first_cycle, second_cycle]
    if best_pair_score is not None and best_pair_score > best_single.cycle_score:
        return best_pair
    return [best_single]


def build_best_from_start(candidate_cycles: Sequence[CandidateCycle], start_count: int) -> list[CandidateCycle | None]:
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


def build_cycle(candidate_cycle: CandidateCycle, segment_sums: Sequence[int], segment_length: int, energy_mwh: float, marginal_loss_factor: float) -> PlannedCycle:
    """把候選配對換算成均價與淨收益。

    Args:
        candidate_cycle: 選中的配對。
        segment_sums: 每個起點的段內價格總和。
        segment_length: 每段時段數。
        energy_mwh: 每次充放的電量。
        marginal_loss_factor: 損失係數。

    Returns:
        循環。
    """
    charge_average_price = segment_sums[candidate_cycle.charge_start] / segment_length / PRICE_SCALE_FACTOR
    discharge_average_price = segment_sums[candidate_cycle.discharge_start] / segment_length / PRICE_SCALE_FACTOR
    return PlannedCycle(
        charge_start_index=candidate_cycle.charge_start,
        discharge_start_index=candidate_cycle.discharge_start,
        charge_average_price=charge_average_price,
        discharge_average_price=discharge_average_price,
        net_value=energy_mwh * marginal_loss_factor * (discharge_average_price - charge_average_price),
    )


def average_into_half_hours(five_minute_prices: Sequence[float]) -> list[float]:
    """把 5 分鐘電價每 6 筆平均成一個 30 分鐘電價，與主頁使用的 30 分鐘預調度同一個時間粒度。

    Args:
        five_minute_prices: 依時間排序的 5 分鐘電價，筆數必須是 6 的倍數。

    Returns:
        30 分鐘電價。

    Raises:
        ValueError: 筆數不是 6 的倍數時。
    """
    if len(five_minute_prices) % FIVE_MINUTE_INTERVALS_PER_HALF_HOUR != 0:
        raise ValueError(f"5 分鐘電價筆數必須是 6 的倍數：{len(five_minute_prices)}")
    return [
        sum(five_minute_prices[block_start : block_start + FIVE_MINUTE_INTERVALS_PER_HALF_HOUR]) / FIVE_MINUTE_INTERVALS_PER_HALF_HOUR
        for block_start in range(0, len(five_minute_prices), FIVE_MINUTE_INTERVALS_PER_HALF_HOUR)
    ]
