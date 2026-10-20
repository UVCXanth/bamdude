import ast
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

from backend.app.services.auto_queue_waiting import KNOWN_REASONS, fact, offline_params, routing_params
from backend.app.services.filament_routing import RoutingPolicy
from backend.app.services.printer_feed_snapshot import FeedSource, PrinterFeedSnapshot


def test_every_routing_and_requirement_reason_has_an_explicit_policy():
    codes = set()
    for filename in ("filament_routing.py", "filament_requirements.py"):
        tree = ast.parse((Path("backend/app/services") / filename).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            expressions = []
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
                if node.func.id == "RoutingResult" and len(node.args) > 1:
                    expressions.append(node.args[1])
                if node.func.id == "_Unavailable":
                    expressions.extend(node.args[:1])
                if node.func.id == "PrintRequirements":
                    expressions.extend(keyword.value for keyword in node.keywords if keyword.arg == "reason")
            if isinstance(node, ast.Return) and isinstance(node.value, ast.Tuple):
                if isinstance(node.value.elts[0], ast.Constant) and node.value.elts[0].value is False:
                    expressions.append(node.value.elts[1])
            if isinstance(node, ast.Assign) and any(
                isinstance(target, ast.Name) and target.id == "reason" for target in node.targets
            ):
                expressions.append(node.value)
            for expression in expressions:
                codes.update(
                    item.value
                    for item in ast.walk(expression)
                    if isinstance(item, ast.Constant) and isinstance(item.value, str)
                )
    assert codes
    assert codes <= KNOWN_REASONS, codes - KNOWN_REASONS


def _evidence():
    requirements = SimpleNamespace(
        used_filaments=({"slot_id": 1, "type": "PLA", "color": "FF0000", "nozzle_id": 0},),
        nozzle_constraints={0: (0.4,)},
    )
    snapshot = PrinterFeedSnapshot(
        printer_id=7,
        model="A1MINI",
        connected=True,
        generation=1,
        revision="old",
        ams_known=True,
        ams_present=True,
        external_known=True,
        sources=(
            FeedSource(0, "ams", "PETG", "00FF00", nozzles=(0,), remain=100),
            FeedSource(1, "ams", "ABS", "0000FF", nozzles=(0,), remain=100),
        ),
        nozzle_diameters={0: (0.4,)},
    )
    return requirements, RoutingPolicy(), snapshot


def test_key_ignores_display_locale_remaining_and_snapshot_revision():
    req, policy, snapshot = _evidence()
    first = fact(
        "material_mismatch",
        7,
        params=routing_params("material_mismatch", req, policy, snapshot, (1,)),
        message="First printer needs PLA",
    )
    moved = replace(
        snapshot,
        revision="new",
        generation=99,
        sources=tuple(replace(source, remain=1) for source in reversed(snapshot.sources)),
    )
    second = fact(
        "material_mismatch",
        7,
        params=routing_params("material_mismatch", req, policy, moved, (1,)),
        message="Інша назва, інший переклад",
    )
    assert first.key("A1MINI", None) == second.key("A1 Mini", None)
    assert first.key("A1MINI", None) != second.key("A1 Mini", 2)
    assert first.key("A1MINI", None) != fact("nozzle_mismatch", 7).key("A1MINI", None)


def test_material_slot_and_forced_color_changes_are_new_facts():
    req, policy, snapshot = _evidence()

    def key(requirements, code="material_mismatch", policy=policy):
        return fact(code, 7, params=routing_params(code, requirements, policy, snapshot)).key("A1MINI", None)

    baseline = key(req)
    assert baseline != key(SimpleNamespace(used_filaments=({"slot_id": 1, "type": "ASA"},)))
    assert baseline != key(SimpleNamespace(used_filaments=({"slot_id": 2, "type": "PLA"},)))
    strict = replace(policy, force_color_match=True)
    blue = SimpleNamespace(used_filaments=({"slot_id": 1, "type": "PLA", "color": "0000FF"},))
    assert key(req, "color_mismatch", strict) != key(blue, "color_mismatch", strict)


def test_unknown_reason_is_actionable_without_using_display_identity():
    first = fact("future_reason", message="display")
    assert first.actionable and first.code == "routing_unclassified"
    assert first.key("P1S", None) == fact("future_reason", message="translated").key("P1S", None)
    assert first.key("P1S", None) != fact("another_reason").key("P1S", None)
    for code in ("printer_busy", "placement_conflict", "swap_request_refused", "source_check_busy", "source_timeout"):
        assert not fact(code).actionable


def test_offline_facts_normalize_materials_and_respect_per_channel_forced_color():
    from backend.app.services.offline_feed import OfflineFeed, OfflineSource

    req, policy, snapshot = _evidence()
    policy = replace(policy, filament_overrides=({"slot_id": 1, "force_color_match": True},))
    missing = [{"slot": 1, "wanted": "display-only"}]
    feed = OfflineFeed((OfflineSource("ams", "pla", "0000FF"),))

    def key(feed):
        return fact("printer_off_missing_filament", 7, params=offline_params(req, policy, snapshot, missing, feed)).key(
            "A1MINI", None
        )

    assert key(feed) == key(OfflineFeed((OfflineSource("ams", "PLA", "0000FF"),)))
    assert key(feed) != key(OfflineFeed((OfflineSource("ams", "PLA", "00FF00"),)))
