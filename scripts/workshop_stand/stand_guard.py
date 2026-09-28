"""The stand's network and process guard (spec A5).

An audit hook that refuses every connection and name lookup that is not
loopback, and every process spawn, and writes each attempt to
``run/network.log`` / ``run/spawn.log``. Installed before the application is
imported; an audit hook cannot be removed, so it lives for the whole process.

⚠️ It sees ``socket.connect`` only on loops that call it: Windows'
ProactorEventLoop connects through ``ConnectEx`` and raises no audit event, so
the stand server runs on a SelectorEventLoop (``stand_serve.py``).
"""

from __future__ import annotations

import ipaddress
import sys
import threading
import time
import traceback
from pathlib import Path

INSTALLED_BEFORE_APP: bool | None = None

_SPAWN_EVENTS = {
    "subprocess.Popen",
    "os.system",
    "os.posix_spawn",
    "os.spawn",
    "os.exec",
    "os.startfile",
    "_winapi.CreateProcess",
}
_LOOPBACK_NAMES = {"localhost", "localhost.", "ip6-localhost"}
_state = threading.local()


def _is_loopback(host) -> bool:
    if host is None:
        return True  # getaddrinfo(None, port) resolves the local wildcard, never a remote host
    if isinstance(host, bytes):
        host = host.decode(errors="replace")
    host = str(host).strip("[]").split("%", 1)[0]
    if host.lower() in _LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def install(run_dir: str | Path) -> None:
    """Install the hook; attempts are logged under ``run_dir``."""
    global INSTALLED_BEFORE_APP
    run = Path(run_dir)
    run.mkdir(parents=True, exist_ok=True)
    network_log = run / "network.log"
    spawn_log = run / "spawn.log"
    INSTALLED_BEFORE_APP = "backend.app.main" not in sys.modules

    def record(path: Path, line: str) -> None:
        stack = "".join(traceback.format_stack(limit=12)[:-3])
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {line}\n{stack}\n")

    def hook(event: str, args: tuple) -> None:
        if getattr(_state, "busy", False):
            return
        blocked = None
        if event in ("socket.connect", "socket.sendto", "socket.sendmsg"):
            address = args[1] if len(args) > 1 else None
            if isinstance(address, tuple) and address and not _is_loopback(address[0]):
                blocked = (network_log, f"{event} {address!r}")
        elif event == "socket.getaddrinfo":
            host = args[0] if args else None
            if not _is_loopback(host):
                blocked = (network_log, f"{event} {host!r}")
        elif event in _SPAWN_EVENTS:
            blocked = (spawn_log, f"{event} {str(args)[:300]}")
        if blocked is None:
            return
        _state.busy = True
        try:
            record(*blocked)
        finally:
            _state.busy = False
        raise PermissionError(f"WS-13 stand: {blocked[1]} blocked — the stand makes no outbound calls")

    sys.addaudithook(hook)
