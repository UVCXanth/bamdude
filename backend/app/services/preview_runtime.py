"""Lifespan-owned, local-only broker/service and bounded preview admission."""

from __future__ import annotations

import asyncio
import logging
import secrets
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from backend.app.schemas.system import PreviewHealth
from backend.app.services.preview_arbiter import Arbiter
from backend.app.services.preview_artifacts import (
    Revoked,
    close_transfer,
    describe,
    disk,
    get,
    owned,
    put,
    snapshot,
)
from backend.app.services.preview_process import PreviewProcess
from backend.app.services.preview_protocol import (
    ACTIVE_SECONDS,
    ATTEMPT_BYTES,
    BUCKET_BYTES,
    C_CANCEL_SECONDS,
    CAD_KINDS,
    CONTROL_SECONDS,
    KINDS,
    OUTCOMES,
    QUARANTINE_ATTEMPTS,
    QUEUE_LIMIT,
    QUEUE_SECONDS,
    STAGES,
    STAGING_BYTES,
    STARTUP_SECONDS,
    TTL_SECONDS,
    VERSION,
    Artifact,
    Command,
    PreviewError,
    decode,
    encode,
    proves_end,
    remaining,
)
from backend.app.services.worker_staging import (
    abandoned_attempts,
    cleanup_owned,
    quarantine_owned,
    quarantine_usage,
    reclaim_quarantine,
    retained_entries,
)

logger = logging.getLogger(__name__)
RECOVERY_GUIDE = "https://docs.bamdude.top/reference/troubleshooting/#local-preview-service"
# A sliced (high) waiter may have to wait for an active STEP's revoke, cancel proof and cleanup: its own finite
# budget is C_cancel plus the normal admission wait, counted once (never extended per poll). Spec §4.2.
HIGH_WAIT_SECONDS = C_CANCEL_SECONDS + QUEUE_SECONDS
PRIORITY_BY_KIND = {"sliced": "high", "mesh": "normal", "step": "low"}


@dataclass
class PreviewResult:
    outcome: str = "unavailable"
    files: dict[str, Path] = field(default_factory=dict)
    input_digests: dict[str, str] = field(default_factory=dict)
    attempt_id: str | None = None
    kind: str | None = None  # "sliced" | "step" | "mesh", from the input ROLES
    stage: str | None = None  # the last protocol stage a STEP attempt reached (bounded enum, for the parent log)


def _inputs_kind(inputs: dict) -> str:
    if "sliced" in inputs:
        return "sliced"
    mesh = inputs.get("mesh")
    return "step" if mesh and mesh[1] in CAD_KINDS else "mesh"


class PreviewRuntime:
    def __init__(self, root: Path, shared_broker=None, *, app_dir: Path | None = None):
        self.root = root
        self.shared_broker = shared_broker
        # where the STEP bundle lives (<app_dir>/runtime/step-preview), the same root as the part-render Node
        self.app_dir = Path(app_dir) if app_dir else Path(__file__).resolve().parents[3]
        # proven-dead attempts whose staging AV or a lock kept: beside the runtime, never inside active staging
        self.quarantine = self.root.parent / "preview-quarantine"
        # proven-dead attempt dirs whose cleanup AND move failed: reclaimed again at every admission (spec §4.2)
        self._dead_residue: dict[Path, str] = {}
        self.generation = uuid.uuid4().hex
        self.epoch = uuid.uuid4().hex
        self.bucket = f"bamdude_preview_{self.generation}"
        self.broker = self.nc = self.service = self.store = None
        self.ready = False
        self.closed = False
        self.uncertain = False
        self.sequence = 0
        self.waiters = 0
        self.slot = Arbiter()  # one slot; high > normal > low; only high revokes an active low
        self.active_task = None
        self.result_handed_off = False
        self.monitor = None
        self.restarts = []
        self.circuit_until = 0.0
        self.dependency_lost = False
        self.reason = "not_started"
        self.error_type = None
        self._last_staging_issue = None
        self._last_admission_issue = None

    def health(self) -> PreviewHealth:
        """In-memory snapshot only: never probe processes, disk or the broker here."""
        if self.uncertain:
            state, reason = "unavailable", "ownership_uncertain"
        elif self.ready and not self.closed:
            state, reason = "ready", None
        elif self.reason == "starting":
            state, reason = "starting", self.reason
        elif self.reason == "worker_restarting" and not self.closed:
            state = "recovering"
            reason = "circuit_open" if time.monotonic() < self.circuit_until else self.reason
        else:
            state, reason = "unavailable", self.reason
        return PreviewHealth(
            state=state,
            reason=reason,
            error_type=self.error_type,
            runtime_dir=str(self.root),
            recovery_required=reason in {"recovery_required", "ownership_uncertain"},
        )

    def _unavailable(self, reason: str, exc: Exception | None = None):
        self.ready = False
        error_type = type(exc).__name__ if exc else None
        changed = (reason, error_type) != (self.reason, self.error_type)
        self.reason, self.error_type = reason, error_type
        if changed:
            # Do not emit exception text: connection errors may contain credentials.
            logger.warning(
                "Preview unavailable: reason=%s error=%s runtime_dir=%s; API and printing continue. "
                "Inspect installation/disk/logs; for unresolved ownership stop BamDude, verify all preview "
                "processes exited and follow %s. Do not delete the runtime marker blindly.",
                reason,
                error_type or "none",
                self.root,
                RECOVERY_GUIDE,
            )

    async def start(self):
        self.reason = "starting"
        recovery_errors: tuple[type[Exception], ...] = ()
        try:
            import nats
            from embedded_nats import NatsServer, RecoveryRequired
            from nats.js.api import ObjectStoreConfig

            recovery_errors = (RecoveryRequired,)
            self.token = self.shared_broker.token if self.shared_broker else secrets.token_urlsafe(32)
            await disk(self._directories)
            self.broker = self.shared_broker or NatsServer(
                self.root / "broker",
                auth_token=self.token,
                max_file_store="3072MB",
                max_memory_store="64MB",
                max_payload=1024**2,
                startup_timeout=15,
                shutdown_timeout=2,
                recover_stale=True,
            )
            async with asyncio.timeout(STARTUP_SECONDS):
                if not self.shared_broker:
                    await disk(self.broker.start)
                if not self.shared_broker and self.broker.recovered_generation:
                    logger.warning(
                        "Preview broker recovered abandoned generation=%s; runtime_dir=%s. "
                        "Old preview staging is retained until manual ownership verification; see %s",
                        self.broker.recovered_generation,
                        self.root,
                        RECOVERY_GUIDE,
                    )
                self.nc = await nats.connect(
                    self.broker.url,
                    token=self.token,
                    allow_reconnect=False,
                    connect_timeout=CONTROL_SECONDS,
                    closed_cb=self.disconnected,
                )
                js = self.nc.jetstream(timeout=CONTROL_SECONDS)
                # A clean package start proves exclusive store ownership. Old
                # preview buckets are disposable; no other namespaces touched.
                streams = await js.streams_info()
                for stream in streams:
                    if stream.config.name.startswith("OBJ_bamdude_preview_"):
                        await js.delete_stream(stream.config.name)
                # Broker ownership says nothing about an old worker/renderer's
                # disk I/O. Even a later clean restart cannot prove it is gone.
                await disk(self._report_retained_staging)
                self.store = await js.create_object_store(
                    bucket=self.bucket,
                    config=ObjectStoreConfig(
                        bucket=self.bucket, max_bytes=BUCKET_BYTES, ttl=TTL_SECONDS, storage="file"
                    ),
                )
                await self._launch()
            self.monitor = asyncio.create_task(self._monitor(), name="preview-service-monitor")
        except Exception as exc:
            self._unavailable("recovery_required" if isinstance(exc, recovery_errors) else "startup_failed", exc)
            if isinstance(exc, recovery_errors):
                logger.warning(
                    "Preview broker recovery refused: reason=%s marker=%s; follow %s",
                    exc.reason,
                    exc.marker_path or (self.broker.recovery_marker_path if self.broker else None),
                    RECOVERY_GUIDE,
                )
            logger.debug("Preview startup failure", exc_info=True)
            await self.stop()

    def _directories(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.staging = self.root / "staging" / self.generation
        self.staging.mkdir(parents=True, mode=0o700)
        (self.staging / "main").mkdir(mode=0o700)
        (self.staging / "service").mkdir(mode=0o700)

    def _report_retained_staging(self):
        empty = 0
        for directory, classification, reason in retained_entries(self.staging.parent, self.staging, "preview"):
            if classification == "empty_skeleton":
                empty += 1
                logger.debug("Preview staging skeleton retained: path=%s", directory)
            else:
                logger.warning(
                    "Retained preview staging: path=%s classification=%s reason=%s; "
                    "old worker/renderer ownership is unproven; verify owners before manual cleanup; see %s",
                    directory,
                    classification,
                    reason,
                    RECOVERY_GUIDE,
                )
        if empty:
            logger.info("Preview staging empty_skeleton_count=%d; no manual cleanup required", empty)

    def _cleanup_result(self, result, phase: str, attempt: str | None = None):
        if result.status == "retained_error":
            issue = (phase, str(result.path), result.error_type, result.error_code)
            log = logger.warning if issue != self._last_staging_issue else logger.debug
            log(
                "Preview staging_cleanup_failed: phase=%s attempt=%s path=%s error=%s code=%s",
                phase,
                attempt,
                result.path,
                result.error_type,
                result.error_code,
            )
            self._last_staging_issue = issue
        else:
            self._last_staging_issue = None

    async def _quarantine(self, result, path: Path, side: str):
        """After the bounded reclaim failed: move the proven-dead owned attempt dir into quarantine (spec §4.2).
        A refused or failed move keeps the original retained result — the residue stays and blocks admission."""
        moved = await disk(quarantine_owned, path, self.quarantine, self.generation, side)
        if moved.status == "quarantined":
            logger.warning(
                "Preview staging_quarantined: side=%s attempt=%s; counted against the staging limits until reclaimed",
                side,
                path.name,
            )
            return moved
        logger.warning(
            "Preview staging_quarantine_failed: side=%s attempt=%s status=%s error=%s",
            side,
            path.name,
            moved.status,
            moved.error_type,
        )
        return result

    async def _reclaim_dead_residue(self) -> None:
        """Retry, bounded, every proven-dead attempt dir that could neither be removed nor moved — one AV lock must
        not disable previews until a restart. Removed or quarantined entries are forgotten; the rest stay and the
        residue check still refuses admission."""
        for path, side in list(self._dead_residue.items()):
            result = await disk(cleanup_owned, path, deadline=time.monotonic() + 1.0)
            if result.status == "retained_error":
                result = await self._quarantine(result, path, side)
            if result.status in {"removed", "absent", "quarantined"}:
                self._dead_residue.pop(path, None)
                if result.status == "removed":
                    logger.info("Preview staging_residue_reclaimed: side=%s attempt=%s", side, path.name)

    def _service_cleanup_reply(self, reply, attempt_id):
        detail = reply.get("staging_cleanup") if isinstance(reply, dict) else None
        staging = getattr(self, "staging", None)
        owned = (
            isinstance(attempt_id, str) and len(attempt_id) == 32 and all(c in "0123456789abcdef" for c in attempt_id)
        )
        if isinstance(detail, dict) and not detail.get("quarantined") and staging is not None and owned:
            # the service's run is over (it replied after its finally): its attempt dir is dead. The path is rebuilt
            # from the attempt id under this generation's service staging — the reply's own path is only logged.
            self._dead_residue[staging / "service" / attempt_id] = "service"
        if isinstance(detail, dict):
            logger.warning(
                "Preview staging_cleanup_failed: phase=service_attempt attempt=%s path=%s error=%s code=%s",
                attempt_id,
                detail.get("path"),
                detail.get("error"),
                detail.get("code"),
            )

    def _command(self, operation="ready", manifest=(), attempt_id=None, deadline=None, cad=None):
        self.sequence += 1
        return Command(
            VERSION,
            self.generation,
            self.epoch,
            attempt_id or uuid.uuid4().hex,
            self.sequence,
            operation,
            deadline or time.monotonic_ns() + int(CONTROL_SECONDS * 1e9),
            tuple(manifest),
            cad,
        )

    async def _launch(self):
        self.epoch = uuid.uuid4().hex

        async def spawn():
            self.service = await disk(
                PreviewProcess,
                "backend.app.preview_service",
                {
                    "url": self.broker.url,
                    "token": self.token,
                    "bucket": self.bucket,
                    "generation": self.generation,
                    "epoch": self.epoch,
                    "staging": str(self.staging / "service"),
                    "cache": str(self.root / "matplotlib"),
                    # the root the service rebuilds a STEP bundle path under, from the command's key/digest only
                    "app_dir": str(self.app_dir),
                    "quarantine": str(self.quarantine),
                },
                self.root / "matplotlib",
            )

        # Capture ownership even when cancellation lands during Popen/Job attach.
        await owned(spawn())
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if self.service.process.poll() is not None:
                raise PreviewError("unavailable")
            try:
                before = time.monotonic_ns()
                reply = await self._rpc(self._command())
                after = time.monotonic_ns()
                if (
                    reply.get("outcome") == "ok"
                    and reply.get("epoch") == self.epoch
                    and reply.get("protocol_version") == VERSION
                    and before <= reply.get("monotonic_ns", 0) <= after
                ):
                    self.ready = True
                    self.reason = None
                    self.error_type = None
                    return
            except Exception:
                pass
            await asyncio.sleep(0.1)
        raise PreviewError("unavailable")

    async def _rpc(self, command, operation=None, timeout=CONTROL_SECONDS):
        message = await self.nc.request(command.subject, encode(command.wire(operation)), timeout=timeout)
        return decode(message.data)

    async def disconnected(self):
        self.ready = False
        if not self.closed:
            self._unavailable("broker_disconnected")
        if self.active_task:
            self.dependency_lost = True
            if not self.result_handed_off:
                self.active_task.cancel()

    async def _retire(self):
        self.ready = False
        if not self.closed and not self.uncertain and self.reason != "broker_disconnected":
            self.reason = "worker_restarting"
        if self.service:
            retired_epoch = self.epoch
            try:
                await disk(self.service.stop)
            except Exception:
                self.uncertain = True
                self._unavailable("ownership_uncertain")
                raise
            self.service = None
            service_root = self.staging / "service"
            attempts, unknown = await disk(abandoned_attempts, service_root)
            deadline = time.monotonic() + 2.0
            for path in unknown:
                logger.warning(
                    "Preview service residue unknown: generation=%s epoch=%s path=%s",
                    self.generation,
                    retired_epoch,
                    path,
                )
            for path in attempts:
                result = await disk(cleanup_owned, path, deadline=deadline)
                logger.info(
                    "Preview service_residue_after_retire: generation=%s epoch=%s path=%s result=%s",
                    self.generation,
                    retired_epoch,
                    path,
                    result.status,
                )
                self._cleanup_result(result, "service_residue_after_retire", path.name)
                if result.status == "retained_error":  # the service is proven stopped: its attempt may move
                    await self._quarantine(result, path, "service")

    async def _cancel(self, command):
        # Revoke in the caller first. Only a proof of END is accepted (spec §6.1): a cancel_ack after the service
        # reaped its child and joined owned I/O, or a terminal_replay of exactly this command after its run's
        # finally. A timeout the service already reached is such an end — no retirement for it. Anything else
        # (bare outcome, busy, unavailable, an uncertain service, a forged field, no reply in C_cancel) retires.
        if command and self.nc.is_connected:
            try:
                reply = await self._rpc(command, "cancel", timeout=C_CANCEL_SECONDS)
                self._service_cleanup_reply(reply, command.attempt_id)
                if proves_end(command, reply):
                    return
            except Exception:
                pass
        await self._retire()

    async def _monitor(self):
        while not self.closed:
            await asyncio.sleep(0.5)
            if self.service and self.service.process.poll() is None and self.nc.is_connected:
                continue
            self.ready = False
            if self.active_task:
                self.dependency_lost = True
                if not self.result_handed_off:
                    self.active_task.cancel()
                continue
            if self.slot.locked() or self.uncertain:
                continue
            try:
                await self._retire()
            except Exception:
                logger.warning("Preview process ownership uncertain; restart disabled")
                return
            if not self.nc.is_connected:  # Broker recovery happens on the next application start, not in-flight.
                self._unavailable("broker_disconnected")
                return
            self.reason = "worker_restarting"
            now = time.monotonic()
            self.restarts = [x for x in self.restarts if now - x < 60]
            if now < self.circuit_until:
                continue
            if len(self.restarts) >= 3:
                self.circuit_until = now + 60
                continue
            await asyncio.sleep(2 ** len(self.restarts))
            self.restarts.append(time.monotonic())
            try:
                await self._launch()
            except Exception as exc:
                self._unavailable("worker_restarting", exc)
                try:
                    await self._retire()
                except Exception:
                    logger.warning("Preview process ownership uncertain; restart disabled")
                    return

    async def cad_descriptor(self) -> dict | None:
        """Off the loop and without importing OCP: the bundle this code may use, as the closed descriptor the
        command carries. Re-read on every STEP attempt — never a cached negative."""
        from backend.app import step_runtime

        found = await disk(step_runtime.locate, self.app_dir)
        return {"manifest_digest": found.digest, "bundle_key": found.key} if found.ok else None

    async def _run_or_revoke(self, command, ticket, timeout: float) -> dict:
        """The run RPC, raced against this ticket's revoke for a low attempt (spec §4.2). A revoke cancels only the
        reply wait — the service's work is ended by the cancel that follows, with its proof of end."""
        rpc = asyncio.ensure_future(self._rpc(command, timeout=timeout))
        if ticket.priority != "low":
            return await rpc
        waiter = asyncio.ensure_future(ticket.revoked.wait())
        try:
            done, _ = await asyncio.wait({rpc, waiter}, return_when=asyncio.FIRST_COMPLETED)
            if rpc in done:
                return rpc.result()
            raise Revoked
        finally:
            waiter.cancel()
            if not rpc.done():
                rpc.cancel()
            await asyncio.gather(waiter, rpc, return_exceptions=True)

    @asynccontextmanager
    async def attempt(
        self,
        inputs: dict[str, tuple[Path | bytes, str]],
        *,
        deadline: int | None = None,
        priority: str | None = None,
        wait_seconds: float | None = None,
        order: int | None = None,
    ):
        """One owned preview attempt. ``priority`` defaults from the kind (sliced high, STL/OBJ normal, STEP low);
        a revoked low ends as the INTERNAL outcome ``preempted`` (no files, no publication) — its caller requeues it,
        no task was cancelled. ``order`` lets a requeued low keep its first admission order."""
        kind = _inputs_kind(inputs)
        result = PreviewResult(kind=kind)
        priority = priority or PRIORITY_BY_KIND[kind]
        mesh = inputs.get("mesh")
        if mesh and mesh[1] in CAD_KINDS and set(inputs) != {"mesh"}:
            result.outcome = "protocol_error"  # STEP never rides another attempt (refused before any command)
            yield result
            return
        cad = None
        if kind == "step":
            cad = await self.cad_descriptor()
            if cad is None:
                # Nonfatal and local: no slot, no command, the service untouched (spec §6, B1).
                result.outcome = "cad_unavailable"
                logger.info("Preview attempt kind=step outcome=cad_unavailable stage=cad_import (no bundle)")
                yield result
                return
        if not self.ready or self.closed or self.waiters >= QUEUE_LIMIT:
            result.outcome = "busy" if self.ready else "unavailable"
            yield result
            return
        self.waiters += 1
        admitted_epoch = self.epoch
        ticket = None
        if wait_seconds is None:
            wait_seconds = HIGH_WAIT_SECONDS if priority == "high" else QUEUE_SECONDS
        try:
            ticket = await self.slot.acquire(priority, wait_seconds, order=order)
        except TimeoutError:
            result.outcome = "busy"
        finally:
            self.waiters -= 1
        if ticket is None:
            yield result
            return
        attempt_id = uuid.uuid4().hex
        result.attempt_id = attempt_id
        root = self.staging / "main" / attempt_id
        deadline = min(
            deadline or time.monotonic_ns() + int(ACTIVE_SECONDS * 1e9), time.monotonic_ns() + int(ACTIVE_SECONDS * 1e9)
        )
        command = None
        subscription = None
        revoked = False
        canceled = False
        checkpoint_tasks = set()
        transfer_nc = None
        began = time.monotonic()

        async def cleanup():
            if self.store and self.nc.is_connected:
                for role in ("mesh", "sliced", "source_png", "preview", "checkpoint", "output"):
                    try:
                        await self.store.delete(f"{attempt_id}_{role}")
                    except Exception:
                        pass  # bucket TTL bounds interrupted/partial uploads
            if not self.uncertain:
                outcome = await disk(cleanup_owned, root)
                self._cleanup_result(outcome, "main_attempt", attempt_id)  # the failure is always explained
                if outcome.status == "retained_error":
                    moved = await self._quarantine(outcome, root, "main")
                    if moved.status != "quarantined":
                        self._dead_residue[root] = "main"

        try:
            try:
                if not self.ready or self.closed or self.epoch != admitted_epoch:
                    raise PreviewError("unavailable")
                self.active_task = asyncio.current_task()
                self.result_handed_off = False
                self.dependency_lost = False
                # A previous denied cleanup must not accumulate unbounded
                # staging across attempts. No other attempt owns this slot.
                await self._reclaim_dead_residue()
                residue = await disk(lambda: next((p for p in self.staging.rglob("*") if p.is_file()), None))
                if residue is not None:
                    issue = ("admission", str(residue))
                    log = logger.warning if issue != self._last_admission_issue else logger.debug
                    log("Preview staging_residue_blocks_admission: path=%s", residue)
                    self._last_admission_issue = issue
                    raise PreviewError("resource_limit")
                self._last_admission_issue = None
                await disk(reclaim_quarantine, self.quarantine)
                held, count = await disk(quarantine_usage, self.quarantine)
                if held + ATTEMPT_BYTES > STAGING_BYTES or count > QUARANTINE_ATTEMPTS:
                    logger.warning("Preview quarantine_blocks_admission: bytes=%d attempts=%d", held, count)
                    raise PreviewError("resource_limit")
                if ticket.revoke.is_set():
                    raise Revoked
                await disk(root.mkdir)
                manifest = []
                async with asyncio.timeout(remaining(deadline)):
                    import nats

                    transfer_nc = await nats.connect(
                        self.broker.url, token=self.token, allow_reconnect=False, connect_timeout=CONTROL_SECONDS
                    )
                    transfer_store = await transfer_nc.jetstream(timeout=CONTROL_SECONDS).object_store(self.bucket)
                    # Reserve a whole attempt plus metadata headroom. Never evict
                    # live objects to make room; the server's max_age sweeps orphan
                    # chunks as well as completed objects in this private bucket.
                    if (await transfer_store.status()).size + ATTEMPT_BYTES + 1024**2 > BUCKET_BYTES:
                        raise PreviewError("resource_limit")
                    for role, (source, input_kind) in inputs.items():
                        if role not in {"mesh", "sliced", "source_png"} or input_kind not in KINDS:
                            raise PreviewError("protocol_error")
                        path = root / f"{role}.{input_kind}"
                        await disk(snapshot, source, path, deadline, revoke=ticket.revoke)
                        ref = await disk(describe, path, attempt_id, role, input_kind, deadline, revoke=ticket.revoke)
                        manifest.append(ref)
                        result.input_digests[role] = ref.digest
                        if sum(x.size for x in manifest) > ATTEMPT_BYTES:
                            raise PreviewError("resource_limit")
                        await put(transfer_store, path, ref, deadline, revoke=ticket.revoke)
                    command = self._command("run", manifest, attempt_id, deadline, cad)
                    logger.info("Preview attempt start attempt=%s kind=%s", attempt_id, kind)

                    async def receive_files(items):
                        if revoked:
                            raise PreviewError("canceled")
                        refs = [Artifact.parse(item, attempt_id) for item in items]
                        if len({r.role for r in refs}) != len(refs) or any(
                            r.role not in {"preview", "checkpoint", "output"} for r in refs
                        ):
                            raise PreviewError("protocol_error")
                        if sum(x.size for x in [*manifest, *refs]) > ATTEMPT_BYTES:
                            raise PreviewError("resource_limit")
                        for ref in refs:
                            if ref.role in result.files:
                                continue
                            path = root / f"{ref.role}.{ref.kind}"
                            await get(transfer_store, ref, path, deadline, revoke=ticket.revoke)
                            if revoked:
                                raise PreviewError("canceled")
                            result.files[ref.role] = path

                    async def checkpoint_work(message):
                        try:
                            payload = decode(message.data)
                            if payload.get("command") != command.wire("checkpoint-receipt"):
                                raise PreviewError("protocol_error")
                            await receive_files(payload["manifest"])
                            await message.respond(encode({"outcome": "ok"}))
                        except Exception:
                            if self.nc.is_connected:
                                await message.respond(encode({"outcome": "canceled"}))

                    async def checkpoint(message):
                        if checkpoint_tasks or revoked:
                            await message.respond(encode({"outcome": "canceled"}))
                            return
                        task = asyncio.create_task(checkpoint_work(message))
                        checkpoint_tasks.add(task)

                    subscription = await self.nc.subscribe(command.subject + ".checkpoint", cb=checkpoint)
                    await self.nc.flush(timeout=CONTROL_SECONDS)
                    reply = await self._run_or_revoke(command, ticket, remaining(deadline))
                    self._service_cleanup_reply(reply, attempt_id)
                    result.outcome = reply.get("outcome", "protocol_error")
                    if reply.get("stage") in STAGES:
                        result.stage = reply["stage"]
                    if not isinstance(result.outcome, str) or result.outcome not in OUTCOMES:
                        raise PreviewError("protocol_error")
                    if result.outcome in {"unavailable", "timeout", "protocol_error"}:
                        raise PreviewError(result.outcome)
                    if result.outcome == "ok":
                        await receive_files(reply.get("manifest", []))
                        # The point of no return, under the arbiter's gate: a revoke that came first wins, the
                        # ready output is discarded and the attempt ends preempted without any restart.
                        if not self.slot.hand_off(ticket):
                            raise Revoked
                    else:
                        self.slot.hand_off(ticket)  # a service terminal: nothing left to interrupt or requeue
                    self.result_handed_off = True
            except Revoked:
                revoked = True
                result.outcome = "preempted"  # internal: neither a public canceled nor a failure
                result.files.clear()
                if command:
                    try:
                        await owned(self._cancel(command))  # proof of end, or retire
                    except asyncio.CancelledError:
                        canceled = not self.dependency_lost
                    except Exception:
                        self.uncertain = True
            except asyncio.CancelledError:
                revoked = True
                canceled = not self.dependency_lost
                if canceled:
                    result.files.clear()
                result.outcome = "canceled" if canceled else "unavailable"
                try:
                    await owned(self._cancel(command))
                except asyncio.CancelledError:
                    # Broker-loss callbacks may cancel this task again while
                    # the shielded retirement is being joined. The checkpoint
                    # remains usable; this is unavailable, not user cancel.
                    if not self.dependency_lost:
                        canceled = True
                        result.files.clear()
                except Exception:
                    self.uncertain = True
            except Exception as exc:
                revoked = True
                result.outcome = (
                    exc.outcome
                    if isinstance(exc, PreviewError)
                    else ("timeout" if isinstance(exc, TimeoutError) else "unavailable")
                )
                if command and result.outcome in {"unavailable", "timeout", "protocol_error"}:
                    try:
                        await owned(self._cancel(command))
                    except asyncio.CancelledError:
                        if self.dependency_lost:
                            result.outcome = "unavailable"
                        else:
                            canceled = True
                            result.files.clear()
                    except Exception:
                        self.uncertain = True
            finally:

                async def close_transfers():
                    if subscription:
                        try:
                            await subscription.unsubscribe()
                        except Exception:
                            pass  # closing the dead connection already removed it
                    for task in checkpoint_tasks:
                        task.cancel()
                    if checkpoint_tasks:
                        await asyncio.gather(*checkpoint_tasks, return_exceptions=True)
                    if transfer_nc:
                        try:
                            await close_transfer(transfer_nc)
                        except Exception:
                            pass

                try:
                    await owned(close_transfers())
                except asyncio.CancelledError:
                    revoked = True
                    if self.dependency_lost:
                        result.outcome = "unavailable"
                    else:
                        canceled = True
                        result.files.clear()
                        result.outcome = "canceled"
                    try:
                        await owned(self._retire())
                    except BaseException:
                        self.uncertain = True
            if canceled:
                raise asyncio.CancelledError
            # every result is handed to the caller from here: a broker loss no longer cancels the caller's task
            self.result_handed_off = True
            yield result  # main validates/publishes while permit and staging still owned
        finally:

            async def finish():
                try:
                    await cleanup()
                finally:
                    self.active_task = None
                    self.result_handed_off = False
                    if not self.uncertain:
                        self.slot.release(ticket)

            await owned(finish())
            logger.info(
                "Preview attempt=%s kind=%s outcome=%s stage=%s elapsed_ms=%d",
                attempt_id,
                kind,
                result.outcome,
                result.stage,
                (time.monotonic() - began) * 1000,
            )

    async def stop(self):
        self.closed = True
        self.ready = False
        if self.reason in {None, "starting", "worker_restarting", "not_started"}:
            self.reason = "stopped"
        if self.monitor:
            self.monitor.cancel()
            await asyncio.gather(self.monitor, return_exceptions=True)
        if self.active_task and self.active_task is not asyncio.current_task():
            self.active_task.cancel()
            await asyncio.gather(self.active_task, return_exceptions=True)
        try:
            await self._retire()
        except Exception:
            logger.warning("Preview process ownership uncertain; staging retained")
        if self.nc:
            await self.nc.close()
        if self.broker and not self.shared_broker:
            try:
                await disk(self.broker.stop)
            except Exception as exc:
                self._unavailable("recovery_required", exc)
        if not self.uncertain and hasattr(self, "staging") and not self.slot.locked():
            self._cleanup_result(await disk(cleanup_owned, self.staging), "generation")


runtime: PreviewRuntime | None = None


def get_preview_health() -> PreviewHealth:
    return runtime.health() if runtime else PreviewHealth(state="unavailable", reason="not_started")


async def start_preview_runtime(base: Path):
    global runtime
    from backend.app.services.local_worker_broker import start_local_worker_broker

    runtime = PreviewRuntime(base / ".cache" / "preview-service")
    try:
        broker = await start_local_worker_broker(base)
    except Exception as exc:
        from embedded_nats import RecoveryRequired

        runtime._unavailable("recovery_required" if isinstance(exc, RecoveryRequired) else "startup_failed", exc)
        if isinstance(exc, RecoveryRequired):
            logger.warning("Preview broker recovery refused: marker=%s; follow %s", exc.marker_path, RECOVERY_GUIDE)
        return
    runtime.shared_broker = broker
    await runtime.start()


async def stop_preview_runtime():
    global runtime
    if runtime:
        await runtime.stop()
        runtime = None


@asynccontextmanager
async def preview_attempt(inputs, **kwargs):
    if runtime is None:
        yield PreviewResult()
    else:
        async with runtime.attempt(inputs, **kwargs) as result:
            yield result
