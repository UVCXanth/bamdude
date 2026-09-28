"""Only services/part_stock.py writes a parts line's counters (spec workshop-order-issue, rule 9)."""

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"
ALLOWED = {APP / "services" / "part_stock.py", APP / "models" / "project_line.py"}
#: The same names are a product line's counters, which services/finished_stock.py writes.
SHARED_WITH_THE_LINE = APP / "services" / "finished_stock.py"
COUNTERS = {"received", "issued", "returned", "written_off"}


def _writes(tree: ast.AST, *, counters: bool = True) -> list[int]:
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name == "ProjectLinePartStock":
                hits.append(node.lineno)
            elif name in {"insert", "update", "delete"} and node.args and isinstance(node.args[0], ast.Name):
                if node.args[0].id == "ProjectLinePartStock":
                    hits.append(node.lineno)
        elif counters and isinstance(node, (ast.Assign, ast.AugAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Attribute) and target.attr in COUNTERS:
                    hits.append(node.lineno)
    return sorted(hits)


def test_nothing_but_the_writer_writes_a_parts_lines_counters():
    offenders = []
    for path in APP.rglob("*.py"):
        if path in ALLOWED or "migrations" in path.parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        offenders += [f"{path.relative_to(APP)}:{n}" for n in _writes(tree, counters=path != SHARED_WITH_THE_LINE)]
    assert offenders == []


def test_the_scan_sees_a_writer():
    tree = ast.parse(
        "db.add(ProjectLinePartStock(line_id=1, part_id=2))\n"
        "await db.execute(update(ProjectLinePartStock))\n"
        "row.received += 1\n"
    )
    assert _writes(tree) == [1, 2, 3]
