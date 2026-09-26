"""Only services/product_facets.py writes product_facets (spec workshop-product-catalog, rule 7)."""

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"
ALLOWED = {APP / "services" / "product_facets.py", APP / "models" / "product.py"}


def _writes(tree: ast.AST) -> list[int]:
    hits = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
        if name == "ProductFacet":
            hits.append(node.lineno)
        elif name in {"insert", "update", "delete"} and node.args:
            first = node.args[0]
            if isinstance(first, ast.Name) and first.id == "ProductFacet":
                hits.append(node.lineno)
    return hits


def test_nothing_but_the_facet_writer_writes_the_facets():
    offenders = []
    for path in APP.rglob("*.py"):
        if path in ALLOWED or "migrations" in path.parts:
            continue
        for line in _writes(ast.parse(path.read_text(encoding="utf-8"))):
            offenders.append(f"{path.relative_to(APP)}:{line}")
    assert offenders == []


def test_the_scan_sees_a_writer_when_there_is_one():
    # A guard that could never fail proves nothing.
    tree = ast.parse("db.add(ProductFacet(product_id=1))\nawait db.execute(delete(ProductFacet))\n")
    assert _writes(tree) == [1, 2]
