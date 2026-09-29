"""Only services/product_variants.py writes variant groups and options (WS-13 E1, spec VR1).

The six variant routes, the atomic ``PUT …/variants``, a product copy and the ZIP
import all go through the one writer, behind the product gate. No allowlist beyond
the writer itself and the model — a product's deletion drops its groups through the
ORM cascade of ``Product``, which is the product's end, not a variant write.
"""

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"
ALLOWED = {APP / "services" / "product_variants.py", APP / "models" / "product_variant.py"}
MODELS = {"ProductVariantGroup", "ProductVariantOption"}


def _writes(tree: ast.AST) -> list[int]:
    hits = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
        if name in MODELS:
            hits.append(node.lineno)
        elif name in {"insert", "update", "delete"} and node.args:
            first = node.args[0]
            if isinstance(first, ast.Name) and first.id in MODELS:
                hits.append(node.lineno)
        elif name in {"append", "remove"} and isinstance(func, ast.Attribute):
            owner = func.value
            if isinstance(owner, ast.Attribute) and owner.attr == "options":
                hits.append(node.lineno)
    return sorted(hits)


def test_nothing_but_the_variant_writer_writes_groups_and_options():
    offenders = []
    for path in APP.rglob("*.py"):
        if path in ALLOWED or "migrations" in path.parts:
            continue
        for line in _writes(ast.parse(path.read_text(encoding="utf-8"))):
            offenders.append(f"{path.relative_to(APP)}:{line}")
    assert offenders == []


def test_the_scan_sees_a_writer_when_there_is_one():
    # A guard that could never fail proves nothing.
    tree = ast.parse(
        "db.add(ProductVariantGroup(product_id=1))\n"
        "await db.execute(delete(ProductVariantOption))\n"
        "group.options.append(option)\n"
        "group.options.remove(option)\n"
    )
    assert _writes(tree) == [1, 2, 3, 4]
