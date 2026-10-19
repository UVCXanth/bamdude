"""A cancel that meets an already finished attempt proves its end instead of retiring the service (spec §6.1, N1).

The service answers a cancel with a closed proof envelope: ``terminal_replay`` (the exact cached command after its
run's finally) or ``cancel_ack`` (reaped / proven never started). Main accepts only an exact match of generation,
epoch, attempt id, seq and the digest of its own run command; a bare outcome, busy, unavailable, an uncertain service
or a forged field is no proof and still retires.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from pathlib import Path

import pytest

from backend.app.services.preview_protocol import C_CANCEL_SECONDS, CONTROL_SECONDS, VERSION, Command
from backend.app.services.preview_runtime import PreviewRuntime


def run_command(seq=1, attempt=None) -> Command:
    attempt = attempt or uuid.uuid4().hex
    return Command.parse(
        {
            "protocol_version": VERSION,
            "app_generation": "g" * 32,
            "service_epoch": "e" * 32,
            "attempt_id": attempt,
            "attempt_seq": seq,
            "operation": "run",
            "deadline_monotonic_ns": time.monotonic_ns() + int(60e9),
            "manifest": [{"role": "mesh", "key": f"{attempt}_mesh", "kind": "stl", "size": 3, "digest": "a" * 64}],
            "cad": None,
        },
        "g" * 32,
        "e" * 32,
    )


def digest(command: Command) -> str:
    return hashlib.sha256(json.dumps(command.wire("run"), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def proof(command, mode="terminal_replay", **change):
    return {
        "mode": mode,
        "version": VERSION,
        "app_generation": command.app_generation,
        "service_epoch": command.service_epoch,
        "attempt_id": command.attempt_id,
        "attempt_seq": command.attempt_seq,
        "command_digest": digest(command),
        **change,
    }


# --- service side ------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_service_replays_a_cached_terminal_as_proof_of_end():
    from backend.app.preview_service import Service

    service = Service({"generation": "g" * 32, "epoch": "e" * 32})
    command = run_command()
    service.highwater = command.attempt_seq
    service.remember(command, {"outcome": "timeout"})
    cancel = Command(**{**command.__dict__, "operation": "cancel"})
    reply = await service.command(cancel)
    assert reply["outcome"] == "timeout"
    assert reply["proof"] == proof(command)


@pytest.mark.asyncio
async def test_an_uncertain_service_gives_no_proof():
    from backend.app.preview_service import Service

    service = Service({"generation": "g" * 32, "epoch": "e" * 32})
    command = run_command()
    service.highwater = command.attempt_seq
    service.remember(command, {"outcome": "timeout"})
    service.uncertain = True
    reply = await service.command(Command(**{**command.__dict__, "operation": "cancel"}))
    assert "proof" not in reply


@pytest.mark.asyncio
async def test_a_never_started_cancel_is_acked_and_an_evicted_one_too_unless_uncertain():
    from backend.app.preview_service import Service

    service = Service({"generation": "g" * 32, "epoch": "e" * 32})
    fresh = run_command(seq=5)
    reply = await service.command(Command(**{**fresh.__dict__, "operation": "cancel"}))
    assert reply["outcome"] == "canceled" and reply["proof"]["mode"] == "cancel_ack"
    evicted = run_command(seq=2)  # <= highwater, never cached here
    reply = await service.command(Command(**{**evicted.__dict__, "operation": "cancel"}))
    assert reply["outcome"] == "canceled" and reply["proof"]["mode"] == "cancel_ack"
    service.uncertain = True
    reply = await service.command(Command(**{**run_command(seq=3).__dict__, "operation": "cancel"}))
    assert "proof" not in reply


@pytest.mark.asyncio
async def test_a_replay_is_never_given_for_another_command_sharing_the_seq():
    from backend.app.preview_service import Service
    from backend.app.services.preview_protocol import PreviewError

    service = Service({"generation": "g" * 32, "epoch": "e" * 32})
    command = run_command(seq=4)
    service.highwater = 4
    service.remember(command, {"outcome": "ok", "manifest": []})
    other = run_command(seq=4)  # same seq, another attempt
    with pytest.raises(PreviewError):
        await service.command(Command(**{**other.__dict__, "operation": "cancel"}))


# --- main side ---------------------------------------------------------------------------------------------------


def runtime_with(tmp_path, reply_or_exc, delay=0.0):
    runtime = PreviewRuntime(tmp_path / "rt")
    runtime.generation, runtime.epoch = "g" * 32, "e" * 32
    seen = {}

    class _NC:
        is_connected = True

    runtime.nc = _NC()

    async def rpc(command, operation=None, timeout=CONTROL_SECONDS):
        seen["timeout"] = timeout
        await asyncio.sleep(delay)
        if isinstance(reply_or_exc, Exception):
            raise reply_or_exc
        return reply_or_exc(command) if callable(reply_or_exc) else reply_or_exc

    retired = []

    async def retire():
        retired.append(True)

    runtime._rpc = rpc
    runtime._retire = retire
    return runtime, seen, retired


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outcome", ["ok", "timeout", "render_failed", "resource_limit", "cad_unavailable", "protocol_error"]
)
async def test_main_accepts_an_exact_terminal_replay_without_retiring(tmp_path, outcome):
    command = run_command()
    runtime, _seen, retired = runtime_with(tmp_path, lambda c: {"outcome": outcome, "proof": proof(command)})
    await runtime._cancel(command)
    assert retired == []


@pytest.mark.asyncio
async def test_main_accepts_a_cancel_ack(tmp_path):
    command = run_command()
    runtime, _seen, retired = runtime_with(tmp_path, {"outcome": "canceled", "proof": proof(command, "cancel_ack")})
    await runtime._cancel(command)
    assert retired == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reply",
    [
        {"outcome": "timeout"},  # bare outcome
        {"outcome": "busy"},
        {"outcome": "unavailable"},
        "unavailable_replay",
        "wrong_generation",
        "wrong_epoch",
        "wrong_attempt",
        "wrong_seq",
        "wrong_digest",
        "wrong_version",
        "ack_not_canceled",
        "unknown_mode",
        "extra_field",
    ],
)
async def test_anything_but_an_exact_proof_still_retires(tmp_path, reply):
    command = run_command()
    forged = {
        "unavailable_replay": {"outcome": "unavailable", "proof": proof(command)},
        "wrong_generation": {"outcome": "timeout", "proof": proof(command, app_generation="x" * 32)},
        "wrong_epoch": {"outcome": "timeout", "proof": proof(command, service_epoch="x" * 32)},
        "wrong_attempt": {"outcome": "timeout", "proof": proof(command, attempt_id="f" * 32)},
        "wrong_seq": {"outcome": "timeout", "proof": proof(command, attempt_seq=99)},
        "wrong_digest": {"outcome": "timeout", "proof": proof(command, command_digest="0" * 64)},
        "wrong_version": {"outcome": "timeout", "proof": proof(command, version=VERSION - 1)},
        "ack_not_canceled": {"outcome": "ok", "proof": proof(command, "cancel_ack")},
        "unknown_mode": {"outcome": "timeout", "proof": proof(command, "replay")},
        "extra_field": {"outcome": "timeout", "proof": {**proof(command), "path": "x"}},
    }
    runtime, _seen, retired = runtime_with(tmp_path, forged.get(reply, reply) if isinstance(reply, str) else reply)
    await runtime._cancel(command)
    assert retired == [True]


@pytest.mark.asyncio
async def test_a_slow_but_proven_stop_inside_c_cancel_does_not_restart(tmp_path):
    """A service whose owned stop takes longer than the 2 s control RPC but less than C_cancel still proves the end:
    the cancel waits C_cancel, never CONTROL_SECONDS."""
    assert C_CANCEL_SECONDS > CONTROL_SECONDS
    command = run_command()
    runtime, seen, retired = runtime_with(
        tmp_path, {"outcome": "canceled", "proof": proof(command, "cancel_ack")}, delay=CONTROL_SECONDS + 0.5
    )
    await runtime._cancel(command)
    assert seen["timeout"] == C_CANCEL_SECONDS and retired == []


def test_queue_bound_follows_the_spec_formula():
    from backend.app.services.preview_protocol import STEP_QUEUE_LIMIT

    t_max = 60
    assert min(64, 1800 // max(2 * t_max, int(120 + 3 * C_CANCEL_SECONDS))) == STEP_QUEUE_LIMIT


# --- the real chain ----------------------------------------------------------------------------------------------


def _torus(path: Path, triangles: int) -> None:
    import trimesh

    mesh = trimesh.creation.torus(
        1.0, 0.3, major_sections=int((triangles / 2) ** 0.5) + 1, minor_sections=int((triangles / 2) ** 0.5) + 1
    )
    path.write_bytes(mesh.export(file_type="stl"))


@pytest.mark.asyncio
async def test_four_timeouts_that_the_service_finished_keep_the_service(tmp_path):
    """Real chain: a deadline hits each attempt in the service's render; the cancel that follows meets either the
    live run (cancel_ack) or its cached timeout (terminal_replay) — never a retire. Then an STL renders at once."""
    import trimesh

    heavy = tmp_path / "heavy.stl"
    _torus(heavy, 1_600_000)
    runtime = PreviewRuntime(tmp_path / "preview")
    await runtime.start()
    try:
        before = (runtime.service.process.pid, runtime.epoch, len(runtime.restarts))
        for _ in range(4):
            async with runtime.attempt({"mesh": (heavy, "stl")}, deadline=time.monotonic_ns() + int(3e9)) as result:
                assert result.outcome in {"timeout", "canceled"}, result.outcome
        assert (runtime.service.process.pid, runtime.epoch, len(runtime.restarts)) == before and not runtime.uncertain
        async with runtime.attempt({"mesh": (trimesh.creation.box().export(file_type="stl"), "stl")}) as result:
            assert result.outcome == "ok"
    finally:
        await runtime.stop()


@pytest.mark.asyncio
async def test_a_cancel_landing_in_the_runs_finally_is_answered_and_cleanup_completes(tmp_path, monkeypatch):
    """Found on the real chain: the cancel RPC cancels the run task while its finally is closing the transfer; the
    re-raised CancelledError used to skip the child stop and the staging cleanup, and the cancel handler, awaiting
    a now-cancelled task, died without a reply — main waited C_cancel and retired a healthy service."""
    import backend.app.preview_service as module

    service = module.Service(
        {
            "generation": "g" * 32,
            "epoch": "e" * 32,
            "staging": str(tmp_path),
            "url": "nats://127.0.0.1:1",
            "token": "t",
            "bucket": "b",
            "cache": str(tmp_path / "cache"),
        }
    )
    command = run_command()
    closing = asyncio.Event()

    class _JS:
        async def object_store(self, bucket):
            return None

    class _NC:
        def jetstream(self, timeout=None):
            return _JS()

    async def connect(*args, **kwargs):
        return _NC()

    async def get(store, ref, path, deadline):
        from backend.app.services.preview_protocol import PreviewError

        raise PreviewError("timeout")

    async def slow_close(nc, **kwargs):
        closing.set()
        await asyncio.sleep(0.5)
        return True

    cleaned = []
    real_cleanup = module.cleanup_owned

    def cleanup(path, **kwargs):
        cleaned.append(path)
        return real_cleanup(path, **kwargs)

    monkeypatch.setattr(module.nats, "connect", connect)
    monkeypatch.setattr(module, "get", get)
    monkeypatch.setattr(module, "close_transfer", slow_close)
    monkeypatch.setattr(module, "cleanup_owned", cleanup)
    run = asyncio.create_task(service.command(command))
    await asyncio.wait_for(closing.wait(), 5)
    reply = await asyncio.wait_for(service.command(Command(**{**command.__dict__, "operation": "cancel"})), 5)
    assert reply["outcome"] == "canceled" and reply["proof"]["mode"] == "cancel_ack"
    assert cleaned and not (tmp_path / command.attempt_id).exists()
    assert (await asyncio.wait_for(run, 5))["outcome"] == "timeout"
    assert service.active is None and not service.uncertain


@pytest.mark.asyncio
async def test_a_cancel_before_the_run_ever_started_is_still_answered(tmp_path):
    from backend.app.preview_service import Service

    service = Service({"generation": "g" * 32, "epoch": "e" * 32})
    command = run_command()

    async def never():
        await asyncio.sleep(3600)

    service.active = command
    service.task = asyncio.create_task(never())
    service.task.cancel()  # cancelled before it ran a single step
    reply = await asyncio.wait_for(service.command(Command(**{**command.__dict__, "operation": "cancel"})), 5)
    assert reply["outcome"] == "canceled" and reply["proof"]["mode"] == "cancel_ack"


@pytest.mark.asyncio
async def test_a_late_cancel_landing_as_an_owned_step_finishes_never_skips_the_rest_of_the_finally():
    """Found under load on the real chain: a cancel landing exactly as an owned cleanup step finished made settle()
    re-raise (it read "done" as "cancelled"), the run's finally skipped the staging cleanup, and the service still
    answered cancel_ack — the next admission met mesh.stl.part and every later preview was resource_limit."""
    from backend.app.preview_service import settle

    finished = asyncio.Event()
    after = []

    async def step():
        await finished.wait()
        return "closed"

    async def finally_block():
        result = await settle(step())
        after.append(result)  # the rest of the finally — the staging cleanup — must still run
        return result

    outer = asyncio.create_task(finally_block())
    await asyncio.sleep(0)  # outer now waits on the shielded step
    finished.set()  # the step's wake-up is queued first...
    outer.cancel()  # ...and the late cancel right behind it
    assert await outer == "closed"
    assert after == ["closed"]


@pytest.mark.asyncio
async def test_settle_still_propagates_a_step_that_was_itself_cancelled_or_failed():
    from backend.app.preview_service import settle

    async def boom():
        raise OSError("disk")

    with pytest.raises(OSError):
        await settle(boom())
    inner = asyncio.ensure_future(asyncio.sleep(10))
    inner.cancel()
    with pytest.raises(asyncio.CancelledError):
        await settle(inner)
