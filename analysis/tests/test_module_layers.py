"""`analysis/` 的模組層級檢查：每個模組都登記層級，且只能匯入較低層的模組。

層級與 `docs/module_map.md` 的 Python 段落一致；新增、改名或刪除模組時兩邊一起改。
"""

import ast
from pathlib import Path

ANALYSIS_DIRECTORY: Path = Path(__file__).resolve().parents[1]
PACKAGE_PREFIX: str = "analysis."
MODULE_LAYERS: dict[str, int] = {
    "nem_day": 0,
    "mms_csv": 0,
    "record_fields": 0,
    "input_fingerprint": 0,
    "arbitrage_plan": 1,
    "region_factors": 1,
    "external_factors": 1,
    "weight_solver": 1,
    "daily_revenue": 2,
    "factor_dataset": 3,
}


def read_local_imports(module_name: str) -> list[str]:
    """讀出模組匯入的 `analysis.*` 模組名稱（不含套件前綴）。"""
    syntax_tree = ast.parse((ANALYSIS_DIRECTORY / f"{module_name}.py").read_text(encoding="utf-8"))
    imported_names: list[str] = []
    for syntax_node in ast.walk(syntax_tree):
        if isinstance(syntax_node, ast.ImportFrom) and syntax_node.module:
            imported_names.append(syntax_node.module)
        elif isinstance(syntax_node, ast.Import):
            imported_names.extend(alias_node.name for alias_node in syntax_node.names)
    return [imported_name.removeprefix(PACKAGE_PREFIX) for imported_name in imported_names if imported_name.startswith(PACKAGE_PREFIX)]


def test_every_analysis_module_has_a_layer() -> None:
    """analysis/ 的每個模組都在層級表中登記。"""
    module_names = sorted(
        source_file.stem for source_file in ANALYSIS_DIRECTORY.glob("*.py") if source_file.stem != "__init__"
    )

    assert module_names == sorted(MODULE_LAYERS)


def test_modules_import_only_lower_layers() -> None:
    """每個模組只匯入層級較低的 analysis 模組。"""
    for module_name, module_layer in MODULE_LAYERS.items():
        for imported_name in read_local_imports(module_name):
            assert MODULE_LAYERS[imported_name] < module_layer, f"{module_name}（L{module_layer}）匯入了 {imported_name}"
