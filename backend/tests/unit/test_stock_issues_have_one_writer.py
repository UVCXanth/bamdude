"""Only services/stock_issues.py writes stock_issues (spec workshop-order-issue, rule 10)."""

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"
ALLOWED = {APP / "services" / "stock_issues.py", APP / "models" / "stock_issue.py"}


def _writes(tree: ast.AST) -> list[int]:
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else None
            if name == "StockIssue":
                hits.append(node.lineno)
            elif name in {"insert", "update", "delete"} and node.args and isinstance(node.args[0], ast.Name):
                if node.args[0].id == "StockIssue":
                    hits.append(node.lineno)
        elif isinstance(node, (ast.Assign, ast.AugAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for target in targets:
                if isinstance(target, ast.Attribute) and target.attr == "waybill":
                    hits.append(node.lineno)
    return sorted(hits)


def test_nothing_but_the_writer_writes_issues():
    offenders = []
    for path in APP.rglob("*.py"):
        if path in ALLOWED or "migrations" in path.parts:
            continue
        offenders += [f"{path.relative_to(APP)}:{n}" for n in _writes(ast.parse(path.read_text(encoding="utf-8")))]
    assert offenders == []


def test_the_scan_sees_a_writer():
    tree = ast.parse("db.add(StockIssue(customer_id=1))\nawait db.execute(delete(StockIssue))\nissue.waybill = 'x'\n")
    assert _writes(tree) == [1, 2, 3]
