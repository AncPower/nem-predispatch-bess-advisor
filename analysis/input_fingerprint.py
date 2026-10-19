"""`data/factor_weights.json` 的輸入指紋：判斷 JSON 是否由目前的程式與外部資料產生。

- 程式：`analysis/` 第一層的所有 `.py`（不含 `analysis/tests/`）各自的 sha256。
- 外部資料：實際讀到的 `data/external/` 檔案各自的 sha256。
- 合併雜湊：上兩者排序後再算一次 sha256。CI 沒有原始資料，只重算這個值，和 JSON 比對。
- 原始資料清單：每個原始檔的相對路徑、大小、sha256，只記錄，CI 不驗證。
"""

import hashlib
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

HASH_CHUNK_BYTES: int = 1 << 20
CODE_FILE_PATTERN: str = "*.py"
CODE_SECTION_LABEL: str = "code"
EXTERNAL_SECTION_LABEL: str = "external"


@dataclass(frozen=True)
class SourceFingerprint:
    """程式與外部資料的雜湊，以及合併雜湊。"""

    code_files: dict[str, str]
    external_files: dict[str, str]
    combined_sha256: str


@dataclass(frozen=True)
class RawFileEntry:
    """一個原始資料檔的記錄。"""

    relative_path: str
    size_bytes: int
    sha256: str


def compute_file_sha256(file_path: Path) -> str:
    """分塊讀取檔案算 sha256，不把整個檔案載入記憶體。

    Args:
        file_path: 檔案路徑。

    Returns:
        十六進位的 sha256。
    """
    file_hash = hashlib.sha256()
    with file_path.open("rb") as binary_file:
        while file_chunk := binary_file.read(HASH_CHUNK_BYTES):
            file_hash.update(file_chunk)
    return file_hash.hexdigest()


def list_code_files(analysis_directory: Path) -> list[Path]:
    """列出算指紋用的分析程式檔：第一層的 `.py`，不含子目錄（測試）。

    Args:
        analysis_directory: `analysis/` 目錄。

    Returns:
        依檔名排序的路徑。
    """
    return sorted(analysis_directory.glob(CODE_FILE_PATTERN))


def digest_files(file_paths: Iterable[Path], base_directory: Path) -> dict[str, str]:
    """「相對路徑（斜線分隔）→ sha256」。

    Args:
        file_paths: 檔案路徑。
        base_directory: 相對路徑的基準目錄。

    Returns:
        依相對路徑排序的雜湊表。
    """
    file_digests = {
        file_path.relative_to(base_directory).as_posix(): compute_file_sha256(file_path) for file_path in file_paths
    }
    return dict(sorted(file_digests.items()))


def combine_digests(code_files: Mapping[str, str], external_files: Mapping[str, str]) -> str:
    """把程式與外部資料的雜湊合併成一個 sha256，與字典順序無關。

    Args:
        code_files: 程式檔的「路徑 → sha256」。
        external_files: 外部資料的「路徑 → sha256」。

    Returns:
        十六進位的合併雜湊。
    """
    digest_lines = [f"{CODE_SECTION_LABEL}\t{path_text}\t{sha_text}\n" for path_text, sha_text in sorted(code_files.items())]
    digest_lines += [
        f"{EXTERNAL_SECTION_LABEL}\t{path_text}\t{sha_text}\n" for path_text, sha_text in sorted(external_files.items())
    ]
    return hashlib.sha256("".join(digest_lines).encode("utf-8")).hexdigest()


def compute_source_fingerprint(repository_root: Path, external_relative_paths: Iterable[str]) -> SourceFingerprint:
    """算目前 repo 的程式與外部資料指紋；產生 JSON 與檢查 JSON 是否過期都用這個函式。

    Args:
        repository_root: repo 根目錄。
        external_relative_paths: 分析實際讀取的外部資料（相對 repo 根目錄）。

    Returns:
        指紋。
    """
    code_files = digest_files(list_code_files(repository_root / "analysis"), repository_root)
    external_files = digest_files(
        (repository_root / relative_path for relative_path in external_relative_paths), repository_root
    )
    return SourceFingerprint(code_files, external_files, combine_digests(code_files, external_files))


def build_raw_manifest(raw_file_paths: Iterable[Path], input_directory: Path) -> tuple[RawFileEntry, ...]:
    """原始資料檔清單。

    Args:
        raw_file_paths: 實際讀取的原始檔。
        input_directory: 原始資料根目錄（`NEM_INPUT_DIRECTORY`）。

    Returns:
        依相對路徑排序的記錄。
    """
    raw_entries = [
        RawFileEntry(
            relative_path=raw_file_path.relative_to(input_directory).as_posix(),
            size_bytes=raw_file_path.stat().st_size,
            sha256=compute_file_sha256(raw_file_path),
        )
        for raw_file_path in raw_file_paths
    ]
    return tuple(sorted(raw_entries, key=lambda raw_entry: raw_entry.relative_path))
