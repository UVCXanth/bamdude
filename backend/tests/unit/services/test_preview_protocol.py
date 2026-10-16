"""Untrusted local messages must be rejected before opening any artifact."""

import uuid

import pytest

from backend.app.services.preview_protocol import (
    OUTCOMES,
    STAGES,
    VERSION,
    Command,
    PreviewError,
    attempt_kind,
    decode,
    encode,
)

CAD = {"manifest_digest": "d" * 64, "bundle_key": "win-x64-cp312"}


def command():
    return {
        "protocol_version": VERSION,
        "app_generation": "a",
        "service_epoch": "b",
        "attempt_id": uuid.uuid4().hex,
        "attempt_seq": 1,
        "operation": "run",
        "deadline_monotonic_ns": 123,
        "manifest": [],
        "cad": None,
    }


def mesh(value, kind, role="mesh"):
    return {"role": role, "key": f"{value['attempt_id']}_{role}", "kind": kind, "size": 10, "digest": "a" * 64}


def test_roundtrip():
    value = command()
    assert Command.parse(decode(encode(value)), "a", "b").wire() == value


@pytest.mark.parametrize(
    "change",
    [
        {"protocol_version": VERSION + 1},
        {"protocol_version": VERSION - 1},  # an old service or main never talks to a new one
        {"protocol_version": True},
        {"service_epoch": "old"},
        {"app_generation": "old"},
        {"attempt_id": "../secret"},
        {"attempt_seq": True},
        {"attempt_seq": 0},
        {"operation": "exec"},
        {"path": "secret"},
        {"manifest": {}},
    ],
)
def test_closed_envelope(change):
    with pytest.raises(PreviewError):
        Command.parse({**command(), **change}, "a", "b")


def test_artifact_cannot_address_another_attempt():
    value = command()
    value["manifest"] = [{"role": "mesh", "key": "other_mesh", "kind": "stl", "size": 10, "digest": "a" * 64}]
    with pytest.raises(PreviewError):
        Command.parse(value, "a", "b")


@pytest.mark.parametrize("payload", [b"[]", b"null", b"{", b" " * 16385], ids=["array", "null", "invalid", "oversized"])
def test_invalid_json(payload):
    with pytest.raises(PreviewError):
        decode(payload)


@pytest.mark.asyncio
async def test_service_failed_cleanup_cannot_leave_permanent_busy():
    import time
    from unittest.mock import AsyncMock

    from backend.app.preview_service import Service

    service = Service({})
    value = command()
    value["deadline_monotonic_ns"] = time.monotonic_ns() + 5_000_000_000
    value["operation"] = "run"
    value["manifest"] = [
        {"role": "mesh", "key": f"{value['attempt_id']}_mesh", "kind": "stl", "size": 1, "digest": "a" * 64}
    ]
    service.run = AsyncMock(side_effect=OSError("cleanup I/O failure"))
    assert await service.command(Command.parse(value, "a", "b")) == {"outcome": "unavailable"}
    assert service.active is None and service.task is None
    value["attempt_seq"] += 1
    service.run = AsyncMock(return_value={"outcome": "ok"})
    assert await service.command(Command.parse(value, "a", "b")) == {"outcome": "ok"}


def test_version_two_is_the_contract():
    assert VERSION == 2
    assert "cad_unavailable" in OUTCOMES
    assert STAGES == ("snapshot", "cad_import", "transfer", "mesh", "mesh_write", "png", "publish")


@pytest.mark.parametrize("kind", ["step", "stp"])
def test_a_step_mesh_carries_exactly_one_cad_descriptor(kind):
    value = command()
    value["manifest"] = [mesh(value, kind)]
    value["cad"] = dict(CAD)
    parsed = Command.parse(value, "a", "b")
    assert parsed.cad == CAD and attempt_kind(parsed.manifest) == "step"
    assert Command.parse(decode(encode(parsed.wire())), "a", "b") == parsed


@pytest.mark.parametrize(
    ("kind", "cad"),
    [
        ("step", None),  # STEP without the bundle it may use
        ("stl", CAD),  # a descriptor on a non-CAD attempt
        ("step", {**CAD, "path": "C:/x"}),  # closed: no absolute path from anywhere
        ("step", {"manifest_digest": "d" * 63, "bundle_key": "win-x64-cp312"}),
        ("step", {"manifest_digest": "d" * 64, "bundle_key": "../../etc"}),
        ("step", {"manifest_digest": "d" * 64, "bundle_key": "win-x64-cp312/.."}),
    ],
)
def test_cad_descriptor_is_closed(kind, cad):
    value = command()
    value["manifest"] = [mesh(value, kind)]
    value["cad"] = cad
    with pytest.raises(PreviewError):
        Command.parse(value, "a", "b")


def test_step_and_sliced_never_share_an_attempt():
    value = command()
    value["manifest"] = [mesh(value, "3mf", role="sliced"), mesh(value, "step")]
    value["cad"] = dict(CAD)
    with pytest.raises(PreviewError):
        Command.parse(value, "a", "b")


def test_kind_comes_from_the_role_not_the_first_manifest_entry():
    value = command()
    value["manifest"] = [mesh(value, "png", role="source_png"), mesh(value, "3mf", role="sliced")]
    assert attempt_kind(Command.parse(value, "a", "b").manifest) == "sliced"
    value = command()
    value["manifest"] = [mesh(value, "stl")]
    assert attempt_kind(Command.parse(value, "a", "b").manifest) == "mesh"


def test_no_hardcoded_protocol_version_literal_in_the_preview_pair():
    import ast
    from pathlib import Path

    app = Path(__file__).resolve().parents[3] / "app"
    for rel in ("services/preview_runtime.py", "preview_service.py"):
        tree = ast.parse((app / rel).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "Command":
                first = node.args[0] if node.args else None
                assert not isinstance(first, ast.Constant), (rel, node.lineno)
            if isinstance(node, ast.Dict):
                for key, val in zip(node.keys, node.values, strict=True):
                    if isinstance(key, ast.Constant) and key.value == "protocol_version":
                        assert not isinstance(val, ast.Constant), (rel, node.lineno)
            if isinstance(node, ast.Compare) and any(
                isinstance(c, ast.Constant) and c.value == 1 for c in node.comparators
            ):
                text = ast.unparse(node)
                assert "protocol_version" not in text, (rel, node.lineno, text)
