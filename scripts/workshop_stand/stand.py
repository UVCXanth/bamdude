"""The WS-13 comparison stand — a second BamDude on a scratch DATA_DIR.

Spec and plan: vault ``60-specs/workshop-ui-parity-e00-stand.md``. The stand
serves the real application (routes, auth, writers, database) with a minimal
lifespan, seeded with the content of the final mockup, so the Workshop UI can be
compared with ``temp/proj-ui-work/02-mockup-v2.html`` side by side.

This runner imports nothing from ``backend``: every process that does — the
database init, the server, the direct-write seeding phase — is started as a
child with an environment built here, so the application's settings are read
with the stand's values from the first import.

    python scripts/workshop_stand/stand.py up     [--mode baseline|edges]
    python scripts/workshop_stand/stand.py seed   [--mode …]
    python scripts/workshop_stand/stand.py status [--mode …]
    python scripts/workshop_stand/stand.py verify [--mode …] --dump|--snapshot FILE
    python scripts/workshop_stand/stand.py smoke  [--mode …]
    python scripts/workshop_stand/stand.py down   [--mode …]
    python scripts/workshop_stand/stand.py reset  [--mode …]
"""

from __future__ import annotations

import contextlib
import json
import os
import shutil
import sys
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TIMEZONE = "Europe/Kyiv"


@dataclass(frozen=True)
class Ports:
    backend: int
    vite: int


MODES: dict[str, Ports] = {"baseline": Ports(8100, 5273), "edges": Ports(8101, 5274)}

# What a child process may take from the operator's shell: only what Windows,
# Python and Node need to run. Anything else — a proxy target, a log folder, a
# database URL, a token — is simply not passed on (spec A3).
_INHERITED = (
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATH",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
)
_INHERITED_PREFIXES = ("PROCESSOR_",)


class StandError(Exception):
    """A refusal: the stand will not act, and the message says why."""


def preflight(parent: Mapping[str, str] | None = None) -> None:
    """Refusals that do not depend on the stand's state, asked BEFORE anything is
    touched — a reset must not delete a root and only then notice it may not run."""
    parent = os.environ if parent is None else parent
    if parent.get("DATABASE_URL"):
        raise StandError(
            "DATABASE_URL is set in this shell. The stand runs on its own SQLite file; "
            "unset DATABASE_URL first — a stand pointed at another database is exactly what it must never be."
        )


def build_env(
    parent: Mapping[str, str],
    *,
    root: Path,
    instance: str,
    mode: str,
    for_vite: bool = False,
) -> dict[str, str]:
    """The environment of a stand child process, built from an allowlist (spec A3)."""
    preflight(parent)
    env = {
        name: value
        for name, value in parent.items()
        if name.upper() in _INHERITED or name.upper().startswith(_INHERITED_PREFIXES)
    }
    tmp = str(root / "tmp")
    env.update(
        DATA_DIR=str(root / "data"),
        LOG_DIR=str(root / "logs"),
        TEMP_DIR=tmp,
        TEMP=tmp,
        TMP=tmp,
        BAMDUDE_IGNORE_DOTENV="1",
        WS13_STAND_INSTANCE=instance,
        WS13_STAND_ROOT=str(root),
        TZ=TIMEZONE,
    )
    if for_vite:
        env["BACKEND_URL"] = f"http://127.0.0.1:{MODES[mode].backend}"
    return env


# ── The mode root: the one folder a reset may delete (spec A9) ────────────────


def expected_root(mode: str, repo: Path = REPO) -> Path:
    if mode not in MODES:
        raise StandError(f"Unknown mode {mode!r}; one of {', '.join(MODES)}.")
    return repo / "temp" / "ws13-stand" / mode


def _same(a: Path, b: Path) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def _refuse_links(path: Path) -> None:
    """No component of ``path`` that exists may be a symlink or a junction."""
    for part in (path, *path.parents):
        if part.exists() or os.path.islink(part):
            if os.path.islink(part) or part.is_junction():
                raise StandError(f"{part} is a link or junction; the stand root must be a plain folder.")


def check_root(path: Path, *, mode: str, repo: Path = REPO, create: bool = False) -> Path:
    """``path`` if it is exactly this mode's root, with no link anywhere on the way.

    A root that does not exist yet (the first run) is created only when its
    nearest existing ancestor passes the same checks and every missing name is
    one the stand root is made of; the created root is then checked again."""
    expected = expected_root(mode, repo)
    if not _same(path, expected):
        raise StandError(f"{path} is not the stand root for mode {mode!r} ({expected}).")
    if not path.exists():
        if not create:
            raise StandError(f"The stand root {path} does not exist; run `reset` first.")
        ancestor = path
        while not ancestor.exists():
            ancestor = ancestor.parent
        _refuse_links(ancestor)
        if not _same(ancestor.resolve(strict=True), ancestor):
            raise StandError(f"{ancestor} resolves elsewhere ({ancestor.resolve(strict=True)}).")
        missing = path.relative_to(ancestor).parts
        allowed = ("temp", "ws13-stand", mode)
        if tuple(missing) != allowed[len(allowed) - len(missing) :]:
            raise StandError(f"Refusing to create {path}: {'/'.join(missing)} is not part of the stand root.")
        path.mkdir(parents=True)
    _refuse_links(path)
    if not _same(path.resolve(strict=True), expected):
        raise StandError(f"{path} resolves to {path.resolve(strict=True)}, not the stand root.")
    return path


# ── Processes: only our own are ever stopped (spec A7, A8) ───────────────────


def _created_windows(pid: int) -> int | None:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != 259:  # STILL_ACTIVE
            return None
        times = [wintypes.FILETIME() for _ in range(4)]
        if not kernel32.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
            return None
        return (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
    finally:
        kernel32.CloseHandle(handle)


def _cmdline_windows(pid: int) -> str:
    import subprocess

    out = subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-Command",
            f"(Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}').CommandLine",
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    return out.stdout.strip()


def process_identity(pid: int) -> dict | None:
    """``{pid, created, cmdline}`` of a live process, or ``None`` when it is gone.

    The creation time is what tells a process from a later one that reused its
    PID; the command line is what tells ours from a stranger's."""
    if sys.platform == "win32":
        created = _created_windows(pid)
        if created is None:
            return None
        return {"pid": pid, "created": created, "cmdline": _cmdline_windows(pid)}
    stat = Path(f"/proc/{pid}/stat")
    try:
        created = int(stat.read_text().rsplit(")", 1)[1].split()[19])
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode().strip()
    except (OSError, IndexError, ValueError):
        return None
    return {"pid": pid, "created": created, "cmdline": cmdline}


def is_same_process(recorded: dict | None) -> bool:
    """Is the process ``recorded`` in a manifest still the one running under its PID?"""
    if not recorded or not recorded.get("pid"):
        return False
    live = process_identity(int(recorded["pid"]))
    return bool(live) and live["created"] == recorded.get("created") and live["cmdline"] == recorded.get("cmdline")


# ── Manifest ──────────────────────────────────────────────────────────────────


def read_manifest(root: Path) -> dict:
    path = root / "manifest.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def write_manifest(root: Path, manifest: dict) -> None:
    path = root / "manifest.json"
    tmp = path.with_suffix(".json.part")
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def live_processes(manifest: dict) -> list[str]:
    return [name for name, rec in (manifest.get("processes") or {}).items() if is_same_process(rec)]


# ── Reset ─────────────────────────────────────────────────────────────────────

_ROOT_DIRS = ("data", "logs", "tmp", "run")


def reset(mode: str, *, repo: Path = REPO, init_db: bool = True) -> dict:
    """Delete this mode's root and start a fresh instance (spec A9)."""
    preflight()
    root = check_root(expected_root(mode, repo), mode=mode, repo=repo, create=True)
    running = live_processes(read_manifest(root))
    if running:
        raise StandError(f"The stand's {', '.join(running)} is still running; run `down` first.")
    for child in root.iterdir():
        if child.is_junction():
            os.rmdir(child)  # the link only, never what it points at
        elif child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    for sub in _ROOT_DIRS:
        (root / sub).mkdir()
    manifest = {
        "instance_id": str(uuid.uuid4()),
        "mode": mode,
        "root": str(root),
        "database": str(root / "data" / "bamdude.db"),
        "ports": {"backend": MODES[mode].backend, "vite": MODES[mode].vite},
        "state": "fresh",
        "processes": {},
    }
    write_manifest(root, manifest)
    if init_db:
        _init_database(root, manifest)
    return manifest


# ── Lock: one mutating command per mode at a time (spec A7) ──────────────────


def lock_path(mode: str, repo: Path = REPO) -> Path:
    return expected_root(mode, repo).parent / f"{mode}.lock"


@contextlib.contextmanager
def lock(mode: str, *, repo: Path = REPO):
    path = lock_path(mode, repo)
    path.parent.mkdir(parents=True, exist_ok=True)
    me = process_identity(os.getpid()) or {"pid": os.getpid(), "created": None}
    for _attempt in range(2):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                holder = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                holder = {}
            live = process_identity(int(holder.get("pid") or 0)) if holder.get("pid") else None
            if live and live["created"] == holder.get("created"):
                raise StandError(
                    f"Another stand command is already running for mode {mode!r} (pid {holder['pid']})."
                ) from None
            print(f"Removing a stale lock of pid {holder.get('pid')} ({path}).")
            path.unlink(missing_ok=True)
            continue
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"pid": me["pid"], "created": me["created"]}, fh)
        break
    else:
        raise StandError(f"Could not take the lock {path}.")
    try:
        yield
    finally:
        path.unlink(missing_ok=True)


# ── HTTP: every answer must carry this instance's marker (spec A6) ───────────

MARKER = "X-WS13-Stand"


class ApiRefusal(StandError):
    """The stand answered, with a status the caller did not expect."""

    def __init__(self, method: str, path: str, status: int, body):
        self.status = status
        self.body = body
        shown = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
        super().__init__(f"{method} {path} → {status}: {shown}")


class StandClient:
    """A JSON client that talks to this stand instance and to nothing else.

    The marker is checked on every response, refusals included, before its body
    is looked at: a listener without it — or with another instance's — is not
    this stand, whatever it answers."""

    def __init__(self, base_url: str, *, instance: str, token: str | None = None, timeout: float = 120):
        self.base_url = base_url.rstrip("/")
        self.instance = instance
        self.token = token
        self.timeout = timeout

    def _check(self, headers, method: str, path: str) -> None:
        got = headers.get(MARKER)
        if got != self.instance:
            raise StandError(
                f"{method} {path}: the listener at {self.base_url} is not this stand "
                f"(marker {got!r}, expected {self.instance!r}); nothing was written."
            )

    def request(
        self,
        method: str,
        path: str,
        body=None,
        *,
        expect=(200, 201, 202, 204),
        raw: bytes | None = None,
        content_type: str | None = None,
    ):
        import urllib.error
        import urllib.request

        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base_url + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", content_type or "application/json")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                self._check(resp.headers, method, path)
                status, payload = resp.status, resp.read()
        except urllib.error.HTTPError as exc:
            self._check(exc.headers, method, path)
            status, payload = exc.code, exc.read()
        try:
            parsed = json.loads(payload) if payload else None
        except ValueError:
            parsed = payload.decode(errors="replace")
        if status not in expect:
            raise ApiRefusal(method, path, status, parsed)
        return parsed

    def get(self, path: str, **kw):
        return self.request("GET", path, **kw)

    def post(self, path: str, body=None, **kw):
        return self.request("POST", path, body, **kw)

    def put(self, path: str, body=None, **kw):
        return self.request("PUT", path, body, **kw)

    def patch(self, path: str, body=None, **kw):
        return self.request("PATCH", path, body, **kw)

    def delete(self, path: str, **kw):
        return self.request("DELETE", path, **kw)


def read_credentials(root: Path, manifest: dict) -> dict:
    path = root / "credentials.json"
    if not path.exists():
        raise StandError("No stand credentials; `seed` creates them on a fresh instance.")
    creds = json.loads(path.read_text(encoding="utf-8"))
    if creds.get("instance_id") != manifest.get("instance_id"):
        raise StandError("The credentials belong to an earlier instance of the stand; run `reset`.")
    return creds


# ── Ports (spec A2) ───────────────────────────────────────────────────────────


def require_free_port(port: int) -> None:
    """Refuse a port somebody listens on — never pick another one."""
    import socket

    with socket.socket() as probe:
        probe.settimeout(0.5)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            raise StandError(f"Port {port} is in use; the stand does not move to another port.")
    with socket.socket() as sock:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            raise StandError(f"Port {port} is in use; the stand does not move to another port.") from None


# ── Child processes ───────────────────────────────────────────────────────────

HERE = Path(__file__).resolve().parent
_WINDOWS = sys.platform == "win32"


def python_exe(repo: Path = REPO) -> str:
    venv = repo / "venv" / ("Scripts/python.exe" if _WINDOWS else "bin/python")
    return str(venv) if venv.exists() else sys.executable


def run_child_python(root: Path, manifest: dict, code: str, *, timeout: float = 600) -> str:
    """Run ``code`` in a child interpreter with the stand environment and its guard installed."""
    import subprocess

    env = build_env(os.environ, root=root, instance=manifest["instance_id"], mode=manifest["mode"])
    prologue = (
        "import sys\n"
        f"sys.path.insert(0, {str(HERE)!r})\n"
        "import stand_guard\n"
        f"stand_guard.install({str(root / 'run')!r})\n"
    )
    out = subprocess.run(
        [python_exe(), "-c", prologue + code],
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        check=False,
    )
    if out.returncode != 0:
        raise StandError(f"child process failed ({out.returncode}):\n{out.stderr[-4000:]}")
    return out.stdout


def _init_database(root: Path, manifest: dict) -> None:
    run_child_python(
        root,
        manifest,
        "import asyncio\n"
        "from backend.app.core import database\n"
        "async def main():\n"
        "    await database.init_db()\n"
        "    await database.engine.dispose()\n"
        "asyncio.run(main())\n",
    )


def check_timezone(root: Path, manifest: dict) -> str:
    """The server must recognise the stand's zone — ``server_timezone`` falls back to UTC silently."""
    out = run_child_python(
        root,
        manifest,
        "from backend.app.core.timezones import server_timezone\nprint(getattr(server_timezone(), 'key', None))\n",
    )
    key = out.strip().splitlines()[-1]
    if key != TIMEZONE:
        raise StandError(f"The stand's TZ={TIMEZONE} is not recognised by the server (got {key!r}).")
    return key


def _spawn(argv: list[str], *, cwd: Path, env: dict, log: Path):
    import subprocess

    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP if _WINDOWS else 0
    kwargs = {"cwd": cwd, "env": env, "stderr": subprocess.STDOUT, "stdin": subprocess.DEVNULL}
    with open(log, "ab") as fh:
        try:
            breakaway = subprocess.CREATE_BREAKAWAY_FROM_JOB if _WINDOWS else 0
            return subprocess.Popen(argv, stdout=fh, creationflags=flags | breakaway, **kwargs)
        except OSError:
            # A job that forbids breakaway: stay in it rather than not start.
            return subprocess.Popen(argv, stdout=fh, creationflags=flags, **kwargs)


def _listen_addresses(port: int) -> set[str]:
    """Local addresses something listens on at ``port`` (Windows)."""
    import subprocess

    command = (
        f"Get-NetTCPConnection -State Listen -LocalPort {int(port)} -ErrorAction SilentlyContinue "
        "| ForEach-Object { $_.LocalAddress }"
    )
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command", command], capture_output=True, text=True, check=False, timeout=60
    )
    return {line.strip() for line in out.stdout.splitlines() if line.strip()}


def _wait(predicate, *, timeout: float, what: str, proc=None, log: Path | None = None):
    import time

    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        if proc is not None and proc.poll() is not None:
            tail = log.read_text(encoding="utf-8", errors="replace")[-3000:] if log else ""
            raise StandError(f"{what} exited with {proc.returncode} while starting.\n{tail}")
        try:
            result = predicate()
            if result:
                return result
        except StandError:
            raise
        except Exception as exc:  # noqa: BLE001 — not up yet
            last = exc
        time.sleep(1)
    raise StandError(f"{what} did not come up within {timeout:.0f} s ({last}).")


def _http_ok(url: str) -> bool:
    import urllib.request

    with urllib.request.urlopen(url, timeout=5) as resp:
        return resp.status == 200


def up(mode: str, *, repo: Path = REPO) -> dict:
    """Start this mode's backend and Vite (spec A2, A7)."""
    preflight()
    with lock(mode, repo=repo):
        root = check_root(expected_root(mode, repo), mode=mode, repo=repo)
        manifest = read_manifest(root)
        if not manifest.get("instance_id"):
            raise StandError("The stand has no instance; run `reset` first.")
        running = live_processes(manifest)
        if running:
            raise StandError(f"The stand's {', '.join(running)} is already running.")
        ports = MODES[mode]
        require_free_port(ports.backend)
        require_free_port(ports.vite)
        manifest["timezone"] = check_timezone(root, manifest)

        run = root / "run"
        (run / "stop").unlink(missing_ok=True)
        backend = _spawn(
            [python_exe(repo), str(HERE / "stand_serve.py"), "--port", str(ports.backend)],
            cwd=repo,
            env=build_env(os.environ, root=root, instance=manifest["instance_id"], mode=mode),
            log=run / "backend.log",
        )
        manifest["processes"] = {"backend": process_identity(backend.pid) or {"pid": backend.pid}}
        write_manifest(root, manifest)
        client = StandClient(f"http://127.0.0.1:{ports.backend}", instance=manifest["instance_id"])
        _wait(
            lambda: client.get("/api/v1/auth/status") is not None,
            timeout=180,
            what="The stand backend",
            proc=backend,
            log=run / "backend.log",
        )

        vite_js = repo / "frontend" / "node_modules" / "vite" / "bin" / "vite.js"
        vite = _spawn(
            ["node", str(vite_js), "--host", "127.0.0.1", "--port", str(ports.vite), "--strictPort"],
            cwd=repo / "frontend",
            env=build_env(os.environ, root=root, instance=manifest["instance_id"], mode=mode, for_vite=True),
            log=run / "vite.log",
        )
        manifest["processes"]["vite"] = process_identity(vite.pid) or {"pid": vite.pid}
        write_manifest(root, manifest)
        _wait(
            lambda: _http_ok(f"http://127.0.0.1:{ports.vite}/"),
            timeout=120,
            what="The stand Vite",
            proc=vite,
            log=run / "vite.log",
        )

        if _WINDOWS:
            for name, port in (("backend", ports.backend), ("vite", ports.vite)):
                addresses = _listen_addresses(port)
                if addresses - {"127.0.0.1"}:
                    raise StandError(f"The stand {name} listens on {sorted(addresses)}, not only on 127.0.0.1.")
            manifest["listening"] = {"backend": "127.0.0.1", "vite": "127.0.0.1"}
        write_manifest(root, manifest)
        return manifest


def _terminate(recorded: dict) -> None:
    import subprocess

    if _WINDOWS:
        subprocess.run(["taskkill", "/PID", str(recorded["pid"]), "/T", "/F"], capture_output=True, check=False)
    else:
        import signal

        os.kill(int(recorded["pid"]), signal.SIGTERM)


def _database_released(db: Path) -> bool:
    for path in (db, db.with_name(db.name + "-wal")):
        if path.exists():
            try:
                os.rename(path, path)
            except OSError:
                return False
    return True


def down(mode: str, *, repo: Path = REPO) -> dict:
    """Stop this mode's processes — only those the manifest recorded, identity checked (spec A8)."""
    import time

    with lock(mode, repo=repo):
        root = check_root(expected_root(mode, repo), mode=mode, repo=repo)
        manifest = read_manifest(root)
        processes = manifest.get("processes") or {}
        backend = processes.get("backend")
        if is_same_process(backend):
            # A clean stop first, so the application's shutdown runs (engine.dispose()).
            (root / "run" / "stop").write_text("stop", encoding="utf-8")
            deadline = time.monotonic() + 30
            while is_same_process(backend) and time.monotonic() < deadline:
                time.sleep(1)
        for name, recorded in processes.items():
            if is_same_process(recorded):
                print(f"Stopping the stand's {name} (pid {recorded['pid']}).")
                _terminate(recorded)
        deadline = time.monotonic() + 30
        while live_processes(manifest) and time.monotonic() < deadline:
            time.sleep(1)
        still = live_processes(manifest)
        if still:
            raise StandError(f"The stand's {', '.join(still)} did not stop.")
        db = Path(manifest.get("database") or root / "data" / "bamdude.db")
        _wait(lambda: _database_released(db), timeout=60, what="Release of the stand database")
        (root / "run" / "stop").unlink(missing_ok=True)
        manifest["processes"] = {}
        write_manifest(root, manifest)
        return manifest


# ── Command line ──────────────────────────────────────────────────────────────

COMMANDS: dict = {}


def command(name: str):
    def register(fn):
        COMMANDS[name] = fn
        return fn

    return register


@command("reset")
def _cmd_reset(args) -> None:
    with lock(args.mode):
        manifest = reset(args.mode)
    print(json.dumps({"reset": args.mode, "instance_id": manifest["instance_id"]}))


@command("up")
def _cmd_up(args) -> None:
    manifest = up(args.mode)
    ports = manifest["ports"]
    print(
        json.dumps(
            {
                "up": args.mode,
                "backend": f"http://127.0.0.1:{ports['backend']}",
                "ui": f"http://127.0.0.1:{ports['vite']}",
                "timezone": manifest.get("timezone"),
            }
        )
    )


@command("down")
def _cmd_down(args) -> None:
    down(args.mode)
    print(json.dumps({"down": args.mode}))


# ── Seed (spec B1–B3, C1–C6) ──────────────────────────────────────────────────

MOCKUP_DUMP = REPO / "temp" / "ws13-stand" / "mockup-db.json"


def dump_mockup(repo: Path = REPO) -> dict:
    import subprocess

    out = subprocess.run(
        ["node", str(HERE / "dump_mockup.mjs"), str(MOCKUP_DUMP)],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
        timeout=300,
    )
    if out.returncode != 0:
        raise StandError(f"The mockup dump refused: {out.stderr.strip()}")
    return json.loads(MOCKUP_DUMP.read_text(encoding="utf-8"))


def stand_today() -> date:
    from zoneinfo import ZoneInfo

    return datetime.now(ZoneInfo(TIMEZONE)).date()


def _direct(root: Path, manifest: dict):
    """``seed_direct`` in a child with the stand environment: payload in, result out."""

    def call(command: str, payload: dict) -> dict:
        tmp = root / "tmp"
        source = tmp / f"direct-{command}-in.json"
        target = tmp / f"direct-{command}-out.json"
        source.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        run_child_python(
            root,
            manifest,
            f"import seed_direct\nseed_direct.main([{command!r}, {str(source)!r}, {str(target)!r}])\n",
        )
        return json.loads(target.read_text(encoding="utf-8"))

    return call


def client_for(manifest: dict, token: str | None = None) -> StandClient:
    return StandClient(
        f"http://127.0.0.1:{manifest['ports']['backend']}", instance=manifest["instance_id"], token=token
    )


def seed(mode: str, *, repo: Path = REPO) -> dict:
    import seed_http

    preflight()
    with lock(mode, repo=repo):
        root = check_root(expected_root(mode, repo), mode=mode, repo=repo)
        manifest = read_manifest(root)
        if manifest.get("state") != "fresh":
            raise StandError(f"The stand is {manifest.get('state')!r}, not fresh; a seed needs `reset` first.")
        if not is_same_process((manifest.get("processes") or {}).get("backend")):
            raise StandError("The stand backend is not running; run `up` first.")
        if (root / "credentials.json").exists():
            raise StandError("Credentials exist on a fresh instance; run `reset`.")
        dump = dump_mockup(repo)
        anchor = stand_today()
        delta = (anchor - date(2026, 9, 25)).days
        manifest.update(
            state="seeding",
            anchor=anchor.isoformat(),
            delta_days=delta,
            recipe_version=dump["meta"]["recipe_version"],
            mockup={k: dump["meta"][k] for k in ("html", "html_sha256", "data_js_sha256", "dump_sha256")},
        )
        write_manifest(root, manifest)
        client = client_for(manifest)
        try:
            run = seed_http.Seed(client, dump, root=root, delta=delta, direct=_direct(root, manifest), mode=mode)
            credentials = run.setup_admin()
            (root / "credentials.json").write_text(
                json.dumps({"instance_id": manifest["instance_id"], **credentials}), encoding="utf-8"
            )
            result = run.run()
            if mode == "edges":
                import edges

                result["findings"] += edges.seed(run)
            (root / "mapping.json").write_text(
                json.dumps(result["mapping"], ensure_ascii=False, indent=1), encoding="utf-8"
            )
        except BaseException:
            manifest["state"] = "failed"
            write_manifest(root, manifest)
            raise
        manifest["state"] = "seeded"
        manifest["seed_findings"] = result["findings"]
        write_manifest(root, manifest)
        return manifest


@command("seed")
def _cmd_seed(args) -> None:
    manifest = seed(args.mode)
    print(json.dumps({"seeded": args.mode, "anchor": manifest["anchor"], "findings": len(manifest["seed_findings"])}))


def logged_in_client(root: Path, manifest: dict) -> StandClient:
    creds = read_credentials(root, manifest)
    client = client_for(manifest)
    answer = client.post("/api/v1/auth/login", {"username": creds["username"], "password": creds["password"]})
    client.token = answer["access_token"]
    return client


def status(mode: str, *, repo: Path = REPO) -> dict:
    import checks

    root = check_root(expected_root(mode, repo), mode=mode, repo=repo)
    manifest = read_manifest(root)
    if manifest.get("state") != "seeded":
        raise StandError(f"The stand is {manifest.get('state')!r}, not seeded.")
    if not is_same_process((manifest.get("processes") or {}).get("backend")):
        raise StandError("The stand backend is not running; run `up` first.")
    client = logged_in_client(root, manifest)
    mapping = json.loads((root / "mapping.json").read_text(encoding="utf-8"))
    dump = json.loads(MOCKUP_DUMP.read_text(encoding="utf-8"))
    results = checks.Checks(client, dump, mapping, _direct(root, manifest), mode).run()
    if mode == "edges":
        import edges

        results += edges.checks(client, mapping)
    failed = [r for r in results if not r[1]]
    report = {
        "mode": mode,
        "instance_id": manifest["instance_id"],
        "anchor": manifest.get("anchor"),
        "delta_days": manifest.get("delta_days"),
        "checks": len(results),
        "failed": [{"check": name, "detail": detail} for name, _ok, detail in failed],
        "seed_findings": manifest.get("seed_findings", []),
        "mapping_entries": len(mapping),
    }
    (root / "status.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    return report


@command("status")
def _cmd_status(args) -> None:
    report = status(args.mode)
    print(
        f"stand {args.mode}: {report['checks']} checks, {len(report['failed'])} failed (anchor {report['anchor']}, Δ {report['delta_days']} d)"
    )
    for failure in report["failed"]:
        print(f"  FAIL {failure['check']}: {failure['detail']}")
    if report["failed"]:
        raise StandError(f"{len(report['failed'])} check(s) failed; see {expected_root(args.mode) / 'status.json'}")


# ── B4 / B5 / smoke ───────────────────────────────────────────────────────────


def content_dump(client, mapping: dict) -> dict:
    """B4: the seeded content by stable keys — names, codes, counts, states, note lines,
    balances; never a timestamp, a server id beyond its code, a credential or a live figure."""
    out: dict[str, dict] = {}

    def line_view(ln: dict) -> dict:
        return {
            k: ln.get(k)
            for k in (
                "product_name",
                "quantity",
                "mode",
                "from_finished",
                "from_kit_units",
                "assembled",
                "received",
                "issued",
                "written_off",
                "held",
            )
        }

    for key, entry in sorted(mapping.items()):
        sid = entry.get("id")
        if sid is None:
            out[key] = {k: v for k, v in entry.items() if k != "id"}
            continue
        kind = key.split(":")[0] if not key.startswith("edge:") else key.split(":")[1][:1]
        if key.startswith("order:") or (key.startswith("edge:Q") and key.count(":") <= 2 and "line" not in key):
            o = client.get(f"/api/v1/projects/{sid}")
            out[key] = {
                "code": o["code"],
                "name": o["name"],
                "status": o["status"],
                "stage": o.get("stage"),
                "lines": [line_view(ln) for ln in o["lines"]],
            }
        elif key.startswith("fin:") or key.startswith("edge:S1:item:"):
            i = client.get(f"/api/v1/stock/items/{sid}")
            out[key] = {k: i.get(k) for k in ("code", "on_hand", "reserved", "min_qty", "location")}
        elif key.startswith("doc:") or key.startswith("agreed:") or key.startswith("edge:N1:note"):
            n = client.get(f"/api/v1/stock-issues/{sid}")
            out[key] = {
                "code": n["code"],
                "lines": [(ln["product_name"], ln.get("sku"), ln["quantity"]) for ln in n["lines"]],
            }
        elif key.startswith("product:") or key in ("edge:P1", "edge:P2", "edge:P3", "edge:S1", "edge:Q4"):
            p = client.get(f"/api/v1/products/{sid}")
            balances = client.get(f"/api/v1/products/{sid}/stock")["balances"]
            out[key] = {
                "code": p.get("code"),
                "name": p["name"],
                "sku": p.get("sku"),
                "status": p.get("status"),
                "parts": [(pt["name"], pt["kind"], pt["qty_per_unit"]) for pt in p.get("parts", [])],
                "shelf": sorted((b["name"], b["balance"]) for b in balances),
            }
        elif key.startswith("customer:") or key.startswith("edge:C1:"):
            if key == "edge:C1:method":
                continue
            cu = client.get(f"/api/v1/customers/{sid}")
            out[key] = {
                "code": cu.get("code"),
                "name": cu["name"],
                "contacts": [ct.get("name") for ct in cu.get("contacts", [])],
            }
        else:
            out[key] = {"code": entry.get("code")} if entry.get("code") else {"kind": kind}
    return out


def _reads(client, manifest: dict) -> int:
    """What the Workshop pages ask for (F3's surfaces), read without writing."""
    import urllib.request

    paths = [
        "/api/v1/projects?page=1&per_page=24",
        "/api/v1/projects/summary",
        "/api/v1/projects?page=1&per_page=24",
        "/api/v1/products?page=1&per_page=24",
        "/api/v1/customers?page=1&per_page=24",
        "/api/v1/customers/summary",
        "/api/v1/stock/figures",
        "/api/v1/stock/items?mode=all&page=1",
        "/api/v1/stock?page=1",
        "/api/v1/stock/journal?book=both",
        "/api/v1/stock-issues/?page=1",
        "/api/v1/projects/forecast",
    ]
    orders = [
        o
        for status in ("active", "completed", "cancelled")
        for o in client.get(f"/api/v1/projects?page=1&per_page=200&status={status}").get("items", [])
    ]
    for order in orders:
        oid = order["id"]
        paths += [
            f"/api/v1/projects/{oid}",
            f"/api/v1/projects/{oid}/queue",
            f"/api/v1/projects/{oid}/timeline",
            f"/api/v1/projects/{oid}/fulfilment",
            f"/api/v1/projects/{oid}/forecast",
        ]
    n = 0
    for path in paths:
        try:
            client.get(path)
        except ApiRefusal:
            pass  # a refusal is an answer; what matters is that nothing was written
        n += 1
    for page in ("/projects", "/products", "/customers", "/stock"):
        with urllib.request.urlopen(f"http://127.0.0.1:{manifest['ports']['vite']}{page}", timeout=30):
            n += 1
    return n


def _tree_hash(path: Path) -> str:
    import hashlib

    digest = hashlib.sha256()
    for file in sorted(p for p in path.rglob("*") if p.is_file()):
        digest.update(str(file.relative_to(path)).encode())
        digest.update(file.read_bytes())
    return digest.hexdigest()


@command("verify")
def _cmd_verify(args) -> None:
    import snapshot

    root = check_root(expected_root(args.mode), mode=args.mode)
    manifest = read_manifest(root)
    if args.snapshot:
        taken = snapshot.take(Path(manifest["database"]))
        Path(args.snapshot).write_text(json.dumps(taken, ensure_ascii=False, default=str), encoding="utf-8")
        print(json.dumps({"snapshot": args.snapshot, "tables": len(taken)}))
    if args.dump:
        mapping = json.loads((root / "mapping.json").read_text(encoding="utf-8"))
        dumped = content_dump(logged_in_client(root, manifest), mapping)
        Path(args.dump).write_text(json.dumps(dumped, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
        print(json.dumps({"dump": args.dump, "entries": len(dumped)}))


def smoke(mode: str, *, wait_seconds: int = 180) -> dict:
    """B4 + B5 + the guard, end to end (plan step 11)."""
    import tempfile
    import time

    import snapshot

    report: dict = {"mode": mode}
    sentinel = Path(tempfile.mkdtemp(prefix="ws13-sentinel-"))
    (sentinel / "data").mkdir()
    (sentinel / "data" / "bamdude.db").write_bytes(b"sentinel: a foreign DATA_DIR the stand must never touch\n")
    before_sentinel = _tree_hash(sentinel)
    saved = {k: os.environ.get(k) for k in ("DATA_DIR", "LOG_DIR", "TEMP_DIR", "BACKEND_URL")}
    os.environ.update(
        DATA_DIR=str(sentinel / "data"),
        LOG_DIR=str(sentinel / "logs"),
        TEMP_DIR=str(sentinel / "tmp"),
        BACKEND_URL="http://192.0.2.99:1",
    )
    try:
        dumps = []
        for round_ in (1, 2):
            root = expected_root(mode)
            if read_manifest(root).get("processes") and live_processes(read_manifest(root)):
                down(mode)
            with lock(mode):
                reset(mode)
            up(mode)
            seed(mode)
            manifest = read_manifest(root)
            client = logged_in_client(root, manifest)
            dumps.append(content_dump(client, json.loads((root / "mapping.json").read_text(encoding="utf-8"))))
            if round_ == 1:
                first = snapshot.take(Path(manifest["database"]))
                report["reads"] = _reads(client, manifest)
                time.sleep(wait_seconds)
                second = snapshot.take(Path(manifest["database"]))
                diffs = snapshot.compare(first, second)
                report["b5_tables"] = len(first)
                report["b5_rows"] = sum(len(rows) for rows in first.values())
                report["b5_diffs"] = diffs[:20]
                report["network_log"] = (root / "run" / "network.log").exists()
                report["spawn_log"] = (root / "run" / "spawn.log").exists()
                down(mode)
        report["b4_equal"] = dumps[0] == dumps[1]
        if not report["b4_equal"]:
            report["b4_diff_keys"] = sorted(
                k for k in set(dumps[0]) | set(dumps[1]) if dumps[0].get(k) != dumps[1].get(k)
            )[:20]
        report["sentinel_untouched"] = _tree_hash(sentinel) == before_sentinel
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    report["ok"] = (
        not report.get("b5_diffs")
        and not report.get("network_log")
        and not report.get("spawn_log")
        and report.get("b4_equal")
        and report.get("sentinel_untouched")
    )
    (expected_root(mode) / "smoke.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    return report


@command("smoke")
def _cmd_smoke(args) -> None:
    report = smoke(args.mode)
    print(json.dumps({k: v for k, v in report.items() if k != "b5_diffs"}, ensure_ascii=False))
    for diff in report.get("b5_diffs") or []:
        print(f"  B5 {diff['change']} {diff['table']} {diff['key']}: {diff.get('fields') or ''}")
    if not report["ok"]:
        raise StandError("smoke failed")


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=sorted(COMMANDS))
    parser.add_argument("--mode", choices=sorted(MODES), default="baseline")
    parser.add_argument("--dump", metavar="FILE")
    parser.add_argument("--snapshot", metavar="FILE")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        # Line by line: a long seed or smoke written to a file shows its progress as it goes.
        stream.reconfigure(encoding="utf-8", line_buffering=True)
    try:
        COMMANDS[args.command](args)
    except StandError as exc:
        print(f"stand: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
