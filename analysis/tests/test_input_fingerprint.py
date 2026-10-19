"""`analysis.input_fingerprint` 的單元測試。"""

import hashlib
from pathlib import Path

from analysis.input_fingerprint import (
    build_raw_manifest,
    combine_digests,
    compute_file_sha256,
    compute_source_fingerprint,
    list_code_files,
)

EXTERNAL_RELATIVE_PATH = "data/external/sample.csv"


def build_repository(repository_root: Path) -> None:
    """在暫存目錄建一個最小的 repo：兩個分析模組、一個測試檔、一個外部 CSV。"""
    (repository_root / "analysis" / "tests").mkdir(parents=True)
    (repository_root / "analysis" / "first_module.py").write_text("FIRST_VALUE = 1\n", encoding="utf-8")
    (repository_root / "analysis" / "second_module.py").write_text("SECOND_VALUE = 2\n", encoding="utf-8")
    (repository_root / "analysis" / "tests" / "test_sample.py").write_text("", encoding="utf-8")
    (repository_root / "data" / "external").mkdir(parents=True)
    (repository_root / EXTERNAL_RELATIVE_PATH).write_text("gas_date\n2024-07-01\n", encoding="utf-8")


def test_compute_file_sha256_matches_hashlib(tmp_path: Path) -> None:
    """檔案的 sha256：與 hashlib 一次讀完的結果相同。"""
    sample_file = tmp_path / "sample.bin"
    sample_file.write_bytes(b"x" * 3_000_000)

    assert compute_file_sha256(sample_file) == hashlib.sha256(b"x" * 3_000_000).hexdigest()


def test_list_code_files_excludes_tests_directory(tmp_path: Path) -> None:
    """程式檔清單：只含 analysis/ 第一層的 .py，依名稱排序，不含 tests/。"""
    build_repository(tmp_path)

    code_files = list_code_files(tmp_path / "analysis")

    assert [code_file.name for code_file in code_files] == ["first_module.py", "second_module.py"]


def test_combine_digests_ignores_dictionary_order() -> None:
    """合併雜湊：與字典的插入順序無關。"""
    code_files = {"analysis/a.py": "1", "analysis/b.py": "2"}
    reordered_code_files = {"analysis/b.py": "2", "analysis/a.py": "1"}

    assert combine_digests(code_files, {"data/external/x.csv": "3"}) == combine_digests(
        reordered_code_files, {"data/external/x.csv": "3"}
    )


def test_combine_digests_distinguishes_code_from_external() -> None:
    """同一組路徑與雜湊放在程式或外部資料兩邊：合併雜湊不同。"""
    assert combine_digests({"same/path": "1"}, {}) != combine_digests({}, {"same/path": "1"})


def test_compute_source_fingerprint_changes_when_code_changes(tmp_path: Path) -> None:
    """改了分析程式：合併雜湊改變。"""
    build_repository(tmp_path)
    original_fingerprint = compute_source_fingerprint(tmp_path, [EXTERNAL_RELATIVE_PATH])

    (tmp_path / "analysis" / "first_module.py").write_text("FIRST_VALUE = 3\n", encoding="utf-8")

    assert compute_source_fingerprint(tmp_path, [EXTERNAL_RELATIVE_PATH]).combined_sha256 != original_fingerprint.combined_sha256


def test_compute_source_fingerprint_changes_when_external_data_changes(tmp_path: Path) -> None:
    """改了外部 CSV：合併雜湊改變。"""
    build_repository(tmp_path)
    original_fingerprint = compute_source_fingerprint(tmp_path, [EXTERNAL_RELATIVE_PATH])

    (tmp_path / EXTERNAL_RELATIVE_PATH).write_text("gas_date\n2024-07-02\n", encoding="utf-8")

    assert compute_source_fingerprint(tmp_path, [EXTERNAL_RELATIVE_PATH]).combined_sha256 != original_fingerprint.combined_sha256


def test_compute_source_fingerprint_ignores_test_files(tmp_path: Path) -> None:
    """只改測試檔：合併雜湊不變。"""
    build_repository(tmp_path)
    original_fingerprint = compute_source_fingerprint(tmp_path, [EXTERNAL_RELATIVE_PATH])

    (tmp_path / "analysis" / "tests" / "test_sample.py").write_text("CHANGED = True\n", encoding="utf-8")

    assert compute_source_fingerprint(tmp_path, [EXTERNAL_RELATIVE_PATH]) == original_fingerprint


def test_compute_source_fingerprint_lists_relative_paths(tmp_path: Path) -> None:
    """指紋的檔案鍵：相對 repo 根目錄、以斜線分隔的路徑。"""
    build_repository(tmp_path)

    source_fingerprint = compute_source_fingerprint(tmp_path, [EXTERNAL_RELATIVE_PATH])

    assert sorted(source_fingerprint.code_files) == ["analysis/first_module.py", "analysis/second_module.py"]
    assert list(source_fingerprint.external_files) == [EXTERNAL_RELATIVE_PATH]


def test_build_raw_manifest_records_relative_path_size_and_hash(tmp_path: Path) -> None:
    """原始檔清單：每個檔記下相對輸入目錄的路徑、大小與 sha256。"""
    raw_file = tmp_path / "2024-01_2024-12" / "trading_price.csv"
    raw_file.parent.mkdir()
    raw_file.write_bytes(b"I,TRADING,PRICE\n")

    raw_manifest = build_raw_manifest([raw_file], tmp_path)

    assert len(raw_manifest) == 1
    assert raw_manifest[0].relative_path == "2024-01_2024-12/trading_price.csv"
    assert raw_manifest[0].size_bytes == len(b"I,TRADING,PRICE\n")
    assert raw_manifest[0].sha256 == hashlib.sha256(b"I,TRADING,PRICE\n").hexdigest()
