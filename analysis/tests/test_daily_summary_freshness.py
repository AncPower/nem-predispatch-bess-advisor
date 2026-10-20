"""`data/daily_summary.json` 是否由目前的分析程式與 `config/battery.json` 產生（CI 沒有原始資料，只比對指紋）。"""

import json
from typing import Any

from analysis.build_daily_summary import EXTERNAL_INPUT_RELATIVE_PATHS, OUTPUT_RELATIVE_PATH, REGENERATE_COMMAND
from analysis.build_factor_weights import REPOSITORY_ROOT
from analysis.input_fingerprint import compute_source_fingerprint


def read_summary_document() -> dict[str, Any]:
    """讀出 repo 裡的每日摘要。"""
    return json.loads((REPOSITORY_ROOT / OUTPUT_RELATIVE_PATH).read_text(encoding="utf-8"))


def test_daily_summary_json_matches_current_sources() -> None:
    """分析程式或 config/battery.json 改了卻沒重新產生每日摘要：失敗並提示重跑指令與改動的檔案。"""
    recorded_fingerprint = read_summary_document()["input_fingerprint"]
    current_fingerprint = compute_source_fingerprint(REPOSITORY_ROOT, EXTERNAL_INPUT_RELATIVE_PATHS)
    recorded_digests = {**recorded_fingerprint["code_files"], **recorded_fingerprint["external_files"]}
    current_digests = {**current_fingerprint.code_files, **current_fingerprint.external_files}
    changed_paths = sorted(
        path_text
        for path_text in set(recorded_digests) | set(current_digests)
        if recorded_digests.get(path_text) != current_digests.get(path_text)
    )

    assert recorded_fingerprint["combined_sha256"] == current_fingerprint.combined_sha256, (
        f"{OUTPUT_RELATIVE_PATH} 已過期，改動的檔案：{changed_paths}。請在 repo 根目錄執行：{REGENERATE_COMMAND}"
    )


def test_daily_summary_json_lists_every_day_once_in_order() -> None:
    """每日摘要的日子依序、不重複，天數與期間區段一致，排除日都有原因。"""
    summary_document = read_summary_document()
    day_dates = [day_entry["date"] for day_entry in summary_document["days"]]

    assert day_dates == sorted(set(day_dates))
    assert summary_document["period"]["day_count"] == len(day_dates)
    assert all(day_entry["exclusion_reason"] for day_entry in summary_document["days"] if day_entry["excluded"])
