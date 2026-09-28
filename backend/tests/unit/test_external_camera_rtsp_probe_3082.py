"""An external camera's live view must not cap ffmpeg's stream probing (upstream #3082).

A camera passed the connection test, played in VLC, and showed a black live
view. The two RTSP paths in ``external_camera`` did not ask ffmpeg for the same
thing: the one-shot ``_capture_rtsp_frame`` runs on ffmpeg's defaults, while
``_stream_rtsp`` fell back to ``-probesize 32 -analyzeduration 0`` whenever no
camera profile was given. 32 bytes is enough for a camera that puts SPS/PPS in
its SDP; one that sends them in-band a moment later (a WebRTC source
republished through go2rtc, in the report) never gets an H.264 decoder started
and yields no frames at all.

Those numbers are fast-start tuning for a KNOWN Bambu camera. In BamDude a
Bambu RTSPS source on this path passes its model profile (P2S needs a relaxed
probe) and keeps that tuning; only a camera with no profile — a real external
one, with no model to tune against — goes back to ffmpeg's defaults.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.app.services.camera_profiles import CameraProfile
from backend.app.services.external_camera import _capture_rtsp_frame, _stream_rtsp

CAMERA = "rtsp://admin:hunter2@192.168.1.50:554/live"
PROBE_FLAGS = ("-probesize", "-analyzeduration")


def _process(returncode: int | None, stdout: bytes = b"\xff\xd8" + b"\x00" * 200) -> MagicMock:
    process = MagicMock()
    process.pid = 4242
    process.returncode = returncode
    process.communicate = AsyncMock(return_value=(stdout, b""))
    process.stdout.read = AsyncMock(return_value=b"")
    process.stderr.read = AsyncMock(return_value=b"")
    process.stderr.readline = AsyncMock(return_value=b"")
    process.wait = AsyncMock(return_value=returncode)
    process.kill = MagicMock()
    process.terminate = MagicMock()
    return process


async def _argv(run, returncode: int | None) -> tuple[str, ...]:
    spawn = AsyncMock(return_value=_process(returncode))
    with (
        patch("backend.app.services.external_camera.get_ffmpeg_path", return_value="/usr/bin/ffmpeg"),
        patch("backend.app.services.external_camera.asyncio.create_subprocess_exec", new=spawn),
    ):
        await run()
    return spawn.await_args.args


async def _stream_argv(profile: CameraProfile | None = None) -> tuple[str, ...]:
    async def run():
        async for _ in _stream_rtsp(CAMERA, fps=5, profile=profile):
            pass

    return await _argv(run, returncode=None)


async def _capture_argv() -> tuple[str, ...]:
    return await _argv(lambda: _capture_rtsp_frame(CAMERA, timeout=5), returncode=0)


class TestAnExternalCameraIsNotCapped:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("flag", PROBE_FLAGS)
    async def test_no_probe_ceiling_without_a_profile(self, flag):
        """Silent when it regresses: no error, the connection test still passes,
        the live view just never produces a frame for such a camera."""
        argv = await _stream_argv()
        assert flag not in argv, f"{flag} is back in the external live stream: {argv!r}"

    @pytest.mark.asyncio
    async def test_the_low_latency_flags_are_kept(self):
        """Not sitting on frames already decoded is a different question from how
        long ffmpeg may look before it has any."""
        argv = await _stream_argv()
        assert argv[argv.index("-fflags") + 1] == "nobuffer"
        assert argv[argv.index("-flags") + 1] == "low_delay"

    @pytest.mark.asyncio
    async def test_both_rtsp_paths_probe_alike(self):
        """The asymmetry is the bug: a camera that answers the test button has
        shown nothing about the live view unless both paths look at it the same way."""
        stream, capture = await _stream_argv(), await _capture_argv()
        assert [f for f in PROBE_FLAGS if f in stream] == [f for f in PROBE_FLAGS if f in capture]


class TestAModelProfileKeepsItsTuning:
    @pytest.mark.asyncio
    async def test_a_profile_still_sets_its_probe(self):
        argv = await _stream_argv(CameraProfile(probesize=1_000_000, analyzeduration=500_000))
        assert argv[argv.index("-probesize") + 1] == "1000000"
        assert argv[argv.index("-analyzeduration") + 1] == "500000"
