"""Serve the stand (spec A4–A6): ``python stand_serve.py --port 8100``.

Started by ``stand.py up`` with the stand's environment. Runs uvicorn on a
SelectorEventLoop — on Windows uvicorn's asyncio loop is the Proactor, whose
``ConnectEx`` raises no ``socket.connect`` audit event and would hide an
outbound connection from the guard. Listens on loopback only.

Stops cleanly when ``run/stop`` appears: ``stand.py down`` creates it, so the
application's shutdown (the stand lifespan's ``engine.dispose()``) runs instead
of the process being killed.
"""

import argparse
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # the repository: `backend` is imported from it

import stand_app  # noqa: E402 — installs the guard before the application is imported
import uvicorn  # noqa: E402


async def _watch_stop(server: uvicorn.Server, stop_file: Path) -> None:
    while not server.should_exit:
        if stop_file.exists():
            server.should_exit = True
            return
        await asyncio.sleep(0.5)


async def _serve(port: int) -> None:
    stop_file = Path(os.environ["WS13_STAND_ROOT"]) / "run" / "stop"
    stop_file.unlink(missing_ok=True)
    config = uvicorn.Config(stand_app.app, host="127.0.0.1", port=port, loop="none", lifespan="on", log_level="info")
    server = uvicorn.Server(config)
    watcher = asyncio.create_task(_watch_stop(server, stop_file))
    try:
        await server.serve()
    finally:
        watcher.cancel()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    asyncio.run(_serve(args.port), loop_factory=asyncio.SelectorEventLoop)


if __name__ == "__main__":
    main()
