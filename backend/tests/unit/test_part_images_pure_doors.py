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
        if keyword.arg is None:  # **kwargs: the flag may be inside, so it counts as said
            return keyword.value
    if len(call.args) >= 3:  # mark_changed(db, product_ids, images_only)
        return call.args[2]
    if any(isinstance(arg, ast.Starred) for arg in call.args):
        return call.args[-1]
    return None


def _says_full(flag: ast.expr | None) -> bool:
    return flag is None or (isinstance(flag, ast.Constant) and flag.value is False)


def _calls_by_owner(tree: ast.AST) -> list[tuple[str, ast.Call]]:
    """Every ``mark_changed`` call with the innermost function around it -- ``<module>`` outside any."""
    found: list[tuple[str, ast.Call]] = []

    def visit(node: ast.AST, owner: str) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef):
                visit(child, child.name)
                continue
            if isinstance(child, ast.Call) and _is_mark_changed(child):
                found.append((owner, child))
            visit(child, owner)

    visit(tree, "<module>")
    return found


def _pure_calls_in(tree: ast.AST, module: str) -> set[tuple[str, str]]:
    return {(module, owner) for owner, call in _calls_by_owner(tree) if not _says_full(_flag(call))}


def _pure_calls() -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    for path in ROOT.rglob("*.py"):
        found |= _pure_calls_in(ast.parse(path.read_text(encoding="utf-8")), path.relative_to(ROOT).as_posix())
    return found


def test_only_the_listed_doors_mark_a_change_picture_only():
    assert _pure_calls() == set(PURE_DOORS)


def test_the_scan_reads_a_positional_flag_too():
    tree = ast.parse("def door(db):\n    part_images.mark_changed(db, [1], True)\n")
    call = next(node for node in ast.walk(tree) if isinstance(node, ast.Call))
    assert _is_mark_changed(call) and not _says_full(_flag(call))


def test_the_scan_sees_a_flag_passed_in_a_splat_or_outside_any_function():
    source = (
        "def door(db):\n"
        "    part_images.mark_changed(db, [1], **{'images_only': True})\n"
        "def other(db, args):\n"
        "    mark_changed(db, *args)\n"
        "part_images.mark_changed(db, [2], images_only=True)\n"
        "def plain(db):\n"
        "    part_images.mark_changed(db, [3])\n"
    )
    assert _pure_calls_in(ast.parse(source), "m.py") == {("m.py", "door"), ("m.py", "other"), ("m.py", "<module>")}
