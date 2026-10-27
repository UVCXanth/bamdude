"""Which writers may call their change picture-only (spec procurement-stock-images R3, consilium O2).

``part_images_changed`` carries ``images_only`` only for a transaction whose every mark said so, and
the clients then skip the stock and order reads. A writer that marks itself picture-only while it
moves a name, a part or a link would hide that change from every open stock and order view -- so
the doors that may are listed here, and a new one fails this test until somebody says why.
"""

import ast
from pathlib import Path

import backend.app as app_package

#: (module, function) -> why its change is only the picture.
PURE_DOORS = {
    ("services/part_images.py", "set_choice"): "the editor's choice: product_parts.image_* only",
    ("services/part_images.py", "set_photo"): "a photo: product_parts.image_* and the part's photo files",
    ("services/part_images.py", "clear_photo"): "back to auto: product_parts.image_* only",
    ("services/part_images.py", "mark_renders_changed"): "a render transition: plate_renders only",
}

ROOT = Path(app_package.__file__).parent


def _is_mark_changed(call: ast.Call) -> bool:
    func = call.func
    return (isinstance(func, ast.Name) and func.id == "mark_changed") or (
        isinstance(func, ast.Attribute) and func.attr == "mark_changed"
    )


def _flag(call: ast.Call) -> ast.expr | None:
    for keyword in call.keywords:
        if keyword.arg == "images_only":
            return keyword.value
    if len(call.args) >= 3:  # mark_changed(db, product_ids, images_only)
        return call.args[2]
    return None


def _says_full(flag: ast.expr | None) -> bool:
    return flag is None or (isinstance(flag, ast.Constant) and flag.value is False)


def _pure_calls() -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path in ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        module = path.relative_to(ROOT).as_posix()
        for function in ast.walk(tree):
            if not isinstance(function, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            for node in ast.walk(function):
                if isinstance(node, ast.Call) and _is_mark_changed(node) and not _says_full(_flag(node)):
                    found.add((module, function.name))
    return found


def test_only_the_listed_doors_mark_a_change_picture_only():
    assert _pure_calls() == set(PURE_DOORS)


def test_the_scan_reads_a_positional_flag_too():
    tree = ast.parse("def door(db):\n    part_images.mark_changed(db, [1], True)\n")
    call = next(node for node in ast.walk(tree) if isinstance(node, ast.Call))
    assert _is_mark_changed(call) and not _says_full(_flag(call))
