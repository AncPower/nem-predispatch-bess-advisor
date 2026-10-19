"""`data/factor_weights.json` 是否由目前的分析程式與外部資料產生（CI 沒有原始資料，只比對指紋）。"""

import json
from pathlib import Path
from typing import Any

from analysis.build_factor_weights import (
    EXTERNAL_INPUT_RELATIVE_PATHS,
    OUTPUT_RELATIVE_PATH,
    REGENERATE_COMMAND,
    REPOSITORY_ROOT,
)
from analysis.input_fingerprint import compute_source_fingerprint


def read_recorded_fingerprint() -> dict[str, Any]:
    """讀出 JSON 裡記錄的輸入指紋。"""
    report_document = json.loads((REPOSITORY_ROOT / OUTPUT_RELATIVE_PATH).read_text(encoding="utf-8"))
    return report_document["input_fingerprint"]


def list_changed_paths(recorded_digests: dict[str, str], current_digests: dict[str, str]) -> list[str]:
    """兩組「路徑 → sha256」之間新增、刪除或內容不同的路徑。"""
    every_path = set(recorded_digests) | set(current_digests)
    return sorted(path_text for path_text in every_path if recorded_digests.get(path_text) != current_digests.get(path_text))


def test_factor_weights_json_matches_current_sources() -> None:
    """分析程式或 data/external 改了卻沒重新產生 JSON：失敗並提示重跑指令與改動的檔案。"""
    recorded_fingerprint = read_recorded_fingerprint()
    current_fingerprint = compute_source_fingerprint(REPOSITORY_ROOT, EXTERNAL_INPUT_RELATIVE_PATHS)

    changed_paths = list_changed_paths(
        {**recorded_fingerprint["code_files"], **recorded_fingerprint["external_files"]},
        {**current_fingerprint.code_files, **current_fingerprint.external_files},
    )
    assert recorded_fingerprint["combined_sha256"] == current_fingerprint.combined_sha256, (
        f"{OUTPUT_RELATIVE_PATH} 已過期，改動的檔案：{changed_paths}。請在 repo 根目錄執行：{REGENERATE_COMMAND}"
    )


def test_factor_weights_json_records_raw_input_manifest() -> None:
    """JSON 記錄了原始資料檔清單，每個檔都有路徑、大小與 sha256。"""
    raw_input_files = read_recorded_fingerprint()["raw_input_files"]

    assert raw_input_files
    assert all(set(raw_entry) == {"relative_path", "size_bytes", "sha256"} for raw_entry in raw_input_files)
