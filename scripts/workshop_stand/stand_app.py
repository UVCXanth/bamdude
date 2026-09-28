"""The stand's ASGI app: the real BamDude, with a minimal lifespan (spec A4, A6).

Routes, middleware, auth, the setup gate, services and the database are the
application's own; only ``app.router.lifespan_context`` is replaced. Nothing
BamDude starts in the background runs here — no printer connections, MQTT,
schedulers, dispatch, telemetry, Telegram, Zigbee, backups, cleanups, cloud
link, cameras, preview/analysis/library-file runtimes or backfills — so the
seeded data changes only by explicit commands. Every answer carries
``X-WS13-Stand: <instance>``, which is how the seeder knows it talks to this
instance and nothing else.

The guard is installed before the application is imported.
"""

import os
from contextlib import asynccontextmanager
from pathlib import Path

import stand_guard

stand_guard.install(Path(os.environ["WS13_STAND_ROOT"]) / "run")

from backend.app.main import app as bamdude_app  # noqa: E402

INSTANCE = os.environ["WS13_STAND_INSTANCE"]


@asynccontextmanager
async def stand_lifespan(_app):
    from backend.app import i18n
    from backend.app.core import database

    await database.init_db()
    await i18n.get_language()
    try:
        yield
    finally:
        await database.engine.dispose()


bamdude_app.router.lifespan_context = stand_lifespan


class _Marker:
    """Adds the instance marker to every HTTP response, refusals included."""

    def __init__(self, inner, instance: str):
        self.inner = inner
        self.header = (b"x-ws13-stand", instance.encode())

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.inner(scope, receive, send)
            return

        async def marked(message):
            if message["type"] == "http.response.start":
                message = {**message, "headers": [*message.get("headers", []), self.header]}
            await send(message)

        await self.inner(scope, receive, marked)


app = _Marker(bamdude_app, INSTANCE)
