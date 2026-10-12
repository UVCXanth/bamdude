"""The acceptance driver (plan E7, D3): an installed service renders KNOWN files through its own API.

What it accepts is stated before it runs (consilium E7-R1): each file's printed parts and the render methods
allowed. A missing or extra part, a picture that is no PNG of a real part, or a fallback where Node was expected
fails it. Every instance of a part on the file is waited for, not only the one its picture comes from, and a final
refusal is not waited for (E7.2-R1); a picture's size is its method's (E7.2-R2). What is accepted is proven too
(E7-R2): the installation's revision, its own pinned Node and its own bundle. The admin password satisfies the setup
policy (E7-R3), and no secret reaches the report or stdout."""

import hashlib
import io
import json
import os
import subprocess
from pathlib import Path

import httpx
import numpy as np
import pytest
from PIL import Image

from backend.app import part_render_acceptance as acc
from backend.app.schemas.auth import SetupRequest
from backend.app.services import part_images, render_runtime
from backend.app.services.part_render_fallback import top_mask


def png(size=(512, 512), visible=True) -> bytes:
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    if visible:
        img.paste((200, 30, 30, 255), (100, 100, 300, 300))
    out = io.BytesIO()
    img.save(out, format="PNG")
    return out.getvalue()


PICTURE = png()
PARTS = [
    {"id": 1, "name": "A", "kind": "printed"},
    {"id": 2, "name": "B", "kind": "printed"},
    {"id": 3, "name": "Screw", "kind": "purchased", "image": None},
]


def instance(
    *, setup_required=True, status=None, ready_after=1, parts=None, picture=PICTURE, methods=None, candidates=None
):
    """A fresh instance behind a mock transport. ``status`` is the ``/auth/status`` body (the route's own shape
    by default); ``candidates(part_id)`` -- when it returns a list -- replaces that part's instances (one per part
    on plate 1, ready, by default)."""
    seen = {"password": None, "polls": 0}
    parts = PARTS if parts is None else parts
    methods = methods or {1: "toolpath", 2: "toolpath"}
    status = {"auth_enabled": True, "requires_setup": setup_required} if status is None else status

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/v1/system/health":
            return httpx.Response(200, json={"status": "ok"})
        if path == "/api/v1/auth/status":
            return httpx.Response(200, json=status)
        if path == "/api/v1/auth/setup":
            body = json.loads(request.content)
            SetupRequest.model_validate(body)  # the real setup policy
            seen["password"] = body["admin_password"]
            return httpx.Response(200, json={})
        if path == "/api/v1/auth/login":
            assert json.loads(request.content)["password"] == seen["password"]
            return httpx.Response(200, json={"access_token": "tok-secret-123"})
        assert request.headers.get("authorization") == "Bearer tok-secret-123", path
        if path == "/api/v1/system/info":
            return httpx.Response(200, json={"part_render_worker": {"state": "ready", "reason": None}})
        if path == "/api/v1/library/files":
            return httpx.Response(200, json={"id": 5})
        if path == "/api/v1/products/from-file/5":
            return httpx.Response(200, json={"product": {"id": 9}})
        if path == "/api/v1/products/9":
            seen["polls"] += 1
            ready = seen["polls"] > ready_after
            out = []
            for p in parts:
                q = dict(p)
                if q["kind"] == "printed":
                    q["image"] = {
                        "kind": "render",
                        "status": "ready" if ready else "pending",
                        "v": "v1" if ready else None,
                    }
                out.append(q)
            return httpx.Response(200, json={"parts": out})
        if path.endswith("/image") and path.startswith("/api/v1/product-parts/"):
            return httpx.Response(200, content=picture, headers={"content-type": "image/png"})
        if path.endswith("/image-candidates"):
            pid = int(path.split("/")[4])
            if candidates is not None and (own := candidates(pid)) is not None:
                return httpx.Response(200, json=own)
            return httpx.Response(
                200,
                json=[
                    {
                        "library_file_id": 5,
                        "plate_index": 1,
                        "identify_id": 100 + pid,
                        "method": methods.get(pid),
                        "plate_status": "ready",
                    }
                ],
            )
        return httpx.Response(404)

    return httpx.Client(base_url="http://bamdude.test", transport=httpx.MockTransport(handler)), seen


class Clock:
    """The driver's ``sleep`` and ``now``: a poll moves time, nothing else does."""

    def __init__(self):
        self.t = 0.0

    def sleep(self, seconds):
        self.t += seconds

    def now(self):
        return self.t


def two_plates(clock, *, status_at, method="toolpath", first="ready"):
    """Part A on two plates of the file: plate 1 is ``first`` throughout, plate 2 is ``status_at(t)``."""

    def candidates(pid):
        if pid != 1:
            return None
        status = status_at(clock.t)
        return [
            {
                "library_file_id": 5,
                "plate_index": 1,
                "identify_id": 101,
                "method": "toolpath" if first == "ready" else None,
                "plate_status": first,
            },
            {
                "library_file_id": 5,
                "plate_index": 2,
                "identify_id": 201,
                "method": method if status == "ready" else None,
                "plate_status": status,
            },
        ]

    return candidates


def expect(tmp_path, parts=("A", "B"), methods=None) -> list[dict]:
    sample = tmp_path / "two-objects.gcode.3mf"
    sample.write_bytes(b"3mf")
    entry = {"path": sample.name, "parts": list(parts)}
    if methods:
        entry["methods"] = methods
    (tmp_path / "expect.json").write_text(json.dumps({"files": [entry]}), encoding="utf-8")
    return acc.load_expectations(tmp_path / "expect.json")


def quick(client, expectations, **kw):
    return acc.run(client, expectations, poll=0, sleep=lambda _s: None, **kw)


def test_two_known_parts_rendered_by_node_are_accepted(tmp_path):
    log = tmp_path / "bamdude.log"
    log.write_text(
        "x INFO Part render attempt=ab12cd34 outcome=done result=ok reason=None elapsed_ms=2710 methods={} crash=None\n",
        encoding="utf-8",
    )
    client, seen = instance()
    report = quick(client, expect(tmp_path), log=log)
    assert report["ok"] is True, report
    assert [r["name"] for r in report["files"][0]["parts"]] == ["A", "B"]
    assert report["files"][0]["parts"][0]["sha256"] == hashlib.sha256(PICTURE).hexdigest()
    assert report["files"][0]["parts"][0]["methods"] == ["toolpath"]
    assert report["attempts"] == [{"attempt": "ab12cd34", "outcome": "done", "elapsed_ms": 2710}]
    text = json.dumps(report)
    assert seen["password"] not in text and "tok-secret-123" not in text


@pytest.mark.parametrize(
    ("case", "kwargs", "problem"),
    [
        ("no parts", {"parts": []}, "missing parts"),
        ("only purchased", {"parts": [PARTS[2]]}, "missing parts"),
        ("one part lost", {"parts": [PARTS[0], PARTS[2]]}, "missing parts: ['B']"),
        ("an extra part", {"parts": [*PARTS, {"id": 4, "name": "C", "kind": "printed"}]}, "unexpected parts: ['C']"),
        ("html instead of png", {"picture": b"<!doctype html>not an image"}, "not a picture"),
        ("an empty picture", {"picture": png(visible=False)}, "no visible pixel"),
        ("a toolpath picture smaller than a master", {"picture": png(size=(24, 24))}, "not a 512x512 master"),
        ("a fallback where node was expected", {"methods": {1: "top_mask", 2: "toolpath"}}, "methods ['top_mask']"),
    ],
)
def test_short_of_the_expectation_is_refused(tmp_path, case, kwargs, problem):
    client, _ = instance(**kwargs)
    report = quick(client, expect(tmp_path))
    assert report["ok"] is False, case
    assert any(problem in p for p in report["files"][0]["problems"]), report["files"][0]["problems"]


def test_a_fallback_run_says_so_and_passes_only_as_one(tmp_path):
    client, _ = instance(methods={1: "top_mask", 2: "top_mask"})
    assert quick(client, expect(tmp_path, methods=["top_mask"]))["ok"] is True


def real_top_mask() -> bytes:
    """What production makes of a 20 px instance on a 512 px top image: a small picture, never upscaled (E3)."""
    ids = np.zeros((512, 512), dtype=np.uint32)
    ids[100:120, 100:120] = 101
    picture = top_mask((Image.new("RGBA", (512, 512), (120, 120, 120, 255)), ids), 101)
    assert picture is not None and max(Image.open(io.BytesIO(picture)).size) < 64
    return picture


def test_a_small_real_top_mask_is_accepted_where_a_fallback_is_the_point(tmp_path):
    """Consilium E7.2-R2: a top_mask keeps the top image's resolution, so a small one is a real picture."""
    both = {1: "top_mask", 2: "top_mask"}
    client, _ = instance(ready_after=0, picture=real_top_mask(), methods=both)
    assert quick(client, expect(tmp_path, methods=["top_mask"]))["ok"] is True
    client, _ = instance(ready_after=0, picture=real_top_mask(), methods=both)
    assert quick(client, expect(tmp_path))["ok"] is False  # Node was expected: still a fallback


def test_a_top_mask_larger_than_a_master_is_refused(tmp_path):
    client, _ = instance(ready_after=0, picture=png(size=(600, 600)), methods={1: "top_mask", 2: "top_mask"})
    report = quick(client, expect(tmp_path, methods=["top_mask"]))
    assert report["ok"] is False
    assert any("larger than a master" in p for p in report["files"][0]["problems"]), report


def test_the_driver_prefers_what_the_picture_resolver_prefers():
    """A toolpath / model instance is the part's picture before any top_mask (part_images._auto), so its
    size contract applies whenever one exists; the two lists must not drift."""
    assert tuple(acc.PREFERRED) == tuple(part_images._PREFERRED)


def test_a_part_on_two_plates_is_waited_for_on_both(tmp_path):
    """Consilium E7.2-R1: the picture is ready from plate 1 while plate 2 still renders -- wait for plate 2."""
    clock = Clock()
    client, _ = instance(
        ready_after=0, candidates=two_plates(clock, status_at=lambda t: "ready" if t >= 2 else "pending")
    )
    report = acc.run(client, expect(tmp_path), timeout=5, poll=1, sleep=clock.sleep, now=clock.now)
    assert report["ok"] is True, report
    assert clock.t == 2


def test_a_second_plate_that_never_finishes_fails_at_the_deadline(tmp_path):
    clock = Clock()
    client, _ = instance(ready_after=0, candidates=two_plates(clock, status_at=lambda t: "pending"))
    report = acc.run(client, expect(tmp_path), timeout=5, poll=1, sleep=clock.sleep, now=clock.now)
    assert report["ok"] is False
    assert clock.t >= 5
    assert any("plate 2: pending" in p for p in report["files"][0]["problems"]), report


@pytest.mark.parametrize(
    ("status", "method", "problem"),
    [
        ("ready", "top_mask", "expected ['toolpath']"),
        ("ready", "missing", "expected ['toolpath']"),
        ("failed", None, "plate 2: failed"),
        ("unavailable", None, "plate 2: unavailable"),
        ("none", None, "plate 2: no render queued"),
    ],
)
def test_a_second_plate_that_finished_short_is_refused_without_waiting(tmp_path, status, method, problem):
    """Plate 1 still renders, plate 2 has finished short: that answer is final, and nothing in 900 s can
    change it -- so it is not waited for."""
    clock = Clock()
    client, _ = instance(
        ready_after=10_000, candidates=two_plates(clock, status_at=lambda t: status, method=method, first="pending")
    )
    report = acc.run(client, expect(tmp_path), timeout=900, poll=1, sleep=clock.sleep, now=clock.now)
    assert report["ok"] is False
    assert clock.t == 0
    assert any(problem in p for p in report["files"][0]["problems"]), report


def test_a_missing_part_is_refused_without_waiting_for_the_pictures(tmp_path):
    clock = Clock()
    client, _ = instance(ready_after=10_000, parts=[PARTS[0], PARTS[2]])
    report = acc.run(client, expect(tmp_path), timeout=900, poll=1, sleep=clock.sleep, now=clock.now)
    assert report["ok"] is False
    assert clock.t == 0
    assert any("missing parts: ['B']" in p for p in report["files"][0]["problems"]), report


def test_no_file_or_no_part_is_no_acceptance(tmp_path):
    (tmp_path / "none.json").write_text(json.dumps({"files": []}), encoding="utf-8")
    with pytest.raises(SystemExit, match="no file"):
        acc.load_expectations(tmp_path / "none.json")
    (tmp_path / "nopart.json").write_text(json.dumps({"files": [{"path": "a.3mf", "parts": []}]}), encoding="utf-8")
    with pytest.raises(SystemExit, match="no printed part"):
        acc.load_expectations(tmp_path / "nopart.json")
    client, _ = instance()
    with pytest.raises(SystemExit, match="no file"):
        quick(client, [])


def test_a_picture_that_never_comes_fails(tmp_path):
    client, _ = instance(ready_after=10_000)
    clock = iter(range(0, 10_000, 100))
    report = acc.run(client, expect(tmp_path), timeout=500, poll=0, sleep=lambda _s: None, now=lambda: next(clock))
    assert report["ok"] is False
    assert any("picture pending" in p for p in report["files"][0]["problems"])


def test_an_instance_set_up_already_is_refused(tmp_path):
    client, _ = instance(setup_required=False)
    with pytest.raises(SystemExit, match="fresh"):
        quick(client, expect(tmp_path))


async def test_a_fresh_instance_is_recognised_by_what_the_real_route_answers(db_session):
    """The mock answered a field the server never sends, and the driver read the same one: green here, and every
    fresh instance refused as 'set up already' (E7 task 49, first run). The body is now the real route's own."""
    from backend.app.api.routes.auth import get_auth_status

    client, seen = instance(status=await get_auth_status(db_session))
    acc.sign_in(client)
    assert seen["password"] is not None


@pytest.mark.parametrize(
    "tail", ["abcdefghijklmnopqrstuvwxyzabcdef", "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEF", "abcdefABCDEF-_abcdefABCDEF-_abcd"]
)
def test_the_setup_password_meets_the_policy_whatever_the_random_tail(monkeypatch, tail):
    monkeypatch.setattr(acc.secrets, "token_urlsafe", lambda _n: tail)
    SetupRequest.model_validate({"admin_username": "acceptance", "admin_password": acc.password()})


def test_the_cli_prints_no_secret(tmp_path, capsys, monkeypatch):
    expect(tmp_path)
    client, seen = instance()
    monkeypatch.setattr(acc, "make_client", lambda base_url: client)
    monkeypatch.setattr(acc.time, "sleep", lambda _s: None)
    code = acc.main(
        [
            "--base-url",
            "http://bamdude.test",
            "--expect",
            str(tmp_path / "expect.json"),
            "--report",
            str(tmp_path / "r.json"),
            "--poll",
            "0",
        ]
    )
    out = capsys.readouterr()
    assert code == 0
    assert seen["password"] not in out.out + out.err and "tok-secret-123" not in out.out + out.err


def installation(root: Path, *, node=True) -> str:
    """A minimal installation: a Git revision, the pin, the bundle with its manifest, and (or not) its Node."""
    data = root / "backend" / "app" / "data"
    (data / "part_render").mkdir(parents=True)
    bundle = b"export const x = 1;\n"
    (data / "part_render" / "part-render.mjs").write_bytes(bundle)
    (data / "part_render" / "manifest.json").write_text(
        json.dumps({"file": "part-render.mjs", "sha256": hashlib.sha256(bundle).hexdigest()}), encoding="utf-8"
    )
    (data / "render_runtime.json").write_text(json.dumps({"version": "v24.17.0", "artifacts": {}}), encoding="utf-8")
    if node:
        key = render_runtime.platform_key()
        target = root / "runtime" / render_runtime.PRODUCT_DIR / key
        exe = render_runtime._executable(target, key)
        exe.parent.mkdir(parents=True, exist_ok=True)
        exe.write_bytes(b"")
        (target / "VERSION").write_text("v24.17.0\n", encoding="utf-8")
    git = ["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@t"]
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-q", "-m", "x"], check=True)
    return subprocess.run([*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()


def test_provenance_names_the_installation_its_node_and_its_bundle(tmp_path):
    sha = installation(tmp_path)
    found = acc.provenance(tmp_path, sha, own_root=tmp_path)
    assert found["sha"] == sha and found["node"]["version"] == "v24.17.0"
    assert found["bundle_sha256"] == hashlib.sha256(b"export const x = 1;\n").hexdigest()


def test_another_revision_is_refused(tmp_path):
    installation(tmp_path)
    with pytest.raises(SystemExit, match="is not the intended"):
        acc.provenance(tmp_path, "0" * 40, own_root=tmp_path)


def test_no_installed_node_is_refused_even_with_one_on_path(tmp_path, monkeypatch):
    sha = installation(tmp_path, node=False)
    fake = tmp_path / "elsewhere"
    fake.mkdir()
    (fake / "node").write_bytes(b"")
    # a Node first on PATH (git still on it) -- and still refused: the installation's own runtime/ is the only place
    monkeypatch.setenv("PATH", str(fake) + os.pathsep + os.environ.get("PATH", ""))
    with pytest.raises(SystemExit, match="no provisioned Node"):
        acc.provenance(tmp_path, sha, own_root=tmp_path)


def test_the_driver_must_run_from_the_installation_it_accepts(tmp_path):
    sha = installation(tmp_path)
    with pytest.raises(SystemExit, match="from the installation"):
        acc.provenance(tmp_path, sha, own_root=tmp_path / "another-checkout")


def test_a_measurement_on_another_node_is_refused(tmp_path, monkeypatch):
    out = tmp_path / "m.json"
    monkeypatch.setattr(
        acc.subprocess,
        "run",
        lambda *a, **k: out.write_text(
            json.dumps({"measure": [{"file": "a.gcode", "node": "v22.0.0", "peak_rss_python_and_node_mb": 300}]}),
            encoding="utf-8",
        ),
    )
    with pytest.raises(SystemExit, match="not the pin"):
        acc.measure(tmp_path, "node", [tmp_path / "a.gcode"], out, "v24.17.0")
