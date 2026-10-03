"""The WS-13 comparison stand (vault 60-specs/workshop-ui-parity-e00-stand.md).

The stand is a second BamDude on a scratch DATA_DIR, next to the operator's own
instance on the same machine. Everything tested here is what keeps the two
apart: the environment a stand process gets, the one folder a reset may delete,
the lock, the instance marker, the ports.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts" / "workshop_stand"))

import snapshot  # noqa: E402
import stand  # noqa: E402


def _parent_env(tmp_path: Path) -> dict[str, str]:
    foreign = tmp_path / "foreign"
    return {
        "SYSTEMROOT": r"C:\Windows",
        "PATH": r"C:\Windows\system32",
        "USERPROFILE": r"C:\Users\someone",
        "PROCESSOR_ARCHITECTURE": "AMD64",
        "BACKEND_URL": "http://evil:1",
        "BACKEND_PORT": "9",
        "DATA_DIR": str(foreign / "data"),
        "LOG_DIR": str(foreign / "logs"),
        "TEMP_DIR": str(foreign / "tmp"),
        "TEMP": str(foreign / "temp"),
        "SOME_TOKEN": "secret",
    }


def test_a_stand_process_gets_the_stand_folders_and_nothing_it_inherited(tmp_path):
    root = tmp_path / "temp" / "ws13-stand" / "baseline"
    env = stand.build_env(_parent_env(tmp_path), root=root, instance="abc", mode="baseline")

    assert env["DATA_DIR"] == str(root / "data")
    assert env["LOG_DIR"] == str(root / "logs")
    assert env["TEMP_DIR"] == str(root / "tmp")
    assert env["TEMP"] == env["TMP"] == str(root / "tmp")
    assert env["BAMDUDE_IGNORE_DOTENV"] == "1"
    assert env["WS13_STAND_INSTANCE"] == "abc"
    assert env["WS13_STAND_ROOT"] == str(root)
    assert env["TZ"] == "Europe/Kyiv"
    # The system variables Python and Node need come through…
    assert env["SYSTEMROOT"] == r"C:\Windows"
    assert env["PROCESSOR_ARCHITECTURE"] == "AMD64"
    # …and nothing else does: an inherited proxy target or token never reaches a stand process.
    for name in ("BACKEND_URL", "BACKEND_PORT", "SOME_TOKEN"):
        assert name not in env


def test_vite_is_pointed_at_this_modes_backend_on_loopback(tmp_path):
    root = tmp_path / "temp" / "ws13-stand" / "edges"
    env = stand.build_env(_parent_env(tmp_path), root=root, instance="abc", mode="edges", for_vite=True)

    assert env["BACKEND_URL"] == "http://127.0.0.1:8101"
    assert "BACKEND_PORT" not in env


def test_a_database_url_in_the_operators_shell_is_refused(tmp_path):
    parent = {**_parent_env(tmp_path), "DATABASE_URL": "postgresql://somewhere/db"}

    with pytest.raises(stand.StandError, match="DATABASE_URL"):
        stand.build_env(parent, root=tmp_path, instance="abc", mode="baseline")


# ── The one folder a reset may delete (spec A9) ──────────────────────────────


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    (repo / "temp").mkdir(parents=True)
    return repo


def _junction(link: Path, target: Path) -> None:
    import subprocess

    target.mkdir(parents=True, exist_ok=True)
    subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], check=True, capture_output=True)


windows_only = pytest.mark.skipif(sys.platform != "win32", reason="junctions are a Windows reparse point")


def test_a_first_run_creates_the_mode_root(tmp_path):
    repo = _repo(tmp_path)

    root = stand.check_root(stand.expected_root("baseline", repo), mode="baseline", repo=repo, create=True)

    assert root == repo / "temp" / "ws13-stand" / "baseline"
    assert root.is_dir()


def test_a_path_that_is_not_the_modes_root_is_refused(tmp_path):
    repo = _repo(tmp_path)
    other = repo / "temp" / "ws13-stand" / "data"
    other.mkdir(parents=True)

    with pytest.raises(stand.StandError, match="not the stand root"):
        stand.check_root(other, mode="baseline", repo=repo)


@windows_only
def test_a_junction_inside_an_existing_root_path_is_refused(tmp_path):
    repo = _repo(tmp_path)
    _junction(repo / "temp" / "ws13-stand", tmp_path / "elsewhere")
    (tmp_path / "elsewhere" / "baseline").mkdir()

    with pytest.raises(stand.StandError, match="link or junction"):
        stand.check_root(stand.expected_root("baseline", repo), mode="baseline", repo=repo)


@windows_only
def test_a_junction_in_an_existing_ancestor_is_refused_on_the_first_run(tmp_path):
    repo = _repo(tmp_path)
    _junction(repo / "temp" / "ws13-stand", tmp_path / "elsewhere")

    with pytest.raises(stand.StandError, match="link or junction"):
        stand.check_root(stand.expected_root("baseline", repo), mode="baseline", repo=repo, create=True)
    assert not (tmp_path / "elsewhere" / "baseline").exists()


def test_reset_refuses_while_a_process_of_the_manifest_is_alive(tmp_path):
    import os

    repo = _repo(tmp_path)
    root = stand.check_root(stand.expected_root("baseline", repo), mode="baseline", repo=repo, create=True)
    me = stand.process_identity(os.getpid())
    stand.write_manifest(root, {"instance_id": "x", "mode": "baseline", "processes": {"backend": me}})

    with pytest.raises(stand.StandError, match="still running"):
        stand.reset("baseline", repo=repo, init_db=False)
    assert (root / "manifest.json").exists()


def test_reset_gives_a_fresh_instance_and_forgets_the_old_one(tmp_path):
    repo = _repo(tmp_path)
    root = stand.check_root(stand.expected_root("baseline", repo), mode="baseline", repo=repo, create=True)
    stand.write_manifest(root, {"instance_id": "old", "mode": "baseline", "state": "seeded", "processes": {}})
    (root / "credentials.json").write_text('{"instance_id": "old"}')
    (root / "mapping.json").write_text("{}")

    manifest = stand.reset("baseline", repo=repo, init_db=False)

    assert manifest["instance_id"] != "old"
    assert manifest["state"] == "fresh"
    assert not (root / "credentials.json").exists()
    assert not (root / "mapping.json").exists()
    for sub in ("data", "logs", "tmp", "run"):
        assert (root / sub).is_dir()


def test_reset_refuses_a_database_url_before_it_deletes_anything(tmp_path, monkeypatch):
    repo = _repo(tmp_path)
    root = stand.check_root(stand.expected_root("baseline", repo), mode="baseline", repo=repo, create=True)
    (root / "data").mkdir()
    (root / "data" / "sentinel.db").write_bytes(b"do not delete")
    stand.write_manifest(root, {"instance_id": "kept", "mode": "baseline", "state": "seeded", "processes": {}})
    before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    monkeypatch.setenv("DATABASE_URL", "postgresql://somewhere/db")
    started = []
    monkeypatch.setattr(stand, "_init_database", lambda *a, **k: started.append(a))

    with pytest.raises(stand.StandError, match="DATABASE_URL"):
        stand.reset("baseline", repo=repo, init_db=True)

    after = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
    assert after == before
    assert started == []


# ── One mutating command at a time (spec A7) ─────────────────────────────────


def test_a_second_mutating_command_is_refused_while_the_lock_is_held(tmp_path):
    repo = _repo(tmp_path)

    with (
        stand.lock("baseline", repo=repo),
        pytest.raises(stand.StandError, match="already running"),
        stand.lock("baseline", repo=repo),
    ):
        pass


def test_the_lock_of_a_dead_process_is_taken_over(tmp_path, capsys):
    repo = _repo(tmp_path)
    path = stand.lock_path("baseline", repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"pid": 4000000000, "created": 1}')

    with stand.lock("baseline", repo=repo):
        pass

    assert "stale lock" in capsys.readouterr().out
    assert not path.exists()


# ── Only this instance is ever written to (spec A6) ──────────────────────────


def _server(tmp_path, marker: str | None):
    """A loopback HTTP server that answers every request, with or without the stand marker."""
    import http.server
    import threading

    class Handler(http.server.BaseHTTPRequestHandler):
        def _answer(self):
            self.send_response(200)
            if marker is not None:
                self.send_header("X-WS13-Stand", marker)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"setup_required": true}')

        do_GET = do_POST = _answer

        def log_message(self, *args):
            pass

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


@pytest.mark.parametrize("marker", [None, "someone-else"])
def test_a_listener_that_is_not_this_instance_gets_no_write(tmp_path, marker):
    httpd = _server(tmp_path, marker)
    try:
        client = stand.StandClient(f"http://127.0.0.1:{httpd.server_address[1]}", instance="ours")
        with pytest.raises(stand.StandError, match="not this stand"):
            client.get("/api/v1/auth/status")
    finally:
        httpd.shutdown()


def test_this_instance_answers_through(tmp_path):
    httpd = _server(tmp_path, "ours")
    try:
        client = stand.StandClient(f"http://127.0.0.1:{httpd.server_address[1]}", instance="ours")
        assert client.get("/api/v1/auth/status") == {"setup_required": True}
    finally:
        httpd.shutdown()


def test_credentials_of_an_earlier_instance_are_refused(tmp_path):
    repo = _repo(tmp_path)
    root = stand.check_root(stand.expected_root("baseline", repo), mode="baseline", repo=repo, create=True)
    (root / "credentials.json").write_text('{"instance_id": "old", "username": "a", "password": "b"}')

    with pytest.raises(stand.StandError, match="earlier instance"):
        stand.read_credentials(root, {"instance_id": "new"})


# ── Ports (spec A2) ───────────────────────────────────────────────────────────


def test_a_busy_port_is_refused_not_moved():
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        port = sock.getsockname()[1]
        with pytest.raises(stand.StandError, match=f"{port} is in use"):
            stand.require_free_port(port)


# ── The stand server: minimal lifespan, marker, network/spawn guard (A4–A5) ──
#
# ``sys.addaudithook`` cannot be removed, so every test that installs it runs
# in a throwaway child interpreter, never in the pytest worker.

_STAND_DIR = Path(__file__).resolve().parents[3] / "scripts" / "workshop_stand"


def _child(code: str, *, env: dict | None = None, timeout: float = 180) -> dict:
    import json
    import subprocess

    out = subprocess.run(
        [sys.executable, "-c", code],
        cwd=Path(__file__).resolve().parents[3],
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    assert out.returncode == 0, out.stderr[-3000:]
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_the_guard_blocks_and_logs_outbound_connections_and_process_spawns(tmp_path):
    run = tmp_path / "run"
    code = f"""
import asyncio, json, socket, subprocess, sys
sys.path.insert(0, {str(_STAND_DIR)!r})
import stand_guard
stand_guard.install({str(run)!r})
result = {{}}
def attempt(name, fn):
    try:
        fn()
        result[name] = "allowed"
    except PermissionError:
        result[name] = "blocked"
    except OSError as exc:
        result[name] = type(exc).__name__
def raw():
    with socket.socket() as s:
        s.settimeout(1)
        s.connect(("192.0.2.1", 1883))
def loopback():
    with socket.socket() as s:
        s.settimeout(1)
        s.connect(("127.0.0.1", 9))
def on_the_stand_loop():
    async def go():
        await asyncio.wait_for(asyncio.open_connection("192.0.2.1", 1883), 2)
    asyncio.run(go(), loop_factory=asyncio.SelectorEventLoop)
attempt("raw", raw)
attempt("loopback", loopback)
attempt("asyncio", on_the_stand_loop)
attempt("dns", lambda: socket.getaddrinfo("example.com", 443))
attempt("spawn", lambda: subprocess.run(["cmd", "/c", "echo", "hi"] if sys.platform == "win32" else ["true"]))
print(json.dumps(result))
"""
    result = _child(code)

    assert result["raw"] == "blocked"
    assert result["asyncio"] == "blocked"
    assert result["dns"] == "blocked"
    assert result["spawn"] == "blocked"
    assert result["loopback"] in ("ConnectionRefusedError", "TimeoutError", "allowed")
    network = (run / "network.log").read_text(encoding="utf-8")
    assert "192.0.2.1" in network and "example.com" in network and "127.0.0.1" not in network
    assert (run / "spawn.log").read_text(encoding="utf-8").strip()


def test_the_stand_app_runs_only_its_own_lifespan_and_marks_every_answer(tmp_path):
    root = tmp_path / "temp" / "ws13-stand" / "baseline"
    for sub in ("data", "logs", "tmp", "run"):
        (root / sub).mkdir(parents=True)
    import os

    env = stand.build_env(os.environ | {"DATABASE_URL": ""}, root=root, instance="inst-1", mode="baseline")
    code = f"""
import json, sys
sys.path.insert(0, {str(_STAND_DIR)!r})
import stand_app
import stand_guard
from backend.app.core import database
import backend.app.i18n as i18n
calls = []
async def fake_init_db():
    calls.append("init_db")
async def fake_language():
    calls.append("language")
    return "uk"
class Engine:
    async def dispose(self):
        calls.append("dispose")
database.init_db = fake_init_db
database.engine = Engine()
i18n.get_language = fake_language
from backend.app.core.timezones import server_timezone
from starlette.testclient import TestClient
with TestClient(stand_app.app) as client:
    answer = client.get("/api/v1/system/health")
print(json.dumps({{
    "calls": calls,
    "marker": answer.headers.get("x-ws13-stand"),
    "guard_before_main": stand_guard.INSTALLED_BEFORE_APP,
    "lifespan_replaced": stand_app.bamdude_app.router.lifespan_context is stand_app.stand_lifespan,
    "tz": getattr(server_timezone(), "key", None),
}}))
"""
    result = _child(code, env=env)

    assert result["calls"] == ["init_db", "language", "dispose"]
    assert result["marker"] == "inst-1"
    assert result["guard_before_main"] is True
    assert result["lifespan_replaced"] is True
    assert result["tz"] == "Europe/Kyiv"
    # Importing the application and answering a request made no outbound call and spawned nothing.
    assert not (root / "run" / "network.log").exists()
    assert not (root / "run" / "spawn.log").exists()


# ── B5: nothing changes in the stand without a command ──────────────────────


def _snap():
    return {
        "print_queue": {"1": {"id": 1, "status": "pending", "quantity": 1}},
        "print_archives": {"7": {"id": 7, "status": "printing", "project_line_id": 3}},
        "customers": {"9": {"id": 9, "name": "edge:C1:three-contacts"}},
        "stock_item_movements": {"1": {"id": 1, "delta_on_hand": 5}},
        "stock_items": {"2": {"id": 2, "on_hand": 5, "eta": "2026-09-30"}},
    }


@pytest.mark.parametrize(
    ("change", "table"),
    [
        (lambda s: s["print_queue"]["1"].update(status="printing"), "print_queue"),
        (lambda s: s["print_archives"]["7"].update(status="completed"), "print_archives"),
        (lambda s: s["customers"]["9"].update(name="changed"), "customers"),
        # Two movements that cancel out: the balance is the same, the ledger is not.
        (
            lambda s: s["stock_item_movements"].update(
                {"2": {"id": 2, "delta_on_hand": 3}, "3": {"id": 3, "delta_on_hand": -3}}
            ),
            "stock_item_movements",
        ),
    ],
)
def test_a_change_the_command_did_not_make_is_found(change, table):
    before, after = _snap(), _snap()
    change(after)

    diffs = snapshot.compare(before, after)

    assert diffs and all(d["table"] == table for d in diffs)


def test_no_stored_field_is_ignored():
    # A column in a table is a stored fact — `last_seen_at` of a device included.
    # Live estimates are computed per request and never reach a table snapshot.
    before, after = _snap(), _snap()
    after["stock_items"]["2"]["last_seen_at"] = "2026-10-01T00:00:00"

    assert [d["table"] for d in snapshot.compare(before, after)] == ["stock_items"]


def test_the_snapshot_reads_every_row_of_every_table(tmp_path):
    import sqlite3

    db = tmp_path / "bamdude.db"
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE print_queue (id INTEGER PRIMARY KEY, status TEXT)")
        conn.execute(
            "CREATE TABLE project_line_choices (line_id INTEGER, group_id INTEGER, option_id INTEGER, "
            "PRIMARY KEY (line_id, group_id))"
        )
        conn.execute("INSERT INTO print_queue VALUES (1, 'pending')")
        conn.execute("INSERT INTO project_line_choices VALUES (4, 2, 9)")

    taken = snapshot.take(db)

    assert taken["print_queue"] == {"1": {"id": 1, "status": "pending"}}
    assert taken["project_line_choices"] == {"4|2": {"line_id": 4, "group_id": 2, "option_id": 9}}


# ── V03: status compares what it promised, not only counts and sums ─────────

import checks  # noqa: E402

_PLATE = {"plate": 2, "model": "P1S", "seconds": 600, "filaments": [("PLA", "#FF0000"), ("PETG", "#00FF00")]}


def test_the_reader_check_passes_an_exact_answer():
    assert checks.reader_mismatches(_PLATE, {"ok": True, **_PLATE}) == []


@pytest.mark.parametrize(
    "wrong",
    [
        {"plate": 1},
        {"model": "X1C"},
        {"filaments": [("PLA", "#FF0000"), ("PETG", "#0000FF")]},
        {"filaments": [("PLA", "#FF0000")]},
        {"ok": False},
    ],
)
def test_the_reader_check_catches_a_wrong_plate_model_or_filament_at_the_right_time(wrong):
    got = {"ok": True, **_PLATE, **wrong}

    assert checks.reader_mismatches(_PLATE, got)


def test_a_queue_row_with_the_right_time_but_another_plate_is_caught():
    expected = {"plate_id": 2, "print_time_seconds": 600, "filament_type": "PLA", "filament_color": "#FF0000"}

    assert checks.row_mismatches(expected, {**expected}) == []
    assert checks.row_mismatches(expected, {**expected, "plate_id": 1})
    assert checks.row_mismatches(expected, {**expected, "filament_color": "#00ff00"})


def test_a_note_line_moved_between_lines_with_the_same_sum_is_caught():
    expected = [(1, ("кутовий",), 3), (1, ("прямий",), 2)]

    assert checks.note_mismatches(expected, [(1, ("прямий",), 2), (1, ("кутовий",), 3)]) == []
    assert checks.note_mismatches(expected, [(1, ("кутовий",), 2), (1, ("прямий",), 3)])
    assert checks.note_mismatches(expected, [(7, ("кутовий",), 3), (1, ("прямий",), 2)])


# ── V02 (review 2): a long page is covered to its end, or the recipe is not ok ─

import capture_serve  # noqa: E402


def test_the_scroll_plan_reaches_the_bottom_of_a_page_longer_than_twelve_screens():
    height, view = 13 * 900 + 350, 900

    offsets, complete = capture_serve.plan_offsets(height, view)

    assert complete
    assert offsets[0] == 0 and offsets[-1] == height - view
    # Consecutive frames overlap: no strip of the page falls between two pictures.
    assert all(b - a < view for a, b in zip(offsets, offsets[1:], strict=False))


def test_a_page_that_fits_is_one_frame():
    assert capture_serve.plan_offsets(880, 900) == ([0], True)


def test_hitting_the_safety_limit_is_an_incomplete_recipe_not_an_ok_one():
    offsets, complete = capture_serve.plan_offsets(100 * 900, 900, limit=12)

    assert not complete
    assert len(offsets) == 12


# ── WS-13 E4 F6: a pair may carry an explicit GET fixture, and nothing else ─


def _resolve(route: str) -> str:
    return route.replace("{order:241}", "57")


def test_a_pair_without_rewrites_carries_none():
    assert capture_serve.app_rewrites({"route": "/projects/{order:241}"}, _resolve) == []


def test_a_rewrite_path_is_resolved_like_the_route():
    spec = {"rewrites": [{"path": "/api/v1/projects/{order:241}", "merge": {"attachments": []}}]}

    assert capture_serve.app_rewrites(spec, _resolve) == [{"path": "/api/v1/projects/57", "merge": {"attachments": []}}]


def test_a_filter_rewrite_keeps_its_three_fields():
    rewrite = {
        "path": "/api/v1/projects/{order:241}/plan",
        "filter": {"at": "lines.*.rows.*.alternatives", "field": "filename", "match": "^clm01_p1s\\."},
    }

    assert capture_serve.app_rewrites({"rewrites": [rewrite]}, _resolve) == [
        {**rewrite, "path": "/api/v1/projects/57/plan"}
    ]


@pytest.mark.parametrize(
    "rewrite",
    [
        {"path": "/projects/{order:241}", "merge": {}},  # the page, not the API
        {"path": "https://example.com/api/v1/projects/1", "merge": {}},  # not a path
        {"path": "/api/v1/projects/{order:241}?x=1", "merge": {}},  # a query is not a path
        {"path": "/api/v1/../auth/me", "merge": {}},  # no climbing out
        {"path": "/api/v1/projects/{order:241}"},  # does nothing
        {"path": "/api/v1/projects/{order:241}", "merge": []},  # merge is an object
        {"path": "/api/v1/projects/{order:241}", "set": {"a": 1}},  # an operation nobody reads
        {"path": "/api/v1/projects/{order:241}/plan", "filter": {"at": "lines", "field": "filename"}},
        {"path": "/api/v1/projects/{order:241}/plan", "filter": {"at": "lines", "field": "f", "match": "("}},
    ],
)
def test_a_rewrite_that_is_not_a_plain_get_fixture_is_refused(rewrite):
    with pytest.raises(ValueError):
        capture_serve.app_rewrites({"rewrites": [rewrite]}, _resolve)


def test_the_mockup_side_never_carries_a_rewrite():
    # The mockup talks to no API; a fixture there would be a recipe that does nothing.
    with pytest.raises(ValueError):
        capture_serve.side_rewrites("mockup", {"rewrites": [{"path": "/api/v1/x", "merge": {}}]}, _resolve)
    assert capture_serve.side_rewrites("mockup", {"route": "#/orders/241"}, _resolve) == []


# ---- WS-13 E2 evidence sidecar (e02_evidence.py) ----

import hashlib  # noqa: E402
import json  # noqa: E402

import e02_evidence  # noqa: E402
import e03_evidence  # noqa: E402


def test_e02_narrow_plan_shoots_only_the_named_recipes_at_the_narrow_width():
    """The unmodified E0 runner, fed this plan, shoots the E2 recipes at 390 and nothing wide."""
    plan = {
        "widths": {"wide": [1920, 1440, 1024], "narrow": [390]},
        "surfaces": [
            {"id": "products-table", "widths": "wide"},
            {"id": "customer-detail", "widths": "wide"},
            {"id": "orders-table", "widths": "all"},
        ],
    }
    out = e02_evidence.narrow_plan(plan)

    assert out["widths"] == {"wide": [], "narrow": [390]}
    assert {s["id"]: s["widths"] for s in out["surfaces"]} == {
        "products-table": "all",
        "customer-detail": "all",
        "orders-table": "all",
    }
    # The plan it was given is not the plan it returns.
    assert plan["surfaces"][0]["widths"] == "wide" and plan["widths"]["wide"] == [1920, 1440, 1024]


def test_e02_record_hashes_every_picture_and_marks_a_missing_one(tmp_path, monkeypatch):
    monkeypatch.setattr(e02_evidence.stand, "REPO", tmp_path)
    shot = tmp_path / "temp" / "a.png"
    shot.parent.mkdir()
    shot.write_bytes(b"png")

    out = e02_evidence.with_hashes({"id": "x", "screenshots": [str(shot), str(tmp_path / "gone.png")]})

    assert out["screenshots"][0] == {"file": "temp/a.png", "sha256": hashlib.sha256(b"png").hexdigest()}
    assert out["screenshots"][1]["sha256"] is None


def test_e03_job_names_the_recipes_orders_and_customer_by_mockup_number():
    """The runner opens mockup orders by their number; the stand maps them to its own ids."""
    mapping = {f"order:{n}": {"id": 100 + i} for i, n in enumerate(["241", "244", "245", "247", "250", "251", "299"])}
    mapping["customer:1"] = {"id": 7}

    out = e03_evidence.job_entities(mapping)

    assert out == {
        "orders": {"241": 100, "244": 101, "245": 102, "247": 103, "250": 104, "251": 105},
        "customer": 7,
    }


def test_e03_pairs_are_the_order_detail_recipes_of_the_e0_plan():
    """Every pair recipe exists in the E0 plan — the sidecar never invents a recipe."""
    plan = json.loads(
        (Path(__file__).resolve().parents[3] / "scripts" / "workshop_stand" / "capture_plan.json").read_text(
            encoding="utf-8"
        )
    )
    ids = {surface["id"] for surface in plan["surfaces"]}
    assert set(e03_evidence.PAIR_RECIPES) <= ids


# ---- WS-13 E4 detail runner (e04_detail.js): no token leaves it, every context closes (T7-R01/R02) ----

import shutil  # noqa: E402
import subprocess  # noqa: E402

import e04_evidence  # noqa: E402

_E04_MARKER = "zq9-plural-alpha-4417-fake"
_E04_RUNNER = Path(__file__).resolve().parents[3] / "scripts" / "workshop_stand" / "e04_detail.js"
_E04_HARNESS = Path(__file__).resolve().parent / "e04_detail_harness.mjs"


def _e04_run(case: str, runner: Path = _E04_RUNNER) -> dict:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    out = subprocess.run(
        [node, str(_E04_HARNESS), str(runner), case], capture_output=True, text=True, timeout=60, check=False
    )
    # The marker is the fake token: it may reach nothing the runner writes, returns or lets escape.
    assert _E04_MARKER not in out.stdout + out.stderr
    assert out.returncode == 0, out.stderr[-2000:]
    return json.loads(out.stdout)


def _e04_records(run: dict) -> list[dict]:
    return [p["data"] for p in run["posts"] if p["path"] == "/record"]


def _e04_done(run: dict) -> dict:
    done = [p["data"] for p in run["posts"] if p["path"] == "/done"]
    assert len(done) == 1
    return done[0]


def _e04_closed_in_order(run: dict) -> None:
    """Every context the runner opened is unrouted and then closed — nothing is left open."""
    made = [e.split(".")[0] for e in run["log"] if e.endswith(".new")]
    assert made
    for ctx in made:
        closed = run["log"].index(f"{ctx}.close")
        if f"{ctx}.route" in run["log"]:
            assert run["log"].index(f"{ctx}.unrouteAll") < closed
    # The routes are the page's: a context closed with them still in place is the leak's origin.
    assert not [e for e in run["log"] if e.endswith(".closedWithRoutes")]


@pytest.mark.parametrize(
    ("case", "code", "at"),
    [
        ("prep_read_throws", "read_network", "/projects/1"),
        ("prep_read_refused", "read_http_401", "/groups/"),
        ("late_prep_read_fails", "read_http_500", "/projects/1/plan"),
    ],
)
def test_e04_a_failed_authenticated_read_ends_the_run_incomplete_and_names_no_secret(case, code, at):
    run = _e04_run(case)

    records = _e04_records(run)
    assert [r["id"] for r in records] == ["runner"]
    assert records[0]["pass"] is False
    assert records[0]["error"] == {"code": code, "stage": "prepare", "name": "RunnerFailure", "at": at}
    assert _e04_done(run)["incomplete"] is True
    assert run["returned"]["incomplete"] is True


def test_e04_a_real_scenario_that_throws_fails_safely_and_closes_its_context():
    run = _e04_run("real_scenario_throws")

    (rec,) = _e04_records(run)
    assert rec["id"] == "geometry@2560" and rec["pass"] is False
    assert rec["error"] == {"code": "error", "stage": "geometry@2560", "name": "Error"}
    assert _e04_done(run)["incomplete"] is False
    _e04_closed_in_order(run)


def test_e04_a_route_failure_during_a_live_scenario_is_a_fail():
    run = _e04_run("route_fails_live")

    (rec,) = _e04_records(run)
    assert rec["pass"] is False
    assert rec["route_errors"] == [{"code": "error", "stage": "route", "name": "Error"}]
    _e04_closed_in_order(run)


@pytest.mark.parametrize("case", ["route_fails_while_closing", "scenario_closes_its_own"])
def test_e04_a_route_failure_caused_by_the_close_is_not_the_scenarios(case):
    run = _e04_run(case)

    (rec,) = _e04_records(run)
    assert rec["pass"] is True and "route_errors" not in rec
    _e04_closed_in_order(run)


def test_e04_a_context_that_fails_while_opening_is_still_closed():
    run = _e04_run("open_fails")

    (rec,) = _e04_records(run)
    assert rec["pass"] is False and rec["error"]["stage"] == "open"
    _e04_closed_in_order(run)


def test_e04_a_scenario_that_throws_closes_every_context_it_opened():
    run = _e04_run("scenario_throws_after_open")

    (rec,) = _e04_records(run)
    assert rec["pass"] is False and "hint" not in rec["error"]
    assert [e for e in run["log"] if e.endswith(".new")] == ["ctx1.new", "ctx2.new"]
    _e04_closed_in_order(run)


def test_e04_a_record_carrying_the_token_is_replaced_by_a_failure():
    run = _e04_run("scenario_reports_the_token")

    (rec,) = _e04_records(run)
    assert rec == {
        "id": "echo",
        "ids": [],
        "source": "app",
        "pass": False,
        "error": {"code": "secret_in_record", "stage": "echo"},
    }


def test_e04_a_locator_timeout_keeps_its_first_line_and_drops_the_call_log():
    run = _e04_run("harmless_hint_is_kept")

    (rec,) = _e04_records(run)
    assert rec["error"]["hint"] == "locator.click: Timeout 5000ms exceeded."


def test_e04_a_context_left_open_outside_a_scenario_is_closed_at_the_end():
    run = _e04_run("open_outside_a_scenario")

    (rec,) = _e04_records(run)
    assert rec["id"] == "runner" and rec["pass"] is False
    assert _e04_done(run)["incomplete"] is True
    _e04_closed_in_order(run)


def test_e04_the_job_server_refuses_a_record_that_carries_the_token():
    kept = e04_evidence.keep_record(
        {"id": "x", "ids": ["E4-B01"], "pass": True, "measured": {"t": "Bearer tok-1"}}, "tok-1"
    )

    assert kept == {
        "id": "x",
        "ids": ["E4-B01"],
        "pass": False,
        "error": {"code": "secret_in_record", "stage": "serve"},
    }
    assert e04_evidence.keep_record({"id": "y", "pass": True}, "tok-1") == {"id": "y", "pass": True}


def test_e04_a_refused_record_makes_the_run_incomplete():
    run = _e04_run("record_refused")

    assert [p["status"] for p in run["posts"] if p["path"] == "/record"] == [500]
    assert _e04_done(run) == {"count": 0, "incomplete": True, "declared": ["one"]}
    assert run["returned"]["incomplete"] is True


def test_e04_a_refused_end_of_run_makes_the_run_incomplete():
    run = _e04_run("done_refused")

    assert run["returned"]["incomplete"] is True


def test_e04_the_runner_declares_exactly_the_scenarios_the_manifest_expects():
    run = _e04_run("declared")

    assert _e04_records(run) == []
    assert _e04_done(run)["declared"] == list(e04_evidence.DETAIL_SCENARIOS)


def _e04_full(**over) -> dict:
    ids = list(e04_evidence.DETAIL_SCENARIOS)
    args = {
        "finished": True,
        "done": {"count": len(ids), "incomplete": False, "declared": ids},
        "records": [{"id": i} for i in ids],
        "only": "",
    }
    return {**args, **over}


def test_e04_a_full_delivered_run_is_complete():
    assert e04_evidence.run_completeness(**_e04_full()) == {
        "complete": True,
        "problems": [],
        "missing": [],
        "unexpected": [],
    }


_E04_IDS = list(e04_evidence.DETAIL_SCENARIOS)


@pytest.mark.parametrize(
    ("over", "problem"),
    [
        ({"records": [{"id": i} for i in _E04_IDS[1:]]}, "count_mismatch"),
        ({"records": [{"id": i} for i in _E04_IDS[1:]]}, "missing_ids"),
        ({"done": {"count": len(_E04_IDS) + 1, "incomplete": False, "declared": _E04_IDS}}, "count_mismatch"),
        ({"done": {"count": len(_E04_IDS), "incomplete": True, "declared": _E04_IDS}}, "runner_incomplete"),
        ({"finished": False, "done": {}}, "no_done"),
        ({"only": "notes"}, "partial_filter"),
        ({"done": {"count": len(_E04_IDS), "incomplete": False, "declared": _E04_IDS[1:]}}, "declared_mismatch"),
        (
            {
                "records": [{"id": i} for i in [*_E04_IDS, _E04_IDS[0]]],
                "done": {"count": len(_E04_IDS) + 1, "incomplete": False, "declared": _E04_IDS},
            },
            "duplicate_ids",
        ),
        (
            {
                "records": [{"id": i} for i in [*_E04_IDS[1:], "bogus"]],
                "done": {"count": len(_E04_IDS), "incomplete": False, "declared": _E04_IDS},
            },
            "unexpected_ids",
        ),
    ],
)
def test_e04_a_run_that_lost_or_filtered_a_scenario_is_not_complete(over, problem):
    verdict = e04_evidence.run_completeness(**_e04_full(**over))

    assert verdict["complete"] is False
    assert problem in verdict["problems"]


def test_e04_the_job_server_keeps_valid_records_and_always_ends_on_done():
    import threading
    import urllib.error
    import urllib.request
    from http.server import ThreadingHTTPServer

    records: list[dict] = []
    done: dict = {}
    finished = threading.Event()
    job = {"token": "tok-1"}
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), e04_evidence.job_handler(job, records, done, finished))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def post(path: str, raw: bytes) -> int:
        req = urllib.request.Request(base + path, data=raw, method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                return res.status
        except urllib.error.HTTPError as err:
            return err.code

    try:
        assert post("/record", json.dumps({"id": "a", "pass": True}).encode()) == 200
        assert post("/record", b"[]") == 400
        assert post("/record", b"{not json") == 400
        assert post("/record", json.dumps({"id": "b", "measured": "Bearer tok-1"}).encode()) == 200
        assert [r["id"] for r in records] == ["a", "b"]
        assert records[1]["error"]["code"] == "secret_in_record"
        assert post("/done", b"{not json") == 400
        assert finished.is_set() and done == {}
    finally:
        httpd.shutdown()


def test_every_e04_pair_shows_one_order_on_both_sides_with_plain_fixtures():
    # F6: a pair is comparable only when both sides show the same order; a fixture
    # it needs is a validated GET rewrite on the app side, never a write.
    for recipe in e04_evidence.e04_recipes():
        kind, number = recipe["pair"].split(":")
        assert kind == "order", recipe["id"]
        assert recipe["mockup"]["route"] == f"#/orders/{number}", recipe["id"]
        assert recipe["app"]["route"] == f"/projects/{{order:{number}}}", recipe["id"]
        assert capture_serve.side_rewrites("mockup", recipe["mockup"], str) == []
        for rewrite in capture_serve.side_rewrites(
            "app", recipe["app"], lambda r, n=number: r.replace(f"{{order:{n}}}", "1")
        ):
            assert rewrite["path"].startswith("/api/v1/projects/1"), recipe["id"]


# ---- WS-13 E5 detail runner (e05_detail.js): E4's harness around E5's scenarios ----

import e05_evidence  # noqa: E402

_E05_RUNNER = Path(__file__).resolve().parents[3] / "scripts" / "workshop_stand" / "e05_detail.js"


@pytest.mark.parametrize(
    ("case", "code", "at"),
    [
        ("prep_read_throws", "read_network", "/projects/1"),
        ("prep_read_refused", "read_http_401", "/groups/"),
    ],
)
def test_e05_a_failed_preparation_read_ends_the_run_incomplete_and_names_no_secret(case, code, at):
    run = _e04_run(case, _E05_RUNNER)

    records = _e04_records(run)
    assert [r["id"] for r in records] == ["runner"]
    assert records[0]["error"] == {"code": code, "stage": "prepare", "name": "RunnerFailure", "at": at}
    assert _e04_done(run)["incomplete"] is True


def test_e05_a_real_scenario_that_throws_fails_safely_and_closes_its_context():
    run = _e04_run("e05_real_scenario_throws", _E05_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["id"] == "add-geometry@2560" and rec["pass"] is False
    assert rec["error"] == {"code": "error", "stage": "add-geometry@2560", "name": "Error"}
    assert _e04_done(run)["incomplete"] is False
    _e04_closed_in_order(run)


@pytest.mark.parametrize("case", ["route_fails_live", "scenario_reports_the_token", "open_outside_a_scenario"])
def test_e05_keeps_the_e04_guards(case):
    run = _e04_run(case, _E05_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["pass"] is False
    if case != "scenario_reports_the_token":  # that one opens no context
        _e04_closed_in_order(run)


def test_e05_a_record_carrying_the_media_token_is_replaced_by_a_failure():
    run = _e04_run("scenario_reports_the_media_token", _E05_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["error"] == {"code": "secret_in_record", "stage": "echo"}
    assert "mq7-media-marker-fake" not in json.dumps(run["posts"])


def test_e05_the_runner_declares_exactly_the_scenarios_the_manifest_expects():
    run = _e04_run("declared", _E05_RUNNER)

    assert _e04_records(run) == []
    assert _e04_done(run)["declared"] == list(e05_evidence.DETAIL_SCENARIOS)


def test_e05_a_full_run_is_judged_against_the_e05_scenarios():
    ids = list(e05_evidence.DETAIL_SCENARIOS)
    done = {"count": len(ids), "incomplete": False, "declared": ids}
    records = [{"id": i} for i in ids]

    verdict = e04_evidence.run_completeness(
        finished=True, done=done, records=records, only="", expected=e05_evidence.DETAIL_SCENARIOS
    )
    assert verdict["complete"] is True
    # E4's list is not E5's: judged against it, the same run is not complete.
    assert e04_evidence.run_completeness(finished=True, done=done, records=records, only="")["complete"] is False


def test_the_e05_boundary_pairs_straddle_the_plate_tabs_breakpoint_on_a_copy_of_the_plan():
    base = json.loads((Path(e05_evidence.HERE) / "capture_plan.json").read_text(encoding="utf-8"))

    plan, only, stage = e05_evidence.pairs_plan(base, boundary=True)
    assert only == ["e05-add-plate"] and stage.endswith("-pairs-boundary")
    assert plan["widths"] == {"wide": [1101, 1100], "narrow": []}
    assert plan["heights"]["1101"] == plan["heights"]["1100"] == 800
    # The E0 plan itself is untouched.
    assert 1101 not in base["widths"]["wide"] and "1101" not in base["heights"]

    plan, only, stage = e05_evidence.pairs_plan(base, boundary=False)
    assert only == [r["id"] for r in e05_evidence.e05_recipes()] and stage.endswith("-pairs")
    assert plan["widths"] == base["widths"]


def test_every_e05_pair_is_a_plain_recipe_on_both_sides():
    # F6: the mockup side takes no fixture; the app side's are validated GET rewrites.
    ids = []
    for recipe in e05_evidence.e05_recipes():
        ids.append(recipe["id"])
        kind, number = recipe["pair"].split(":")
        assert kind in ("order", "product"), recipe["id"]
        assert recipe["app"]["route"].startswith("/projects/{order:" if kind == "order" else "/products/{product:")
        assert capture_serve.side_rewrites("mockup", recipe["mockup"], str) == []
        capture_serve.side_rewrites("app", recipe["app"], str)
    assert ids == ["e05-add-products", "e05-add-parts", "e05-add-plate", "e05-config-241", "e05-product-to-order"]


def test_an_e05_pair_that_names_stand_rows_gets_them_tagged_as_the_tag_writer_would():
    # The stand's seeded library rows carry no `file_tags`; the pair answers the list with the
    # named rows, tagged by name and type, through a merge the E0 runner validates.
    row = {"id": 223, "filename": "cable_clip_set.gcode.3mf", "file_type": "gcode", "file_tags": []}
    asked = []

    def rows_for(names):
        asked.append(names)
        return [row]

    (plate,) = [r for r in e05_evidence.e05_recipes() if r["id"] == "e05-add-plate"]
    out = e05_evidence.with_stand_rows(plate, rows_for)

    assert asked == [["cable_clip_set.gcode.3mf"]]
    assert "stand_rows" not in out["app"]
    (rewrite,) = capture_serve.side_rewrites("app", out["app"], str)
    assert rewrite["path"] == "/api/v1/library/files"
    assert rewrite["merge"]["items"] == [{**row, "file_tags": ["gcode", "3mf"]}]
    assert rewrite["merge"]["meta"]["total"] == 1
    # A recipe without stand rows passes through untouched.
    (products,) = [r for r in e05_evidence.e05_recipes() if r["id"] == "e05-add-products"]
    assert e05_evidence.with_stand_rows(products, rows_for) == products
    assert len(asked) == 1


@pytest.mark.parametrize(
    ("name", "file_type", "tags"),
    [
        ("a.gcode.3mf", "gcode", ["gcode", "3mf"]),
        ("a.gcode", "gcode", ["gcode"]),
        ("a.3mf", "3mf", ["3mf", "project"]),
        ("a.stl", "stl", ["stl", "geometry"]),
        ("a.txt", "txt", []),
    ],
)
def test_the_e05_stand_row_tags_follow_the_tag_writers_name_rule(name, file_type, tags):
    from backend.app.services.library_helpers import compute_file_tags

    assert e05_evidence.format_tags(name, file_type) == tags
    written = compute_file_tags(
        filename=name, file_type=file_type, file_metadata={}, source_type=None, swap_compatible=False
    )
    assert [t for t in written if t in {"gcode", "3mf", "stl", "project", "geometry"}] == tags


def test_e05_the_edges_run_declares_its_own_scenarios():
    run = _e04_run("declared_edges", _E05_RUNNER)

    assert _e04_records(run) == []
    assert _e04_done(run)["declared"] == list(e05_evidence.EDGE_SCENARIOS)
    assert e05_evidence.expected_scenarios("edges") == e05_evidence.EDGE_SCENARIOS
    assert e05_evidence.expected_scenarios("baseline") == e05_evidence.DETAIL_SCENARIOS
    # The thumbnail is proven on the edges set; the baseline run no longer carries a pending one.
    assert "add-plate-thumbnail@1440" not in e05_evidence.DETAIL_SCENARIOS


def test_e05_an_edges_job_names_the_picture_files():
    mapping = {f"order:{n}": {"id": int(n)} for n in e05_evidence.ORDERS}
    mapping |= {f"product:{n}": {"id": int(n)} for n in e05_evidence.PRODUCTS}
    mapping |= {f"file:{name}": {"id": i} for i, name in enumerate(e05_evidence.FILES)}
    mapping |= {f"edge:file:{name}": {"id": 900 + i} for i, name in enumerate(e05_evidence.EDGE_FILES)}

    assert "edge_files" not in e05_evidence.job_entities(mapping)
    assert e05_evidence.job_entities(mapping, "edges")["edge_files"] == {
        "t1_picture_a.gcode.3mf": 900,
        "t1_picture_b.gcode.3mf": 901,
    }


def test_the_stand_seed_writes_a_real_plate_picture_and_says_so():
    """E5-V03: a seeded file with ``thumbnail`` carries a real PNG, and its metadata says the
    plate has a picture — the route then serves it from the 3MF like any uploaded file."""
    import io

    import seed_direct
    from PIL import Image

    image = Image.open(io.BytesIO(seed_direct.plate_png([42, 161, 152])))
    image.verify()
    assert image.size == (160, 120)

    spec = {
        "sliced": True,
        "model": "P1S",
        "plates": [{"index": 1, "minutes": 1, "grams": 1, "filaments": [], "objects": {"a": 1}}],
    }
    assert seed_direct._metadata({**spec, "thumbnail": [1, 2, 3]})["plates"][0]["has_thumbnail"] is True
    assert seed_direct._metadata(spec)["plates"][0]["has_thumbnail"] is False


# ---- WS-13 E6 detail runner (e06_detail.js): E4's harness around E6's scenarios ----

import e06_evidence  # noqa: E402

_E06_RUNNER = Path(__file__).resolve().parents[3] / "scripts" / "workshop_stand" / "e06_detail.js"


@pytest.mark.parametrize(
    ("case", "code", "at"),
    [
        ("prep_read_throws", "read_network", "/projects/1"),
        ("prep_read_refused", "read_http_401", "/groups/"),
    ],
)
def test_e06_a_failed_preparation_read_ends_the_run_incomplete_and_names_no_secret(case, code, at):
    run = _e04_run(case, _E06_RUNNER)

    records = _e04_records(run)
    assert [r["id"] for r in records] == ["runner"]
    assert records[0]["error"] == {"code": code, "stage": "prepare", "name": "RunnerFailure", "at": at}
    assert _e04_done(run)["incomplete"] is True


def test_e06_a_real_scenario_that_throws_fails_safely_and_closes_its_context():
    run = _e04_run("e06_real_scenario_throws", _E06_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["id"] == "form-geometry@1920" and rec["pass"] is False
    assert rec["error"] == {"code": "error", "stage": "form-geometry@1920", "name": "Error"}
    assert _e04_done(run)["incomplete"] is False
    _e04_closed_in_order(run)


@pytest.mark.parametrize("case", ["route_fails_live", "scenario_reports_the_token", "open_outside_a_scenario"])
def test_e06_keeps_the_e04_guards(case):
    run = _e04_run(case, _E06_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["pass"] is False
    if case != "scenario_reports_the_token":  # that one opens no context
        _e04_closed_in_order(run)


def test_e06_a_record_carrying_the_media_token_is_replaced_by_a_failure():
    run = _e04_run("scenario_reports_the_media_token", _E06_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["error"] == {"code": "secret_in_record", "stage": "echo"}
    assert "mq7-media-marker-fake" not in json.dumps(run["posts"])


def test_e06_a_get_is_answered_by_its_turn():
    """``gets``: the first read of the order fails, the second is the stand's answer rewritten —
    the refusal and re-read scenarios stand on it."""
    run = _e04_run("gets_by_turn", _E06_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["pass"] is True
    answered = [e for e in run["log"] if e.startswith("fulfill.")]
    assert answered == ['fulfill.500.{"detail":"e06 runner"}', 'fulfill.200.{"n":1,"seen":2}']
    _e04_closed_in_order(run)


def test_e06_the_runner_declares_exactly_the_scenarios_the_manifest_expects():
    run = _e04_run("declared", _E06_RUNNER)

    assert _e04_records(run) == []
    assert _e04_done(run)["declared"] == list(e06_evidence.DETAIL_SCENARIOS)


def test_e06_a_full_run_is_judged_against_the_e06_scenarios():
    ids = list(e06_evidence.DETAIL_SCENARIOS)
    done = {"count": len(ids), "incomplete": False, "declared": ids}
    records = [{"id": i} for i in ids]

    verdict = e04_evidence.run_completeness(
        finished=True, done=done, records=records, only="", expected=e06_evidence.DETAIL_SCENARIOS
    )
    assert verdict["complete"] is True
    assert (
        e04_evidence.run_completeness(
            finished=True, done=done, records=records, only="", expected=e05_evidence.DETAIL_SCENARIOS
        )["complete"]
        is False
    )


def test_the_e06_boundary_pairs_straddle_the_order_forms_breakpoint_on_a_copy_of_the_plan():
    base = json.loads((Path(e06_evidence.HERE) / "capture_plan.json").read_text(encoding="utf-8"))

    plan, only, stage = e06_evidence.pairs_plan(base, boundary=True)
    assert only == ["e06-order-new"] and stage.endswith("-pairs-boundary")
    assert plan["widths"] == {"wide": [761, 760], "narrow": []}
    assert plan["heights"]["761"] == plan["heights"]["760"] == 800
    # The E0 plan itself is untouched.
    assert 761 not in base["widths"]["wide"] and "761" not in base["heights"]

    plan, only, stage = e06_evidence.pairs_plan(base, boundary=False)
    assert only == [r["id"] for r in e06_evidence.e06_recipes()] and stage.endswith("-pairs")
    assert plan["widths"] == base["widths"]


def test_every_e06_pair_is_a_plain_recipe_on_both_sides():
    # F6: the mockup side takes no fixture; the app side takes none either — the forms and the
    # issue dialog are shot over the baseline as it is.
    ids = []
    for recipe in e06_evidence.e06_recipes():
        ids.append(recipe["id"])
        if "pair" in recipe:
            kind, number = recipe["pair"].split(":")
            assert kind == "order" and number in e06_evidence.ORDERS, recipe["id"]
            assert recipe["app"]["route"] == f"/projects/{{order:{number}}}"
        assert capture_serve.side_rewrites("mockup", recipe["mockup"], str) == []
        assert capture_serve.side_rewrites("app", recipe["app"], str) == []
    assert ids == [
        "e06-order-new",
        "e06-order-edit",
        "e06-order-duplicate",
        "e06-order-menu",
        "e06-order-cancel",
        "e06-fulfilment-241",
        "e06-fulfilment-244",
        "e06-fulfilment-251",
    ]


def test_an_e06_job_names_the_orders_the_note_and_the_e0_mockup():
    mapping = {f"order:{n}": {"id": int(n) - 200} for n in e06_evidence.ORDERS}
    mapping |= {"doc:90000": {"id": 7}}
    base = json.loads((Path(e06_evidence.HERE) / "capture_plan.json").read_text(encoding="utf-8"))

    entities = e06_evidence.job_entities(mapping)
    assert entities["orders"]["251"] == 51 and entities["docs"] == {"90000": 7}
    mockup = e06_evidence.mockup_job(base)
    assert mockup["mockup"] == capture_serve.MOCKUP.as_uri()
    assert mockup["mockup_pref_key"] == capture_serve.MOCKUP_PREF_KEY
    assert json.loads(mockup["mockup_pref"]) == {"theme": base["theme"]["mockup"]}


def test_the_f26_pair_becomes_e0_manifest_rows_for_the_composites(tmp_path, monkeypatch):
    monkeypatch.setattr(stand, "REPO", tmp_path)
    shot = tmp_path / "temp" / "m.png"
    shot.parent.mkdir(parents=True)
    shot.write_bytes(b"png")
    records = [
        {"id": "f26-pair@390", "pass": True, "pair": {"mockup": [str(shot)], "app": [str(tmp_path / "gone.png")]}},
        {"id": "dup@390", "pass": True},
    ]

    rows = e06_evidence.pair_rows(records)
    assert [(r["recipe"], r["side"], r["width"], r["scenario"]) for r in rows] == [
        ("e06-dispatch-note-window", "mockup", 390, "f26-pair@390"),
        ("e06-dispatch-note-window", "app", 390, "f26-pair@390"),
    ]
    assert rows[0]["frames"][0]["file"] == "temp/m.png" and rows[0]["frames"][0]["sha256"]
    # A picture that is not on disk is kept, named, with no hash.
    assert rows[1]["frames"][0]["sha256"] is None


# ---- WS-13 E7 detail runner (e07_detail.js): E4's harness around E7's scenarios ----

import e07_evidence  # noqa: E402

_E07_RUNNER = Path(__file__).resolve().parents[3] / "scripts" / "workshop_stand" / "e07_detail.js"


@pytest.mark.parametrize(
    ("case", "code", "at"),
    [
        ("prep_read_throws", "read_network", "/projects/1"),
        ("prep_read_refused", "read_http_401", "/groups/"),
    ],
)
def test_e07_a_failed_preparation_read_ends_the_run_incomplete_and_names_no_secret(case, code, at):
    run = _e04_run(case, _E07_RUNNER)

    records = _e04_records(run)
    assert [r["id"] for r in records] == ["runner"]
    assert records[0]["error"] == {"code": code, "stage": "prepare", "name": "RunnerFailure", "at": at}
    assert _e04_done(run)["incomplete"] is True


def test_e07_a_real_scenario_that_throws_fails_safely_and_closes_its_context():
    run = _e04_run("e07_real_scenario_throws", _E07_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["id"] == "tiles@1440" and rec["pass"] is False
    assert rec["error"] == {"code": "error", "stage": "tiles@1440", "name": "Error"}
    assert _e04_done(run)["incomplete"] is False
    _e04_closed_in_order(run)


@pytest.mark.parametrize("case", ["route_fails_live", "scenario_reports_the_token", "open_outside_a_scenario"])
def test_e07_keeps_the_e04_guards(case):
    run = _e04_run(case, _E07_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["pass"] is False
    if case != "scenario_reports_the_token":  # that one opens no context
        _e04_closed_in_order(run)


def test_e07_a_record_carrying_the_media_token_is_replaced_by_a_failure():
    run = _e04_run("scenario_reports_the_media_token", _E07_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["error"] == {"code": "secret_in_record", "stage": "echo"}
    assert "mq7-media-marker-fake" not in json.dumps(run["posts"])


def test_e07_a_get_is_answered_by_its_turn():
    run = _e04_run("gets_by_turn", _E07_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["pass"] is True
    answered = [e for e in run["log"] if e.startswith("fulfill.")]
    assert answered == ['fulfill.500.{"detail":"e07 runner"}', 'fulfill.200.{"n":1,"seen":2}']
    _e04_closed_in_order(run)


def test_e07_the_runner_declares_exactly_the_scenarios_the_manifest_expects():
    run = _e04_run("declared", _E07_RUNNER)

    assert _e04_records(run) == []
    assert _e04_done(run)["declared"] == list(e07_evidence.DETAIL_SCENARIOS)


def test_e07_a_full_run_is_judged_against_the_e07_scenarios():
    ids = list(e07_evidence.DETAIL_SCENARIOS)
    done = {"count": len(ids), "incomplete": False, "declared": ids}
    records = [{"id": i} for i in ids]

    verdict = e04_evidence.run_completeness(
        finished=True, done=done, records=records, only="", expected=e07_evidence.DETAIL_SCENARIOS
    )
    assert verdict["complete"] is True
    assert (
        e04_evidence.run_completeness(
            finished=True, done=done, records=records, only="", expected=e06_evidence.DETAIL_SCENARIOS
        )["complete"]
        is False
    )


def test_the_e07_pairs_shoot_the_order_lists_at_the_spec_widths_on_a_copy_of_the_plan():
    base = json.loads((Path(e07_evidence.HERE) / "capture_plan.json").read_text(encoding="utf-8"))

    plan, only, stage = e07_evidence.pairs_plan(base, boundary=False)
    assert stage.endswith("-pairs")
    assert only == [*e07_evidence.E0_SURFACES, *(r["id"] for r in e07_evidence.e07_recipes())]
    assert plan["widths"] == {"wide": [2560, 1920, 1440, 1280, 1024, 768], "narrow": [390]}
    assert {"2560", "1280", "768"} <= set(plan["heights"])
    # Every surface the run names exists in the copy.
    assert set(only) <= {s["id"] for s in plan["surfaces"]}

    plan, only, stage = e07_evidence.pairs_plan(base, boundary=True)
    assert only == ["orders-table", "orders-workspace"] and stage.endswith("-pairs-boundary")
    assert plan["widths"] == {"wide": [1101, 1100, 761, 760, 561, 560], "narrow": []}
    assert all(plan["heights"][str(w)] == 800 for w in (1101, 1100, 761, 760, 561, 560))
    # The E0 plan itself is untouched.
    assert 2560 not in base["widths"]["wide"] and "1101" not in base["heights"]


def test_every_e07_pair_is_a_plain_recipe_on_both_sides():
    ids = []
    for recipe in e07_evidence.e07_recipes():
        ids.append(recipe["id"])
        assert capture_serve.side_rewrites("mockup", recipe["mockup"], str) == []
        assert capture_serve.side_rewrites("app", recipe["app"], str) == []
    assert ids == ["e07-orders-row-menu", "e07-orders-board-menu"]


def test_an_e07_job_names_the_orders_and_the_customer():
    mapping = {f"order:{n}": {"id": int(n) - 210} for n in e07_evidence.ORDERS}
    mapping |= {"customer:1": {"id": 4}}

    entities = e07_evidence.job_entities(mapping)
    assert entities["orders"]["241"] == 31 and entities["orders"]["251"] == 41
    assert entities["customers"] == {"1": 4}


# ---- WS-13 E8 detail runner (e08_detail.js): E4's harness around E8's scenarios ----

import struct  # noqa: E402
import zlib  # noqa: E402

import e08_evidence  # noqa: E402

_E08_RUNNER = Path(__file__).resolve().parents[3] / "scripts" / "workshop_stand" / "e08_detail.js"


@pytest.mark.parametrize(
    ("case", "code", "at"),
    [
        ("e08_prep_read_throws", "read_network", "/products/1"),
        ("prep_read_refused", "read_http_401", "/groups/"),
    ],
)
def test_e08_a_failed_preparation_read_ends_the_run_incomplete_and_names_no_secret(case, code, at):
    run = _e04_run(case, _E08_RUNNER)

    records = _e04_records(run)
    assert [r["id"] for r in records] == ["runner"]
    assert records[0]["error"] == {"code": code, "stage": "prepare", "name": "RunnerFailure", "at": at}
    assert _e04_done(run)["incomplete"] is True


def test_e08_a_real_scenario_that_throws_fails_safely_and_closes_its_context():
    run = _e04_run("e08_real_scenario_throws", _E08_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["id"] == "header@1440" and rec["pass"] is False
    assert rec["error"] == {"code": "error", "stage": "header@1440", "name": "Error"}
    assert _e04_done(run)["incomplete"] is False
    _e04_closed_in_order(run)


@pytest.mark.parametrize("case", ["route_fails_live", "scenario_reports_the_token", "open_outside_a_scenario"])
def test_e08_keeps_the_e04_guards(case):
    run = _e04_run(case, _E08_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["pass"] is False
    if case != "scenario_reports_the_token":  # that one opens no context
        _e04_closed_in_order(run)


def test_e08_a_record_carrying_the_media_token_is_replaced_by_a_failure():
    run = _e04_run("scenario_reports_the_media_token", _E08_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["error"] == {"code": "secret_in_record", "stage": "echo"}
    assert "mq7-media-marker-fake" not in json.dumps(run["posts"])


def test_e08_a_get_is_answered_by_its_turn():
    run = _e04_run("gets_by_turn", _E08_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["pass"] is True
    answered = [e for e in run["log"] if e.startswith("fulfill.")]
    assert answered == ['fulfill.500.{"detail":"e08 runner"}', 'fulfill.200.{"n":1,"seen":2}']
    _e04_closed_in_order(run)


def test_e08_the_runner_declares_exactly_the_scenarios_the_manifest_expects():
    run = _e04_run("declared", _E08_RUNNER)

    assert _e04_records(run) == []
    assert _e04_done(run)["declared"] == list(e08_evidence.DETAIL_SCENARIOS)


def test_e08_a_full_run_is_judged_against_the_e08_scenarios():
    ids = list(e08_evidence.DETAIL_SCENARIOS)
    done = {"count": len(ids), "incomplete": False, "declared": ids}
    records = [{"id": i} for i in ids]

    verdict = e04_evidence.run_completeness(
        finished=True, done=done, records=records, only="", expected=e08_evidence.DETAIL_SCENARIOS
    )
    assert verdict["complete"] is True
    assert (
        e04_evidence.run_completeness(
            finished=True, done=done, records=records, only="", expected=e07_evidence.DETAIL_SCENARIOS
        )["complete"]
        is False
    )


def test_the_e08_pairs_shoot_each_width_set_as_its_own_run_on_a_copy_of_the_plan():
    base = json.loads((Path(e08_evidence.HERE) / "capture_plan.json").read_text(encoding="utf-8"))
    surfaces = {s["id"] for s in base["surfaces"]}

    plan, only, stage = e08_evidence.pairs_plan(base, run="")
    assert only == ["products-table"] and stage == "e08-product-catalog-pairs"
    assert plan["widths"] == {"wide": [2560, 1920, 1440, 1280, 1024, 768], "narrow": [390]}
    # The table takes the narrow width in the copy (the E0 plan shot it wide only).
    assert next(s for s in plan["surfaces"] if s["id"] == "products-table")["widths"] == "all"

    plan, only, stage = e08_evidence.pairs_plan(base, run="cards")
    assert only == ["products-cards"] and stage.endswith("-pairs-cards")
    assert plan["widths"] == {"wide": [1920, 1440, 1024], "narrow": [390]}

    plan, only, stage = e08_evidence.pairs_plan(base, run="menus")
    assert only == ["e08-products-row-menu", "e08-products-card-menu"] and stage.endswith("-pairs-menus")
    assert plan["widths"] == {"wide": [1440], "narrow": [390]}
    assert set(only) <= {s["id"] for s in plan["surfaces"]}

    plan, only, stage = e08_evidence.pairs_plan(base, run="boundary")
    assert only == ["products-table", "products-cards"] and stage.endswith("-pairs-boundary")
    assert plan["widths"] == {"wide": [1101, 1100, 761, 760], "narrow": []}
    assert all(plan["heights"][str(w)] == 800 for w in (1101, 1100, 761, 760))
    # Every height the runs need exists, and the E0 plan itself is untouched.
    for run in e08_evidence.RUNS:
        plan, _only, _stage = e08_evidence.pairs_plan(base, run=run)
        assert all(str(w) in plan["heights"] for w in (*plan["widths"]["wide"], *plan["widths"]["narrow"]))
    assert {s["id"] for s in base["surfaces"]} == surfaces and "1101" not in base["heights"]
    assert next(s for s in base["surfaces"] if s["id"] == "products-table")["widths"] == "wide"


def test_every_e08_pair_is_a_plain_recipe_on_both_sides():
    ids = []
    for recipe in e08_evidence.e08_recipes():
        ids.append(recipe["id"])
        assert capture_serve.side_rewrites("mockup", recipe["mockup"], str) == []
        assert capture_serve.side_rewrites("app", recipe["app"], str) == []
    assert ids == ["e08-products-row-menu", "e08-products-card-menu"]


def test_an_e08_job_names_the_products():
    mapping = {f"product:{n}": {"id": int(n) + 1000} for n in e08_evidence.PRODUCTS}

    entities = e08_evidence.job_entities(mapping)
    assert entities == {"products": {n: int(n) + 1000 for n in e08_evidence.PRODUCTS}}


def test_the_e08_cover_fixture_is_a_real_png_of_its_size(tmp_path):
    path = e08_evidence.fixture_png(tmp_path / "cover.png", (12, 8))

    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    width, height = struct.unpack(">II", data[16:24])
    assert (width, height) == (12, 8)
    # The picture decompresses to one filter byte and 12 RGB pixels per row.
    idat = data[data.index(b"IDAT") + 4 : data.index(b"IEND") - 8]
    assert len(zlib.decompress(idat)) == 8 * (1 + 12 * 3)


# ---- WS-13 E9 detail runner (e09_detail.js): E4's harness around E9's scenarios ----

import e09_evidence  # noqa: E402

_E09_RUNNER = Path(__file__).resolve().parents[3] / "scripts" / "workshop_stand" / "e09_detail.js"


@pytest.mark.parametrize(
    ("case", "code", "at"),
    [
        ("e09_prep_read_throws", "read_network", "/products/1"),
        ("prep_read_refused", "read_http_401", "/groups/"),
    ],
)
def test_e09_a_failed_preparation_read_ends_the_run_incomplete_and_names_no_secret(case, code, at):
    run = _e04_run(case, _E09_RUNNER)

    records = _e04_records(run)
    assert [r["id"] for r in records] == ["runner"]
    assert records[0]["error"] == {"code": code, "stage": "prepare", "name": "RunnerFailure", "at": at}
    assert _e04_done(run)["incomplete"] is True


def test_e09_a_real_scenario_that_throws_fails_safely_and_closes_its_context():
    run = _e04_run("e09_real_scenario_throws", _E09_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["id"] == "header@1440" and rec["pass"] is False
    assert rec["error"] == {"code": "error", "stage": "header@1440", "name": "Error"}
    assert _e04_done(run)["incomplete"] is False
    _e04_closed_in_order(run)


@pytest.mark.parametrize("case", ["route_fails_live", "scenario_reports_the_token", "open_outside_a_scenario"])
def test_e09_keeps_the_e04_guards(case):
    run = _e04_run(case, _E09_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["pass"] is False
    if case != "scenario_reports_the_token":  # that one opens no context
        _e04_closed_in_order(run)


def test_e09_a_record_carrying_the_media_token_is_replaced_by_a_failure():
    run = _e04_run("scenario_reports_the_media_token", _E09_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["error"] == {"code": "secret_in_record", "stage": "echo"}
    assert "mq7-media-marker-fake" not in json.dumps(run["posts"])


def test_e09_a_get_is_answered_by_its_turn():
    run = _e04_run("gets_by_turn", _E09_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["pass"] is True
    answered = [e for e in run["log"] if e.startswith("fulfill.")]
    assert answered == ['fulfill.500.{"detail":"e09 runner"}', 'fulfill.200.{"n":1,"seen":2}']
    _e04_closed_in_order(run)


def test_e09_the_runner_declares_exactly_the_scenarios_the_manifest_expects():
    run = _e04_run("declared", _E09_RUNNER)

    assert _e04_records(run) == []
    assert _e04_done(run)["declared"] == list(e09_evidence.DETAIL_SCENARIOS)


def test_e09_a_full_run_is_judged_against_the_e09_scenarios():
    ids = list(e09_evidence.DETAIL_SCENARIOS)
    done = {"count": len(ids), "incomplete": False, "declared": ids}
    records = [{"id": i} for i in ids]

    verdict = e04_evidence.run_completeness(
        finished=True, done=done, records=records, only="", expected=e09_evidence.DETAIL_SCENARIOS
    )
    assert verdict["complete"] is True
    assert (
        e04_evidence.run_completeness(
            finished=True, done=done, records=records, only="", expected=e08_evidence.DETAIL_SCENARIOS
        )["complete"]
        is False
    )


def test_the_e09_pairs_open_each_tab_by_address_on_a_copy_of_the_plan():
    base = json.loads((Path(e09_evidence.HERE) / "capture_plan.json").read_text(encoding="utf-8"))
    surfaces = {s["id"]: s for s in base["surfaces"]}

    plan, only, stage = e09_evidence.pairs_plan(base, run="")
    assert stage == "e09-product-page-pairs"
    assert only == list(e09_evidence.TABS)
    assert plan["widths"] == {"wide": [1920, 1440, 1024], "narrow": [390]}
    copied = {s["id"]: s for s in plan["surfaces"]}
    for sid, tab in e09_evidence.TABS.items():
        # The app opens the tab through the page's address; the mockup still clicks it.
        assert "missing" not in copied[sid]["app"] and "reuse" not in copied[sid]["app"]
        assert copied[sid]["app"]["route"] == "/products/{product:1}" + ("" if tab == "composition" else f"?tab={tab}")
        assert copied[sid]["mockup"] == surfaces[sid]["mockup"]
        assert copied[sid]["widths"] == "all"

    plan, only, stage = e09_evidence.pairs_plan(base, run="boundary")
    assert only == ["product-detail-composition"] and stage.endswith("-pairs-boundary")
    assert plan["widths"] == {"wide": [1101, 1100, 761, 760], "narrow": []}
    assert all(plan["heights"][str(w)] == 800 for w in (1101, 1100, 761, 760))

    plan, only, stage = e09_evidence.pairs_plan(base, run="menus")
    assert only == ["e09-product-menu"] and stage.endswith("-pairs-menus")
    assert set(only) <= {s["id"] for s in plan["surfaces"]}

    for run in e09_evidence.RUNS:
        plan, _only, _stage = e09_evidence.pairs_plan(base, run=run)
        assert all(str(w) in plan["heights"] for w in (*plan["widths"]["wide"], *plan["widths"]["narrow"]))
    # The E0 plan itself is untouched.
    assert all("missing" in surfaces[sid]["app"] for sid in e09_evidence.TABS)


def test_every_e09_pair_is_a_plain_recipe_on_both_sides():
    ids = []
    for recipe in e09_evidence.e09_recipes():
        ids.append(recipe["id"])
        assert capture_serve.side_rewrites("mockup", recipe["mockup"], str) == []
        assert capture_serve.side_rewrites("app", recipe["app"], str) == []
    assert ids == ["e09-product-menu"]


# ---- WS-13 E10 editors runner (e10_editors.js): E4's harness around E10's scenarios ----

import e10_evidence  # noqa: E402

_E10_RUNNER = Path(__file__).resolve().parents[3] / "scripts" / "workshop_stand" / "e10_editors.js"


@pytest.mark.parametrize(
    ("case", "code", "at"),
    [
        ("e10_prep_read_throws", "read_network", "/products/1"),
    ],
)
def test_e10_a_failed_preparation_read_ends_the_run_incomplete_and_names_no_secret(case, code, at):
    run = _e04_run(case, _E10_RUNNER)

    records = _e04_records(run)
    assert [r["id"] for r in records] == ["runner"]
    assert records[0]["error"] == {"code": code, "stage": "prepare", "name": "RunnerFailure", "at": at}
    assert _e04_done(run)["incomplete"] is True


def test_e10_a_real_scenario_that_throws_fails_safely_and_closes_its_context():
    run = _e04_run("e10_real_scenario_throws", _E10_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["id"] == "form@1440" and rec["pass"] is False
    assert rec["error"] == {"code": "error", "stage": "form@1440", "name": "Error"}
    assert _e04_done(run)["incomplete"] is False
    _e04_closed_in_order(run)


@pytest.mark.parametrize("case", ["route_fails_live", "scenario_reports_the_token", "open_outside_a_scenario"])
def test_e10_keeps_the_e04_guards(case):
    run = _e04_run(case, _E10_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["pass"] is False
    if case != "scenario_reports_the_token":  # that one opens no context
        _e04_closed_in_order(run)


def test_e10_a_record_carrying_the_media_token_is_replaced_by_a_failure():
    run = _e04_run("scenario_reports_the_media_token", _E10_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["error"] == {"code": "secret_in_record", "stage": "echo"}
    assert "mq7-media-marker-fake" not in json.dumps(run["posts"])


def test_e10_a_get_is_answered_by_its_turn():
    run = _e04_run("gets_by_turn", _E10_RUNNER)

    (rec,) = _e04_records(run)
    assert rec["pass"] is True
    answered = [e for e in run["log"] if e.startswith("fulfill.")]
    assert answered == ['fulfill.500.{"detail":"e10 runner"}', 'fulfill.200.{"n":1,"seen":2}']
    _e04_closed_in_order(run)


def test_e10_the_runner_declares_exactly_the_scenarios_the_manifest_expects():
    run = _e04_run("declared", _E10_RUNNER)

    assert _e04_records(run) == []
    assert _e04_done(run)["declared"] == list(e10_evidence.DETAIL_SCENARIOS)


def test_e10_a_full_run_is_judged_against_the_e10_scenarios():
    ids = list(e10_evidence.DETAIL_SCENARIOS)
    done = {"count": len(ids), "incomplete": False, "declared": ids}
    records = [{"id": i} for i in ids]

    verdict = e04_evidence.run_completeness(
        finished=True, done=done, records=records, only="", expected=e10_evidence.DETAIL_SCENARIOS
    )
    assert verdict["complete"] is True
    assert (
        e04_evidence.run_completeness(
            finished=True, done=done, records=records, only="", expected=e09_evidence.DETAIL_SCENARIOS
        )["complete"]
        is False
    )


def test_the_e10_pairs_add_the_ten_dialogs_at_1440_and_390_on_a_copy_of_the_plan():
    base = json.loads((Path(e10_evidence.HERE) / "capture_plan.json").read_text(encoding="utf-8"))
    before = json.dumps(base, sort_keys=True)

    plan, only, stage = e10_evidence.pairs_plan(base, run="")
    assert stage == "e10-product-editors-pairs"
    assert plan["widths"] == {"wide": [1440], "narrow": [390]}
    assert only == [r["id"] for r in e10_evidence.e10_recipes()]
    assert set(only) <= {s["id"] for s in plan["surfaces"]}
    assert all(str(w) in plan["heights"] for w in (1440, 390))
    # The E0 plan itself is untouched.
    assert json.dumps(base, sort_keys=True) == before


def test_every_e10_pair_is_a_dialog_and_a_plain_recipe_on_both_sides():
    ids = []
    for recipe in e10_evidence.e10_recipes():
        ids.append(recipe["id"])
        assert recipe["measure"] == "dialog"
        assert capture_serve.side_rewrites("mockup", recipe["mockup"], str) == []
        assert capture_serve.side_rewrites("app", recipe["app"], str) == []
    assert ids == [
        "e10-product-new",
        "e10-product-edit",
        "e10-part-new",
        "e10-part-edit-printed",
        "e10-part-edit-purchased",
        "e10-variants",
        "e10-from-file",
        "e10-import",
        "e10-reread",
        "e10-adjust",
    ]


def test_an_e10_job_names_the_products():
    mapping = {"product:1": {"id": 11}, "product:8": {"id": 18}, "product:900": {"id": 19}}

    assert e10_evidence.job_entities(mapping) == {"products": {"1": 11, "8": 18}}
