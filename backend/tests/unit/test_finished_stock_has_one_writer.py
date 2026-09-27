"""Only services/finished_stock.py writes finished goods (spec workshop-finished-goods, rule 7)."""

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"
ALLOWED = {APP / "services" / "finished_stock.py", APP / "models" / "finished_stock.py"}
MODELS = {"StockItem", "StockItemMovement"}
#: The balance and the position's parameters — no other module sets them.
COLUMNS = {"on_hand", "reserved", "min_qty"}


def _writes(tree: ast.AST) -> list[int]:
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name in MODELS:
                hits.append(node.lineno)
            elif name in {"insert", "update", "delete"} and node.args:
                first = node.args[0]
                if isinstance(first, ast.Name) and first.id in MODELS:
                    hits.append(node.lineno)
        elif isinstance(node, (ast.Assign, ast.AugAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Attribute) and target.attr in COLUMNS:
                    hits.append(node.lineno)
    return sorted(hits)


def test_nothing_but_the_writer_writes_finished_goods():
    offenders = []
    for path in APP.rglob("*.py"):
        if path in ALLOWED or "migrations" in path.parts:
            continue
        for line in _writes(ast.parse(path.read_text(encoding="utf-8"))):
            offenders.append(f"{path.relative_to(APP)}:{line}")
    assert offenders == []


def test_the_scan_sees_a_writer_when_there_is_one():
    tree = ast.parse("db.add(StockItemMovement(item_id=1))\nawait db.execute(delete(StockItem))\nitem.on_hand += 1\n")
    assert _writes(tree) == [1, 2, 3]
