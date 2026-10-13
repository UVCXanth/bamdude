"""What ``provision`` owns, and when (startup-provisioning spec P8, consilium r1 SP-R1).

A provision holds its platform's lock for its whole run; the OS releases it when the holder ends, however it ends.
Under the lock it removes what dead runs of its platform left -- their downloads and staging, of any version -- and
nothing else. The children below are REAL processes of an installed tree in ``tmp_path`` (a copy of the stdlib-only
module and a manifest), downloading from a loopback server.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from backend.app.services import render_runtime
from backend.app.services.render_runtime import ProvisionError, provision
from backend.app.services.render_runtime_child import run_provision

KEY = render_runtime.platform_key()
VERSION = "v99.0.0"


def _archive(tmp_path: Path, key: str = KEY, *, size: int = 4 * 1024 * 1024) -> Path:
    """An official-shaped archive for ``key`` whose executable is ``size`` incompressible bytes."""
    top = f"node-{VERSION}-{key}"
    body = os.urandom(size)
    if key == "win-x64":
        path = tmp_path / f"{top}.zip"
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as zf:
            zf.writestr(f"{top}/node.exe", body)
            zf.writestr(f"{top}/LICENSE", b"MIT")
        return path
    path = tmp_path / f"{top}.tar.gz"
    with tarfile.open(path, "w:gz") as tf:
        for name, data in ((f"{top}/bin/node", body), (f"{top}/LICENSE", b"MIT")):
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(data), 0o755
            tf.addfile(info, io.BytesIO(data))
    return path


def _manifest(archive: Path, url: str, key: str = KEY, sha: str | None = None) -> dict:
    data = archive.read_bytes()
    entry = {"line": "t", "url": url, "sha256": sha or hashlib.sha256(data).hexdigest(), "bytes": len(data)}
    return {"lines": {"t": {"version": VERSION}}, "platforms": {key: entry}}


def _tree(app_dir: Path, manifest: dict) -> Path:
    """An installed tree: the real stdlib-only module and its manifest, nothing else."""
    services = app_dir / "backend" / "app" / "services"
    services.mkdir(parents=True)
    for package in (app_dir / "backend", app_dir / "backend" / "app", services):
        (package / "__init__.py").write_text("", encoding="utf-8")
    (services / "render_runtime.py").write_text(Path(render_runtime.__file__).read_text(encoding="utf-8"), "utf-8")
    data = app_dir / "backend" / "app" / "data"
    data.mkdir()
    (data / "render_runtime.json").write_text(json.dumps(manifest), encoding="utf-8")
    return app_dir


@contextlib.contextmanager
def _server(archive: Path, *, stall_after: int | None = None, chunk_delay: float = 0.0):
    """Serves ``archive``; past ``stall_after`` bytes it stops sending until the test ends. Counts the GETs."""
    data = archive.read_bytes()
    release = threading.Event()
    gets: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            gets.append(self.path)
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            with contextlib.suppress(ConnectionError):
                sent = 0
                for start in range(0, len(data), 256 * 1024):
                    if stall_after is not None and sent >= stall_after:
                        release.wait(60)
                        return
                    block = data[start : start + 256 * 1024]
                    self.wfile.write(block)
                    self.wfile.flush()
                    sent += len(block)
                    time.sleep(chunk_delay)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/{archive.name}", gets
    finally:
        release.set()
        server.shutdown()
        server.server_close()


def _leftovers(runtime: Path, key: str = KEY) -> list[str]:
    product = runtime / "node"
    return sorted(
        p.name for p in product.iterdir() if p.name.startswith(f".{key}.download.") or p.name.endswith(".part")
    )


def _wait_for_download(runtime: Path, deadline: float = 30.0) -> None:
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        if any(f.stat().st_size > 0 for f in (runtime / "node").glob(f".{KEY}.download.*/*")):
            return
        time.sleep(0.05)
    raise AssertionError("the child never started its download")


@pytest.mark.asyncio
async def test_a_killed_download_is_reclaimed_by_the_next_provision(tmp_path):
    # SP-R1: the runner kills a child past its budget; the next provision removes what it left, on disk
    archive = _archive(tmp_path)
    with _server(archive, stall_after=1024 * 1024) as (url, _):
        app_dir = _tree(tmp_path / "install", _manifest(archive, url))
        run = await asyncio.wait_for(run_provision(app_dir, trigger="test", timeout=4), 60)
    assert run.outcome == "timed_out"
    runtime = app_dir / "runtime"
    assert _leftovers(runtime), "the killed child left nothing: the scenario did not happen"

    provision(runtime, manifest=_manifest(archive, archive.as_uri()), platform=KEY)

    assert render_runtime.locate_in(runtime, KEY) is not None
    assert _leftovers(runtime) == []


def test_only_this_platforms_dead_leftovers_are_reclaimed(tmp_path):
    other = "linux-arm64" if KEY != "linux-arm64" else "linux-x64"
    product = tmp_path / "runtime" / "node"
    names = [f".{KEY}.download.abc", f".{KEY}.v24.17.0.part", f".{KEY}.{VERSION}.part", f".{other}.download.xyz"]
    for name in [*names, f".{KEY}.old"]:
        (product / name).mkdir(parents=True)
        (product / name / "f").write_bytes(b"x")
    archive = _archive(tmp_path, size=1024)
    bad = _manifest(archive, archive.as_uri(), sha="0" * 64)

    with pytest.raises(ProvisionError, match="sha256"):  # fails before the swap: the backup's own rules hold
        provision(tmp_path / "runtime", manifest=bad, platform=KEY)

    assert sorted(p.name for p in product.iterdir()) == sorted(
        [f".{other}.download.xyz", f".{KEY}.old", f".{KEY}.lock"]
    )


def test_a_second_provision_of_the_platform_waits_and_downloads_nothing(tmp_path):
    archive = _archive(tmp_path)
    with _server(archive, chunk_delay=0.15) as (url, gets):
        app_dir = _tree(tmp_path / "install", _manifest(archive, url))
        runtime = app_dir / "runtime"
        argv = [sys.executable, "-m", "backend.app.services.render_runtime", "provision", "--runtime", str(runtime)]
        first = subprocess.Popen(argv, cwd=app_dir, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            _wait_for_download(runtime)
            second = subprocess.run(argv, cwd=app_dir, capture_output=True, timeout=120)
            _, first_err = first.communicate(timeout=120)
        finally:
            if first.poll() is None:
                first.kill()
                first.wait()
    assert first.returncode == 0, first_err
    assert second.returncode == 0, second.stderr
    assert b"waiting" in second.stderr
    assert len(gets) == 1
    assert _leftovers(runtime) == []
    assert render_runtime.locate_in(runtime, KEY) is not None


def test_a_leftover_the_os_keeps_is_never_called_removed(tmp_path, monkeypatch, capsys):
    # consilium r2 SP2-M1: rmtree(ignore_errors=True) returns normally when a hold denies the removal
    product = tmp_path / "runtime" / "node"
    stale = product / f".{KEY}.download.interrupted"
    stale.mkdir(parents=True)
    (stale / "node.zip").write_bytes(b"archive")
    monkeypatch.setattr(render_runtime.shutil, "rmtree", lambda *args, **kwargs: None)

    removed, held = render_runtime._reclaim(product, KEY)

    assert stale.exists()
    assert removed == [] and held == [stale.name]


def test_a_held_staging_of_this_version_is_a_clear_refusal_before_any_download(tmp_path, monkeypatch, capsys):
    product = tmp_path / "runtime" / "node"
    staged = product / f".{KEY}.{VERSION}.part"
    staged.mkdir(parents=True)
    (staged / "node").write_bytes(b"half")
    monkeypatch.setattr(render_runtime.shutil, "rmtree", lambda *args, **kwargs: None)
    archive = _archive(tmp_path, size=1024)
    fetched = []

    with pytest.raises(ProvisionError, match="could not be removed"):
        provision(
            tmp_path / "runtime",
            manifest=_manifest(archive, archive.as_uri()),
            platform=KEY,
            fetch=lambda url, dest, limit=None: fetched.append(url),
        )

    assert fetched == []
    said = capsys.readouterr().err
    assert (
        "removed what" not in said
        and f"could not be removed (a file still held, or no permission): {staged.name}" in said
    )


@pytest.mark.asyncio
async def test_a_waiter_past_its_budget_ends_only_itself(tmp_path):
    # consilium r2 Q5: the budget covers the wait for the lock, and a waiter that runs out of it touches nothing
    archive = _archive(tmp_path)
    with _server(archive, chunk_delay=0.25) as (url, gets):
        app_dir = _tree(tmp_path / "install", _manifest(archive, url))
        runtime = app_dir / "runtime"
        argv = [sys.executable, "-m", "backend.app.services.render_runtime", "provision", "--runtime", str(runtime)]
        holder = subprocess.Popen(argv, cwd=app_dir, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            await asyncio.to_thread(_wait_for_download, runtime)
            waiter = await asyncio.wait_for(run_provision(app_dir, trigger="test", timeout=1.5), 60)
            _, holder_err = await asyncio.to_thread(holder.communicate, timeout=120)
        finally:
            if holder.poll() is None:
                holder.kill()
                holder.wait()
    assert waiter.outcome == "timed_out"
    assert holder.returncode == 0, holder_err
    assert len(gets) == 1
    assert _leftovers(runtime) == []
    assert render_runtime.locate_in(runtime, KEY) is not None


def _pin_in_place(runtime: Path) -> Path:
    target = runtime / "node" / KEY
    executable = target / ("node.exe" if KEY == "win-x64" else "bin/node")
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"node")
    (target / "VERSION").write_text(VERSION + "\n", encoding="utf-8")
    return target


def test_a_pin_in_place_succeeds_when_its_lock_cannot_be_opened(tmp_path, monkeypatch):
    # final review M3: a lock file this user may not create (a runtime directory left root-owned by a sudo run) must
    # not fail the update of an install whose Node is fine
    target = _pin_in_place(tmp_path / "runtime")
    archive = _archive(tmp_path, size=1024)

    def refuse(product, key):
        raise PermissionError(13, "Permission denied", str(product / f".{key}.lock"))

    monkeypatch.setattr(render_runtime, "_open_lock", refuse)
    assert provision(tmp_path / "runtime", manifest=_manifest(archive, archive.as_uri()), platform=KEY) == target


def test_a_lock_that_cannot_be_opened_is_an_error_without_the_pin(tmp_path, monkeypatch):
    archive = _archive(tmp_path, size=1024)

    def refuse(product, key):
        raise PermissionError(13, "Permission denied", str(product / f".{key}.lock"))

    monkeypatch.setattr(render_runtime, "_open_lock", refuse)
    with pytest.raises(PermissionError):
        provision(tmp_path / "runtime", manifest=_manifest(archive, archive.as_uri()), platform=KEY)


def test_a_later_provision_reclaims_what_an_earlier_one_could_not(tmp_path, monkeypatch, capsys):
    # consilium r5 SP-I-M1: a leftover the OS held during a successful provision is removed by the next one of the
    # same pin -- the reclaim runs under the lock even when the pin is already in place (spec P8)
    runtime = tmp_path / "runtime"
    stale = runtime / "node" / f".{KEY}.download.interrupted"
    stale.mkdir(parents=True)
    (stale / "archive").write_bytes(b"left by a killed download")
    archive = _archive(tmp_path, size=1024)
    manifest = _manifest(archive, archive.as_uri())
    rmtree = render_runtime.shutil.rmtree

    def held(path, *args, **kwargs):
        if Path(path) == stale:
            return  # rmtree(ignore_errors=True) while an antivirus holds a file
        return rmtree(path, *args, **kwargs)

    with monkeypatch.context() as hold:
        hold.setattr(render_runtime.shutil, "rmtree", held)
        target = provision(runtime, manifest=manifest, platform=KEY)
    assert stale.exists() and render_runtime.locate_in(runtime, KEY) is not None
    capsys.readouterr()

    assert provision(runtime, manifest=manifest, platform=KEY) == target  # the hold is over; same pin, no download

    assert not stale.exists()
    assert f"removed what an interrupted provisioning left: {stale.name}" in capsys.readouterr().err
