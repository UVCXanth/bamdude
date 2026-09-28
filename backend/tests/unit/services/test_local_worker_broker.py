"""The broker's nats-server dies with BamDude, however BamDude ends.

A hard stop (a closed console, taskkill, a crash) runs no shutdown code, so a
child that is not tied to its owner outlives it — and the orphan holds the
broker's lifetime lease, so every later start refused to recover: preview, 3MF
analysis and the library file service all stayed down. On Windows the child is
placed in a kill-on-close Job Object the BamDude process owns; the kernel closes
that handle when the process ends, and the child goes with it.
"""

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from backend.app.services.local_worker_broker import LocalWorkerBroker

REPO = Path(__file__).resolve().parents[4]

_OWNER = """
import asyncio, sys
from pathlib import Path
from backend.app.services.local_worker_broker import LocalWorkerBroker

async def main():
    broker = LocalWorkerBroker(Path(sys.argv[1]))
    await broker.start()
    print(broker.server.pid, flush=True)
    await asyncio.sleep(3600)

asyncio.run(main())
"""


def _alive(pid: int) -> bool:
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        return code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object containment")
@pytest.mark.asyncio
async def test_a_hard_stopped_owner_takes_its_broker_along_and_the_next_start_recovers(tmp_path):
    root = tmp_path / ".cache" / "preview-service"
    owner = subprocess.Popen(
        [sys.executable, "-c", _OWNER, str(root)],
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    child = None
    try:
        child = int(owner.stdout.readline().strip())
        assert _alive(child)
        owner.kill()  # TerminateProcess: no shutdown code runs, as with taskkill /F
        owner.wait(timeout=10)
        deadline = time.monotonic() + 10
        while _alive(child) and time.monotonic() < deadline:
            time.sleep(0.1)
        assert not _alive(child), "nats-server outlived its hard-stopped owner"

        # The next start finds the abandoned generation and recovers it itself.
        broker = LocalWorkerBroker(root)
        await broker.start()
        try:
            assert broker.server.recovered_generation
        finally:
            await broker.stop()
    finally:
        if owner.poll() is None:
            owner.kill()
        if child is not None and _alive(child):
            subprocess.run(["taskkill", "/F", "/PID", str(child)], capture_output=True, check=False)
