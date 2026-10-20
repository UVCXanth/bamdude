"""Installation-local crash latch. A clean marker is evidence, never a timer.

The lifespan owns the OS lock; resume persists its receipt before admitting work.
Database backup/restore does not own this operational state.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4

from backend.app.services.filament_routing import RoutingDeferred
from backend.app.services.render_runtime import _try_lock, _unlock

logger = logging.getLogger(__name__)
_manual_service = ContextVar("farm_manual_service", default=False)
_admitted_generation = ContextVar("farm_admitted_generation", default=None)
_power_generation = ContextVar("farm_power_generation", default=None)
_cooling_control = ContextVar("farm_cooling_control", default=False)
_command_tasks: set[asyncio.Task] = set()


class FarmStartupRefused(RoutingDeferred):
    disposition = "retry_later"


def _now():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def manual_service_control():
    """Server-only provenance for typed controls, never arbitrary G-code/macros."""
    token = _manual_service.set(True)
    try:
        yield
    finally:
        _manual_service.reset(token)


def manual_control(function):
    """Only typed HTTP controls use this decorator. Never decorate raw macro/G-code."""
    from functools import wraps

    @wraps(function)
    async def wrapped(*args, **kwargs):
        with manual_service_control():
            return await function(*args, **kwargs)

    return wrapped


def typed_heater(function):
    """Cooling is always available; raising a target needs current provenance."""
    from functools import wraps

    @wraps(function)
    def wrapped(self, target, *args, **kwargs):
        cooling = int(target) <= 0
        if not cooling and not _manual_service.get():
            farm_startup_guard.require(getattr(self, "_farm_printer_id", None))
        token = _cooling_control.set(cooling)
        try:
            return function(self, target, *args, **kwargs)
        finally:
            _cooling_control.reset(token)

    return wrapped


def power_on_allowed():
    guard = farm_startup_guard
    return (not guard.active or (not guard.stopping and not guard.storage_error)) and (
        _manual_service.get() or guard.allowed(generation=_power_generation.get())
    )


def guarded_power_on(function):
    """All plug drivers share the same admission and owned command lifetime."""
    from functools import wraps

    from backend.app.services.preview_artifacts import owned

    @wraps(function)
    async def wrapped(*args, **kwargs):
        if not power_on_allowed():
            return False
        token = _power_generation.set(farm_startup_guard.generation)
        try:
            task = asyncio.create_task(function(*args, **kwargs))
            _command_tasks.add(task)
            try:
                return await owned(task)
            finally:
                _command_tasks.discard(task)
        finally:
            _power_generation.reset(token)

    return wrapped


def owned_power_off(function):
    """OFF is available to the operator, but its I/O must also end before clean."""
    from functools import wraps

    from backend.app.services.preview_artifacts import owned

    @wraps(function)
    async def wrapped(self, plug, *args, **kwargs):
        if farm_startup_guard.active and not _manual_service.get() and getattr(plug, "controls_printer_power", False):
            printer_id = getattr(plug, "printer_id", None)
            if printer_id and not farm_startup_guard.printer_ready(printer_id):
                return False
        task = asyncio.create_task(function(self, plug, *args, **kwargs))
        _command_tasks.add(task)
        try:
            return await owned(task)
        finally:
            _command_tasks.discard(task)

    return wrapped


async def drain_commands():
    from backend.app.services.preview_artifacts import owned

    if _command_tasks:
        await owned(asyncio.gather(*tuple(_command_tasks), return_exceptions=True))


def track_command_io(future):
    """A timed-out FTP executor still owns its wire until the thread ends."""
    if farm_startup_guard.active:
        _command_tasks.add(future)
        future.add_done_callback(_command_tasks.discard)
    return future


class FarmStartupGuard:
    def __init__(self):
        self._mutex = threading.RLock()
        self._lock_file = None
        self.path: Path | None = None
        self.state: dict = {}
        self.active = False
        self.ready = False
        self.stopping = False
        self.storage_error = False
        self.readiness_failed = False
        self.generation = 0
        self._printers: dict[int, tuple[int | None, bool]] = {}
        self._printer_owners: dict[int, int] = {}

    def _write(self, state):
        fd, filename = tempfile.mkstemp(prefix="state-", suffix=".tmp", dir=self.path.parent)
        temporary = Path(filename)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(state, handle, ensure_ascii=True)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
            if os.name != "nt":
                fd = os.open(self.path.parent, os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _valid(value):
        if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
            return False
        if value.get("lifecycle") not in ("running", "clean") or not isinstance(value.get("boot_id"), str):
            return False
        if "hold" not in value:
            return False
        reasons = {"unclean_shutdown", "previous_run_unknown", "restore"}
        try:
            UUID(value["boot_id"])
            hold = value["hold"]
            if hold is not None:
                if not isinstance(hold, dict) or hold.get("reason") not in reasons:
                    return False
                UUID(hold["id"])
                if datetime.fromisoformat(hold["since"]).tzinfo is None:
                    return False
            ack = value.get("last_ack")
            if ack is not None:
                if (
                    not isinstance(ack, dict)
                    or ack.get("reason") not in reasons
                    or not isinstance(ack.get("actor"), str)
                ):
                    return False
                UUID(ack["boot_id"])
                UUID(ack["hold_id"])
                if datetime.fromisoformat(ack["at"]).tzinfo is None:
                    return False
            return True
        except (KeyError, TypeError, ValueError, AttributeError):
            return False

    def start(self, data_dir: Path):
        with self._mutex:
            if self._lock_file is not None:
                raise FarmStartupRefused("owner_alive")
            self.active = True
            self.ready = False
            self.stopping = False
            self.storage_error = False
            self.readiness_failed = False
            self._printers.clear()
            self._printer_owners.clear()
            self.generation += 1
            self.path = Path(data_dir) / "runtime-state" / "farm-startup" / "state.json"
            try:
                for directory in (
                    self.path.parent.parent,
                    self.path.parent,
                    self.path,
                    self.path.parent / "owner.lock",
                ):
                    if directory.is_symlink() or directory.is_junction():
                        raise OSError("operational state must not follow links")
                self.path.parent.mkdir(parents=True, exist_ok=True)
                handle = (self.path.parent / "owner.lock").open("a+b")
                try:
                    if not _try_lock(handle):
                        raise FarmStartupRefused("owner_alive")
                except BaseException:
                    handle.close()
                    raise
                self._lock_file = handle
                try:
                    previous = json.loads(self.path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    previous = None
                valid = self._valid(previous)
                hold = previous.get("hold") if valid else None
                if hold is None and (not valid or previous["lifecycle"] != "clean"):
                    hold = {
                        "id": str(uuid4()),
                        "since": _now(),
                        "reason": "unclean_shutdown" if valid else "previous_run_unknown",
                    }
                state = {
                    "version": 1,
                    "boot_id": str(uuid4()),
                    "lifecycle": "running",
                    "hold": hold,
                    "last_ack": previous.get("last_ack") if valid else None,
                }
                self._write(state)
                self.state = state
                logger.info("Farm startup: state=%s boot=%s", "held" if hold else "starting", state["boot_id"])
            except FarmStartupRefused:
                raise
            except OSError:
                self.storage_error = True
                logger.error("Farm startup: storage_unavailable; automation remains closed")

    def mark_ready(self):
        with self._mutex:
            if not self.stopping and not self.storage_error and not self.readiness_failed:
                self.ready = True

    def close_admission(self):
        with self._mutex:
            self.stopping = True
            self.ready = False
            self.generation += 1

    def allowed(self, printer_id=None, *, generation=None):
        with self._mutex:
            # Unconfigured library/CLI use has no command producers. The ASGI
            # owner activates the guard before registering any callbacks.
            if not self.active:
                return True
            if generation is not None and generation != self.generation:
                return False
            if not self.ready or self.stopping or self.storage_error or self.state.get("hold"):
                return False
            return printer_id is None or self._printers.get(printer_id, (None, False))[1]

    def require(self, printer_id=None, *, generation=None):
        if generation is None:
            generation = _admitted_generation.get()
        if not self.allowed(printer_id, generation=generation):
            raise FarmStartupRefused("farm_recovery_hold")

    @contextmanager
    def publication(self, packet, printer_id=None):
        """Check and publish synchronously under the same process mutex.

        Incoming telemetry and bookkeeping are unaffected. Arbitrary G-code
        is never classified by its contents: only a typed server control may
        explicitly carry manual provenance.
        """
        with self._mutex:
            command = packet.get("print", {}) if isinstance(packet, dict) else {}
            name = command.get("command")
            unsafe = name in {"project_file", "gcode_file", "calibration", "extrusion_cali", "resume", "gcode_line"}
            unsafe |= name == "ams_filament_drying" and command.get("mode", 1) != 0
            unsafe |= name == "ams_control" and command.get("param") == "resume"
            # HMS ignore can resume a paused firmware job as well.
            unsafe |= name in {"hms_resume", "hms_ignore", "ignore"}
            heaters = {"set_bed_temp": "temp", "set_nozzle_temp": "target_temp", "set_ctt": "ctt_val"}
            if name in heaters:
                try:
                    unsafe |= float(command.get(heaters[name], 0)) > 0
                except (TypeError, ValueError):
                    unsafe = True
            manual = _manual_service.get() and name in {"gcode_line", "ams_filament_drying", *heaters}
            cooling = _cooling_control.get() and name == "gcode_line"
            if self.active and unsafe and not cooling and not (manual and not self.stopping and not self.storage_error):
                self.require(printer_id)
            yield

    def register_printer_owner(self, printer_id, owner):
        with self._mutex:
            self._printer_owners[printer_id] = owner
            self._printers[printer_id] = (None, False)

    def printer_connecting(self, printer_id, generation, *, owner=None):
        with self._mutex:
            if owner is not None and self._printer_owners.get(printer_id) != owner:
                return
            self._printers[printer_id] = (generation, False)

    def printer_disconnected(self, printer_id, generation):
        with self._mutex:
            if self._printers.get(printer_id, (None, False))[0] == generation:
                self._printers[printer_id] = (generation, False)

    def printer_reconciled(self, printer_id, generation):
        with self._mutex:
            if self._printers.get(printer_id) == (generation, False):
                self._printers[printer_id] = (generation, True)

    def printer_ready(self, printer_id):
        """Telemetry/reconciliation evidence, independently of a global latch."""
        with self._mutex:
            return not self.active or self._printers.get(printer_id, (None, False))[1]

    def hold(self, reason):
        with self._mutex:
            self.generation += 1
            if not self.active:
                return
            state = deepcopy(self.state)
            # A new restore is a new review boundary, even when another hold
            # already exists. A dialog opened before it cannot release it.
            state["hold"] = {"id": str(uuid4()), "since": _now(), "reason": reason}
            try:
                self._write(state)
            except OSError as exc:
                self.storage_error = True
                raise FarmStartupRefused("storage_unavailable") from exc
            self.state = state

    def status(self):
        with self._mutex:
            hold = self.state.get("hold") or {}
            state = (
                "storage_unavailable"
                if self.storage_error
                else (
                    "stopping"
                    if self.stopping
                    else "starting"
                    if self.active and not self.ready
                    else "held"
                    if hold
                    else "running"
                )
            )
            return {
                "state": state,
                "boot_id": self.state.get("boot_id"),
                "hold_id": hold.get("id"),
                "reason": hold.get("reason"),
                "since": hold.get("since"),
                "ready": self.ready,
                "can_resume": self.ready and bool(hold) and not self.storage_error and not self.stopping,
            }

    def resume(self, boot_id, hold_id, *, actor):
        with self._mutex:
            if self.storage_error:
                raise FarmStartupRefused("storage_unavailable")
            if not self.ready or self.stopping:
                raise FarmStartupRefused("not_ready")
            if boot_id != self.state.get("boot_id"):
                raise FarmStartupRefused("stale")
            current = self.state.get("hold")
            if current is None:
                ack = self.state.get("last_ack") or {}
                if hold_id and ack.get("boot_id") == boot_id and ack.get("hold_id") == hold_id:
                    return "already_released"
                raise FarmStartupRefused("stale")
            if hold_id != current["id"]:
                raise FarmStartupRefused("stale")
            state = deepcopy(self.state)
            state["hold"] = None
            state["last_ack"] = {
                "actor": actor,
                "at": _now(),
                "boot_id": boot_id,
                "hold_id": hold_id,
                "reason": current["reason"],
            }
            try:
                self._write(state)
            except OSError as exc:
                raise FarmStartupRefused("storage_unavailable") from exc
            self.state = state
            self.generation += 1
            logger.info("Farm startup: released boot=%s hold=%s actor=%s", boot_id, hold_id, actor)
            return "released"

    def finish(self, *, clean):
        with self._mutex:
            self.close_admission()
            try:
                if clean and not self.storage_error and not self.readiness_failed and self.state:
                    state = {**self.state, "lifecycle": "clean"}
                    self._write(state)
                    self.state = state
            finally:
                if self._lock_file is not None:
                    _unlock(self._lock_file)
                    self._lock_file.close()
                    self._lock_file = None


farm_startup_guard = FarmStartupGuard()


class FarmReadyMiddleware:
    """Open the technical barrier only after the ASGI server receives startup.complete."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "lifespan":
            return await self.app(scope, receive, send)

        async def ready_send(message):
            await send(message)
            if message["type"] == "lifespan.startup.complete":
                farm_startup_guard.mark_ready()

        return await self.app(scope, receive, ready_send)
