"""A line's composition has ONE reader (spec workshop-product-variants, rule 10).

``qty_per_unit`` is the product's STANDARD count; a line may choose options
and change counts, so any code that multiplies a line's quantity by
``qty_per_unit`` directly reads the wrong kit. Only the product's authoring
code, the stock ledger's "has a shelf" predicate and the one reader
(``services/line_composition.py``) may read it.
"""

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"

ALLOWED: dict[str, str] = {
    "models/product.py": "the column itself",
    "api/routes/products.py": "product authoring — the part editor, card, export",
    "api/routes/library.py": "the library's product card shows the product's standard kit",
    "services/product_sync.py": "seeds parts from a sliced file",
    "services/product_composition.py": "plate recipes and part merges (authoring)",
    "services/product_card.py": "product export / import",
    "services/order_from_files.py": "builds a product from files (authoring)",
    "services/line_composition.py": "THE reader — composition and standard_per",
    "services/part_stock.py": "is_counted / counted_part_clause / balances — whether a part has a shelf at all",
}


def _reads(tree: ast.AST) -> list[int]:
    return sorted(
        node.lineno
        for node in ast.walk(tree)
        if isinstance(node, ast.Attribute) and node.attr == "qty_per_unit" and isinstance(node.ctx, ast.Load)
    )


def test_nobody_else_reads_the_standard_count():
    offenders = []
    for path in APP.rglob("*.py"):
        rel = path.relative_to(APP).as_posix()
        if rel in ALLOWED or rel.startswith("migrations/") or rel.startswith("schemas/"):
            continue
        for line in _reads(ast.parse(path.read_text(encoding="utf-8"))):
            offenders.append(f"{rel}:{line}")
    assert offenders == []


def test_the_scan_sees_a_read_when_there_is_one():
    assert _reads(ast.parse("need = line.quantity * part.qty_per_unit\npart.qty_per_unit = 3\n")) == [1]
