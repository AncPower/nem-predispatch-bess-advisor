"""`analysis/` 模組層級：只能匯入較低層的模組，與 `docs/module_map.md` 一致。"""

import ast
from pathlib import Path

ANALYSIS_DIRECTORY = Path(__file__).resolve().parents[1]
MODULE_LAYERS: dict[str, int] = {
    "aemo_csv": 0,
    "arbitrage_revenue": 1,
    "daily_factors": 1,
    "battery_fleet": 1,
    "factor_weights": 1,
    "local_sources": 2,
    "build_factor_weights": 3,
}


def read_local_imports(module_name: str) -> list[str]:
    """模組匯入的 `analysis.*` 模組名稱。"""
    syntax_tree = ast.parse((ANALYSIS_DIRECTORY / f"{module_name}.py").read_text(encoding="utf-8"))
    return [
        import_node.module.removeprefix("analysis.")
        for import_node in ast.walk(syntax_tree)
        if isinstance(import_node, ast.ImportFrom) and import_node.module and import_node.module.startswith("analysis.")
    ]


def test_every_analysis_module_has_a_layer() -> None:
    module_names = sorted(module_path.stem for module_path in ANALYSIS_DIRECTORY.glob("*.py") if module_path.stem != "__init__")

    assert module_names == sorted(MODULE_LAYERS)


def test_analysis_modules_import_only_lower_layers() -> None:
    layer_violations = [
        f"{module_name} → {imported_name}"
        for module_name, module_layer in MODULE_LAYERS.items()
        for imported_name in read_local_imports(module_name)
        if MODULE_LAYERS[imported_name] >= module_layer
    ]

    assert layer_violations == []
