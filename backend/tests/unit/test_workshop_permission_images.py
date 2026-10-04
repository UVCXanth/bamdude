"""Every Workshop gate is an image of what the route asked before the split (WS-13 E13 T14, m194).

``projects:read/create/update/delete`` and ``projects:file_prints`` were replaced by sixteen
domain rights (orders, products, customers, stock). m194 gives every group the IMAGE of what
it held — each new right has one old source — so a route that now asks any image of its old
permission is still open to exactly the migrated holders. The routes' old gates are frozen in
``tests/fixtures/workshop_gates_before_m194.json`` (taken on the last commit before the split).

A later commit that deliberately asks MORE than an image (a second right for a consequence, a
read mask) lists the route in ``DEVIATIONS`` with its reason; nothing may silently ask less.
"""

from __future__ import annotations

import json
import typing
from pathlib import Path

from fastapi.routing import APIRoute

from backend.app.main import app

FROZEN = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "workshop_gates_before_m194.json").read_text(encoding="utf-8")
)

IMAGES: dict[str, set[str]] = {
    "projects:read": {"orders:read", "products:read", "customers:read", "stock:read"},
    "projects:create": {"orders:create", "products:create", "customers:create"},
    "projects:update": {"orders:update", "products:update", "customers:update", "stock:move", "stock:adjust"},
    "projects:delete": {"orders:delete", "products:delete", "customers:delete"},
    "projects:file_prints": {"orders:file_prints"},
}
WORKSHOP = set().union(*IMAGES.values())

# Route → why its gate is not an image of its old one (each added by a later commit, WS-13 E13 T15).
DEVIATIONS: dict[str, str] = {
    "POST /api/v1/projects/{project_id}/duplicate": "copying an order reads the source: orders:read beside orders:create",
    "POST /api/v1/products/{product_id}/duplicate": "copying a product reads the source: products:read beside products:create",
    # A directory without personal data the contact editors and both issue dialogs read (R12).
    "GET /api/v1/delivery-methods": "any of the customers' reads and writes, orders:update or stock:move",
    "GET /api/v1/delivery-methods/": "any of the customers' reads and writes, orders:update or stock:move",
    "PUT /api/v1/projects/{project_id}/lines/{line_id}/configuration": (
        "the preview writes nothing and is a read (orders:read at the gate); the change itself asks "
        "orders:update inside, and stock:move when the line holds stock (ORD-17)"
    ),
    # F(print) = orders:file_prints OR (orders:update AND the archive's own right), asked per print (O21).
    "POST /api/v1/projects/{project_id}/add-archives": "either half of F(print) at the gate; F per print inside",
    "POST /api/v1/projects/{project_id}/remove-archives": "either half of F(print) at the gate; F per print inside",
}


def _gates(dependant) -> typing.Iterator[tuple[str, list[str]]]:
    for dep in dependant.dependencies:
        call = dep.call
        names = getattr(getattr(call, "__code__", None), "co_freevars", ())
        cells = dict(zip(names, getattr(call, "__closure__", None) or (), strict=False))
        if "perm_strings" in cells:
            mode = "any" if "require_any_permission" in call.__qualname__ else "all"
            yield mode, list(cells["perm_strings"].cell_contents)
        elif "all_perm" in cells:
            yield "all", [cells["all_perm"].cell_contents]
        yield from _gates(dep)


def _current() -> dict[str, list[tuple[str, list[str]]]]:
    out: dict[str, list[tuple[str, list[str]]]] = {}
    for route in app.routes:
        if isinstance(route, APIRoute):
            for method in route.methods:
                out[f"{method} {route.path}"] = list(_gates(route.dependant))
    return out


def _perms(gates) -> set[str]:
    return {p for _mode, perms in gates for p in perms}


def test_no_route_asks_a_retired_projects_permission():
    stale = {
        key: sorted(_perms(g)) for key, g in _current().items() if any(p.startswith("projects:") for p in _perms(g))
    }
    assert stale == {}


def test_every_frozen_route_still_asks_a_workshop_right():
    current = _current()
    missing = [key for key in FROZEN if key not in current]
    assert missing == []
    unguarded = [key for key in FROZEN if not (_perms(current[key]) & WORKSHOP)]
    assert unguarded == []


def test_each_workshop_gate_is_an_image_of_what_the_route_asked():
    current = _current()
    wrong = {}
    for key, old_gates in FROZEN.items():
        if key in DEVIATIONS:
            continue
        old = _perms(old_gates)
        allowed = set().union(*(IMAGES[p] for p in old if p in IMAGES))
        asked = _perms(current[key]) & WORKSHOP
        if not asked <= allowed:
            wrong[key] = sorted(asked - allowed)
    assert wrong == {}


def test_the_other_sections_rights_of_a_route_did_not_change():
    current = _current()
    changed = {}
    for key, old_gates in FROZEN.items():
        if key in DEVIATIONS:
            continue
        # The frozen file holds only the gates that asked ``projects:*``; compare the same.
        old_other = {p for p in _perms(old_gates) if not p.startswith("projects:")}
        new_other = _perms([g for g in current[key] if set(g[1]) & WORKSHOP]) - WORKSHOP
        if old_other != new_other:
            changed[key] = (sorted(old_other), sorted(new_other))
    assert changed == {}
