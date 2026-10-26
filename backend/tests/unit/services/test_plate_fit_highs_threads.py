"""Plate fit solves with HiGHS on the calling thread only (vault ``70-research/plate-fit-highs-thread-exit-hang-2026-10-26``).

HiGHS keeps a pool of native worker threads per calling thread. SciPy's Windows build of it runs a ``thread_local``
destructor on a worker's exit, under the loader lock, after the thread's emulated TLS is gone, and it can spin there
for ever -- then no thread of the process can start or end (a pytest worker hung that way, and a native install could
on shutdown or reload). Without workers there is nothing to exit: ``threads=1``.
"""

import re
import threading
import warnings
from pathlib import Path

import psutil
import scipy.optimize

from backend.tests.unit.services.test_plate_fit import solve
from backend.tests.unit.services.test_plate_fit_fleet import farm

APP = Path(__file__).resolve().parents[3] / "app"


def test_a_solve_starts_no_highs_worker_threads_and_warns_nothing():
    """Measured inside a fresh thread, as ``to_thread`` runs it: the pool would live as long as that thread."""
    seen = {}

    def run():
        process = psutil.Process()
        before = {thread.id for thread in process.threads()}
        with warnings.catch_warnings():
            warnings.simplefilter("error", RuntimeWarning)
            proposal, status = solve(farm(), 1001, 1100, 1)
        seen.update(status=status, quantity=proposal.quantity if proposal else None)
        # New OS threads only: another thread of the process ending meanwhile changes nothing here.
        seen["started"] = {thread.id for thread in process.threads()} - before

    worker = threading.Thread(target=run)
    worker.start()
    worker.join(60)
    assert (seen.get("status"), seen.get("quantity")) == ("found", 1010), seen
    assert seen["started"] == set(), seen


def test_the_solver_is_asked_for_one_thread(monkeypatch):
    calls = []
    real = scipy.optimize.milp

    def recording(*args, **kwargs):
        calls.append(dict(kwargs.get("options") or {}))
        return real(*args, **kwargs)

    monkeypatch.setattr(scipy.optimize, "milp", recording)
    solve(farm(), 1001, 1100, 1)
    assert calls and all(options.get("threads") == 1 for options in calls), calls


def test_plate_fit_is_the_only_highs_caller():
    """HiGHS refuses a second thread count on a thread whose scheduler already started: one caller, one value."""
    callers = sorted(
        path.relative_to(APP).as_posix()
        for path in APP.rglob("*.py")
        if re.search(r"\b(milp|linprog|_?highspy|wasserstein_distance_nd)\b", path.read_text(encoding="utf-8"))
    )
    assert callers == ["services/plate_fit.py"], callers


def test_a_solver_error_is_logged_not_only_called_limited(monkeypatch, caplog):
    """A HiGHS error -- e.g. another thread count on a thread that already solved -- leaves a trace in the log."""
    import logging
    from types import SimpleNamespace

    monkeypatch.setattr(
        scipy.optimize,
        "milp",
        lambda *args, **kwargs: SimpleNamespace(status=4, x=None, message="(HiGHS Status 0: Not Set)"),
    )
    with caplog.at_level(logging.WARNING, logger="backend.app.services.plate_fit"):
        assert solve(farm(), 1001, 1100, 1) == (None, "limited")
    assert any("HiGHS Status 0: Not Set" in record.getMessage() for record in caplog.records), caplog.records
