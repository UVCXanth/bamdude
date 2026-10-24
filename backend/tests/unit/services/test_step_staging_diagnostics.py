"""Why the CAD installer kept a staging, in one closed log event (STEP ownership spec S-R6, S08–S12).

A reclaim (install) or a prune that keeps a staging because its writer's end is not proven says so once per
staging and call: the outer reason ``_writer_may_live`` gave, the inner reason of the token proof it ran (or
``not_checked``), how many holders that very proof ended, and how long it took — closed codes and numbers only,
never a path, a token, a user, a command line or an exception's text. The standalone helper writes it to stderr
(stdout's JSON and the exit code stay as they were); the app's owned run relays exactly that event, and nothing
else of the child's stderr, to the parent log. The log never changes what is kept, killed or removed.
"""

from __future__ import annotations

import ast
import inspect
import json
import logging
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import psutil
import pytest

from backend.app import step_runtime as sr
from backend.app.services import part_render_tree as tree, step_runtime_child as child
from backend.tests.unit.services.test_step_runtime_install import WIN312, catalog_copy, installed
from backend.tests.unit.services.test_step_runtime_ownership import (
    _launch,
    _own_record,
    _OwnTree,
    _row,
    _staging,
    _unreadable_scans,
    _UnreadableRow,
)

LOGGER = "backend.app.step_runtime"
REPO = Path(sr.__file__).resolve().parents[2]


def _events(caplog) -> list[dict]:
    """The staging events the CAD helper's logger wrote, decoded by the parent's own parser."""
    found = []
    for record in caplog.records:
        if record.name == LOGGER:
            event = sr.parse_staging_kept(record.getMessage())
            assert event is not None, f"a step_runtime log line that is no closed event: {record.getMessage()!r}"
            found.append(event)
    return found


def _kept_by_a_live_owner(tmp_path: Path, name: str = "attempt") -> Path:
    staging = _staging(tmp_path, name)
    tree.launch(staging, sr.INSTALLER)
    _own_record(staging / sr.OWNER_RECORD)  # this very process: the owner may still run
    return staging


# --- S08: one event per kept staging and call; a reclaimed one gives none -----------------------------------------


def test_a_kept_staging_gives_one_event_per_reclaim_and_a_reclaimed_one_none(tmp_path, caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    kept = _kept_by_a_live_owner(tmp_path, "kept")
    gone = _staging(tmp_path, "gone")
    _own_record(gone / sr.OWNER_RECORD, pid=2**22 + 7, create_time=1.0)  # never launched: reclaimed
    sr._reclaim_staging(kept.parent)
    assert kept.exists() and not gone.exists()
    [event] = _events(caplog)
    assert event == {
        "v": 1,
        "op": "reclaim",
        "outer": "owner_may_live",
        "inner": "not_checked",
        "ended": 0,
        "elapsed_ms": event["elapsed_ms"],
    }
    sr._reclaim_staging(kept.parent)  # another call reports it again: no state outside the call
    assert len(_events(caplog)) == 2


def test_a_reclaim_that_removes_everything_says_nothing(tmp_path, caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    staging = _staging(tmp_path)
    _own_record(staging / sr.OWNER_RECORD, pid=2**22 + 7, create_time=1.0)
    sr._reclaim_staging(staging.parent)
    assert not staging.exists() and _events(caplog) == []


def test_a_prune_reports_the_staging_it_keeps(install_tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    monkeypatch.setattr(sr, "interpreter_tags", lambda: WIN312)
    data = catalog_copy(install_tmp_path / "data")
    app = install_tmp_path / "app"
    installed(app, data)
    staging = sr.bundle_root(app) / ".staging" / "win-x64-cp312"
    dead, live = staging / ("a" * 32), staging / ("b" * 32)
    dead.mkdir(parents=True)
    live.mkdir(parents=True)
    tree.record(live / sr.OWNER_RECORD, os.getpid())
    tree.launch(live, sr.INSTALLER)
    assert sr.prune(app, data_dir=data) == {"ok": True, "removed": 1, "kept": {"writer_may_live": 1}}
    [event] = _events(caplog)
    assert (event["op"], event["outer"], event["inner"]) == ("prune", "owner_may_live", "not_checked")


# --- S09: the codes say what THAT proof found, and no second scan is made to explain it ----------------------------


class _Scans:
    def __init__(self, monkeypatch):
        self.holders = self.proofs = 0
        real_holders, real_end = tree._holders_why, tree._end_why

        def holders(*args, **kwargs):
            self.holders += 1
            return real_holders(*args, **kwargs)

        def end(*args, **kwargs):
            self.proofs += 1
            return real_end(*args, **kwargs)

        monkeypatch.setattr(tree, "_holders_why", holders)
        monkeypatch.setattr(tree, "_end_why", end)


def test_an_unread_scan_is_reported_with_its_inner_reason_and_nothing_ended(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    staging, token = _launch(tmp_path)
    with _OwnTree(token) as own:
        own.ready()
        _unreadable_scans(monkeypatch, _row(None), scans=None)
        scans = _Scans(monkeypatch)
        sr._reclaim_staging(staging.parent)
        assert staging.exists() and own.alive() == sorted(own.known)
        [event] = _events(caplog)
        assert (event["outer"], event["inner"], event["ended"]) == (
            "bootstrap_unreleased_unproven",
            "holder_unreadable",
            0,
        )
        assert (scans.proofs, scans.holders) == (1, 1)  # the proof that decided, never a second look


def test_holders_ended_before_a_later_round_failed_are_counted(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    staging, token = _launch(tmp_path)
    with _OwnTree(token) as own:
        own.ready()
        real = psutil.process_iter
        seen = [0]

        def second_scan_unreadable(*args, **kwargs):  # round 1 reads and kills; round 2 cannot read
            seen[0] += 1
            yield from real(*args, **kwargs)
            if seen[0] >= 2:
                yield _UnreadableRow(_row(None))

        monkeypatch.setattr(psutil, "process_iter", second_scan_unreadable)
        answers = []
        real_end = tree._end_why
        monkeypatch.setattr(tree, "_end_why", lambda *a, **k: answers.append(real_end(*a, **k)) or answers[-1])
        sr._reclaim_staging(staging.parent)
        assert staging.exists() and not own.alive()
        [event] = _events(caplog)
        # What THIS proof ended itself: a Windows venv interpreter goes with its launcher, uncounted.
        [(why, ended)] = answers
        assert why == "a possible holder unreadable" and 1 <= ended <= len(own.known)
        assert (event["inner"], event["ended"]) == ("holder_unreadable", ended)


def test_a_live_owner_is_reported_before_any_token_proof(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    staging = _kept_by_a_live_owner(tmp_path)
    scans = _Scans(monkeypatch)
    sr._reclaim_staging(staging.parent)
    [event] = _events(caplog)
    assert (event["outer"], event["inner"], event["ended"]) == ("owner_may_live", "not_checked", 0)
    assert scans.proofs == 0


def test_a_kill_side_failure_is_reported_as_itself(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    staging, token = _launch(tmp_path)
    with _OwnTree(token) as own:
        own.ready()
        monkeypatch.setattr(tree, "_wait", lambda process, timeout: False)
        scans = _Scans(monkeypatch)
        sr._reclaim_staging(staging.parent)
        [event] = _events(caplog)
        assert (event["outer"], event["inner"], event["ended"]) == (
            "bootstrap_unreleased_unproven",
            "holder_survived_kill",
            0,
        )
        assert scans.proofs == 1


def _returned_reasons(function) -> list[str]:
    """Every reason a function can return, as its literal text or the literal head of its f-string."""
    found = []
    for node in ast.walk(ast.parse(textwrap.dedent(inspect.getsource(function)))):
        if not isinstance(node, ast.Return) or node.value is None:
            continue
        values = node.value.elts if isinstance(node.value, ast.Tuple) else [node.value]
        for value in values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                found.append(value.value)
            elif isinstance(value, ast.JoinedStr) and isinstance(value.values[0], ast.Constant):
                found.append(value.values[0].value)
    return found


def test_every_reason_the_proof_can_give_has_its_own_code():
    outer = _returned_reasons(sr._writer_may_live)
    inner = _returned_reasons(tree._end_why) + _returned_reasons(tree._holders_why)
    assert len(outer) >= 9 and len(inner) >= 6
    assert [r for r in outer if sr.staging_reason_code(r, sr.OUTER_CODES) == "unknown_reason"] == []
    assert [r for r in inner if sr.staging_reason_code(r, sr.INNER_CODES) == "unknown_reason"] == []


# --- S10: closed codes only, in the child and in the parent -------------------------------------------------------


def test_nothing_secret_reaches_the_log(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    staging, token = _launch(tmp_path / "SECRET-PATH-7f3a")
    user = tree._identity(psutil.Process())
    monkeypatch.setattr(sr, "_writer_may_live", lambda path, **kwargs: f"owner pid=4242 cmd=--bamdude-launch={token}")
    sr._reclaim_staging(staging.parent)
    monkeypatch.setattr(sr, "_writer_may_live", lambda path, **kwargs: "SECRET-REASON boom: C:\\secret\\path")
    sr._reclaim_staging(staging.parent)
    text = "\n".join(r.getMessage() for r in caplog.records)
    assert [e["outer"] for e in _events(caplog)] == ["owner_may_live", "unknown_reason"]
    for secret in ("SECRET", token, str(staging), "4242", "launch=", "boom"):
        assert secret not in text
    if user:
        assert str(user) not in text


@pytest.mark.parametrize(
    "line",
    [
        "bamdude-step-staging-kept not json SECRET",
        'bamdude-step-staging-kept {"v":1,"op":"reclaim","outer":"owner_may_live","inner":"not_checked","ended":0}',
        'bamdude-step-staging-kept {"v":1,"op":"reclaim","outer":"SECRET","inner":"not_checked","ended":0,"elapsed_ms":1}',
        'bamdude-step-staging-kept {"v":1,"op":"SECRET","outer":"owner_may_live","inner":"not_checked","ended":0,'
        '"elapsed_ms":1}',
        'bamdude-step-staging-kept {"v":1,"op":"reclaim","outer":"owner_may_live","inner":"not_checked","ended":true,'
        '"elapsed_ms":1}',
        'bamdude-step-staging-kept {"v":1,"op":"reclaim","outer":"owner_may_live","inner":"not_checked","ended":-1,'
        '"elapsed_ms":1}',
        'bamdude-step-staging-kept {"v":2,"op":"reclaim","outer":"owner_may_live","inner":"not_checked","ended":0,'
        '"elapsed_ms":1}',
        'bamdude-step-staging-kept {"v":1,"op":"reclaim","outer":"owner_may_live","inner":"not_checked","ended":0,'
        '"elapsed_ms":1,"path":"SECRET"}',
        'x bamdude-step-staging-kept {"v":1,"op":"reclaim","outer":"owner_may_live","inner":"not_checked","ended":0,'
        '"elapsed_ms":1}',
    ],
    ids=[
        "not-json",
        "a-key-missing",
        "unknown-outer",
        "unknown-op",
        "bool",
        "negative",
        "version",
        "extra-key",
        "not-at-the-start",
    ],
)
def test_the_parent_relays_no_event_it_does_not_know_exactly(line, caplog):
    caplog.set_level(logging.DEBUG)
    assert sr.parse_staging_kept(line) is None
    child._relay_staging_events(f"Traceback SECRET-TRACE\n{line}\n", "CAD install", "run1")
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert "SECRET" not in caplog.text


def _with(field: str, value) -> str:
    """A valid event with one closed field replaced — the keys stay exactly the event's."""
    event = json.loads(sr.staging_kept_event("reclaim", "launch unreadable", None, 0.25).split(" ", 1)[1])
    event[field] = value
    return f"{sr.STAGING_KEPT} {json.dumps(event)}"


@pytest.mark.parametrize("field", ["op", "outer", "inner"])
@pytest.mark.parametrize("value", [[], {"SECRET": 1}, 7, None, True], ids=["list", "object", "number", "null", "bool"])
def test_a_code_of_another_json_type_is_no_event_and_the_next_one_still_counts(field, value, caplog):
    """Codex review ST-R1: the parser is total over JSON's own types, so a damaged line never ends the reading
    of the lines after it."""
    caplog.set_level(logging.DEBUG)
    damaged = _with(field, value)
    assert sr.parse_staging_kept(damaged) is None
    valid = sr.staging_kept_event("prune", "launch unreadable", None, 0.25)
    child._relay_staging_events(f"{damaged}\n{valid}\n", "CAD install", "run1")
    [record] = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert "op=prune" in record.getMessage() and "outer=launch_unreadable" in record.getMessage()
    assert "SECRET" not in caplog.text


def test_the_parent_relays_a_valid_event_and_nothing_around_it(caplog):
    caplog.set_level(logging.DEBUG)
    event = sr.staging_kept_event(
        "reclaim", "an unreleased bootstrap not proven ended", ("a possible holder unreadable", 2), 1.5
    )
    child._relay_staging_events(f"pip says SECRET-NOISE\r\n{event}\r\nmore SECRET\r\n", "CAD install", "run1")
    [record] = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert record.name == child.logger.name
    message = record.getMessage()
    assert "run=run1" in message and "outer=bootstrap_unreleased_unproven" in message
    assert "inner=holder_unreadable" in message and "ended=2" in message and "elapsed_ms=1500" in message
    assert "SECRET" not in caplog.text


# --- S11: the standalone helper and the app's owned run -----------------------------------------------------------


def _child_env() -> dict:
    return {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "BAMDUDE_IGNORE_DOTENV": "1"}


def _app_with_a_kept_staging(root: Path) -> tuple[Path, Path]:
    """An app dir the real helper locates (this interpreter, the committed catalog) and a staging of its key that
    a live owner — this test process — keeps."""
    app = root / "app"
    installed(app, sr.DATA)
    key = sr.select(sr.load_catalog(sr.DATA)).key
    staging = sr.bundle_root(app) / ".staging" / key / ("b" * 32)
    staging.mkdir(parents=True)
    tree.record(staging / sr.OWNER_RECORD, os.getpid())
    tree.launch(staging, sr.INSTALLER)
    return app, staging


def test_the_standalone_helper_writes_the_event_to_stderr_and_keeps_its_stdout(install_tmp_path):
    app, staging = _app_with_a_kept_staging(install_tmp_path)
    result = subprocess.run(
        [sys.executable, "-m", "backend.app.step_runtime", "prune", "--app-dir", str(app)],
        cwd=REPO,
        env=_child_env(),
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {"ok": True, "removed": 0, "kept": {"writer_may_live": 1}}
    events = [sr.parse_staging_kept(line) for line in result.stderr.splitlines()]
    assert [(e["op"], e["outer"], e["inner"]) for e in events if e] == [("prune", "owner_may_live", "not_checked")]
    assert staging.is_dir() and str(staging) not in result.stderr


async def _owned(cmd: list[str], owner_root: Path, timeout: float = 120) -> child.OwnedRun:
    return await child.run_owned(
        cmd, owner_root=owner_root, timeout=timeout, cwd=REPO, env=_child_env(), label="CAD test"
    )


def _relayed(caplog) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == child.logger.name and "staging kept" in r.getMessage()]


async def test_the_owned_run_relays_the_event_of_a_helper_that_succeeded(install_tmp_path, caplog):
    caplog.set_level(logging.INFO)
    app, _ = _app_with_a_kept_staging(install_tmp_path)
    run = await _owned(
        [sys.executable, "-m", "backend.app.step_runtime", "prune", "--app-dir", str(app)], install_tmp_path / "owner"
    )
    assert run.outcome == "ok"
    [message] = _relayed(caplog)
    assert "op=prune" in message and "outer=owner_may_live" in message and "inner=not_checked" in message


async def test_the_owned_run_relays_the_event_of_a_helper_that_failed(install_tmp_path, caplog):
    caplog.set_level(logging.INFO)
    app, _ = _app_with_a_kept_staging(install_tmp_path)
    wheels = install_tmp_path / "no-wheels"
    wheels.mkdir()
    cmd = [
        sys.executable,
        "-m",
        "backend.app.step_runtime",
        "install",
        "--app-dir",
        str(app),
        "--wheels",
        str(wheels),
        "--allow-candidate",
    ]
    run = await _owned(cmd, install_tmp_path / "owner", timeout=600)
    assert (run.outcome, run.returncode) == ("failed", 1)
    assert json.loads(run.stdout_tail) == {"ok": False, "reason": "pip_failed"}
    [message] = _relayed(caplog)
    assert "op=reclaim" in message and "outer=owner_may_live" in message


async def test_the_owned_run_relays_what_a_helper_that_timed_out_had_written(tmp_path, caplog):
    caplog.set_level(logging.INFO)
    event = sr.staging_kept_event("reclaim", "launch unreadable", None, 0.25)
    script = tmp_path / "slow.py"
    script.write_text(
        f"import sys, time\nprint({event!r}, file=sys.stderr, flush=True)\ntime.sleep(60)\n", encoding="utf-8"
    )
    began = time.monotonic()
    run = await _owned([sys.executable, str(script)], tmp_path / "owner", timeout=3)
    assert run.outcome == "timeout" and time.monotonic() - began < 60
    [message] = _relayed(caplog)
    assert "outer=launch_unreadable" in message and "inner=not_checked" in message


async def test_the_owned_run_relays_a_valid_event_after_a_damaged_one(tmp_path, caplog):
    """Codex review ST-R1, through a real child: the damaged line is skipped, the next event still reaches the
    parent's log, and the run's outcome is the child's own."""
    caplog.set_level(logging.DEBUG)
    damaged, valid = _with("outer", {"SECRET": 1}), sr.staging_kept_event("reclaim", "launch unreadable", None, 0.25)
    script = tmp_path / "helper.py"
    script.write_text(f"import sys\nprint({damaged!r}, file=sys.stderr)\nprint({valid!r}, file=sys.stderr)\n")
    run = await _owned([sys.executable, str(script)], tmp_path / "owner")
    assert run.outcome == "ok"
    [message] = _relayed(caplog)
    assert "outer=launch_unreadable" in message
    assert "SECRET" not in caplog.text and "could not be read" not in caplog.text


# --- S12: without a sink nothing changes, and the log decides nothing ---------------------------------------------


def test_without_a_sink_the_proofs_answer_as_before(tmp_path, monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    staging = _kept_by_a_live_owner(tmp_path)
    plain = sr._writer_may_live(staging)
    heard = []
    assert sr._writer_may_live(staging, diagnostic=lambda why, ended: heard.append((why, ended))) == plain
    assert plain.startswith("owner ") and heard == []  # no token proof ran: nothing to hear
    assert _events(caplog) == []  # the event belongs to the decision to keep, never to the question
    owner = tree._identity(psutil.Process())
    assert isinstance(tree.end_launch_holders("0" * 32, 1, owner), bool)
    proven = tree.end_launch_holders("0" * 32, 1, owner, diagnostic=lambda why, ended: heard.append((why, ended)))
    assert len(heard) == 1 and proven is (heard[0][0] is None) and heard[0][1] == 0  # the same answer, told once


def test_a_log_that_breaks_changes_nothing_that_is_kept(tmp_path, monkeypatch):
    kept = _kept_by_a_live_owner(tmp_path, "kept")
    gone = _staging(tmp_path, "gone")
    _own_record(gone / sr.OWNER_RECORD, pid=2**22 + 7, create_time=1.0)

    def broken(*args, **kwargs):
        raise RuntimeError("the log broke")

    monkeypatch.setattr(sr, "staging_kept_event", broken)
    sr._reclaim_staging(kept.parent)
    assert kept.exists() and not gone.exists()
