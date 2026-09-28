"""Every ffmpeg / ffprobe failure logs the diagnosis, not the build banner (upstream #2968).

ffmpeg opens every run with ~20 lines of version and build banner and prints its
diagnosis LAST, so a ``stderr[:500]`` keeps the banner and drops the error — the
reporter's twelve capture failures all read "ffmpeg version 7.1.4 ...
configuration: ...". A bare ``.decode()`` can also raise on the stream bytes
ffmpeg copies into its messages, and a raw stderr can carry a credentialed URL.
``utils/ffmpeg_output.summarize_ffmpeg_stderr`` does all three; these pin that
every call site goes through it.
"""

import re
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

APP = Path(__file__).resolve().parents[2] / "app"

BANNER = (
    b"ffmpeg version 7.1.4 Copyright (c) 2000-2025 the FFmpeg developers\n"
    b"  built with gcc 14\n"
    b"  configuration: --prefix=/usr --extra-version=1\n"
    b"  libavutil      59. 39.100 / 59. 39.100\n"
)
DIAGNOSIS = b"rtsp://admin:hunter2@10.0.0.5/live: Invalid data found when processing input \xff\xfe\n"


def test_no_ffmpeg_module_decodes_stderr_by_hand():
    """A module that runs ffmpeg or ffprobe hands stderr to the summariser."""
    offenders = []
    for path in APP.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if not re.search(r"ffmpeg|ffprobe", text, re.IGNORECASE):
            continue
        for number, line in enumerate(text.splitlines(), 1):
            if "stderr.decode(" in line:
                offenders.append(f"{path.relative_to(APP)}:{number}")
    assert offenders == [], offenders


def _failed_process() -> MagicMock:
    process = MagicMock()
    process.returncode = 1
    process.communicate = AsyncMock(return_value=(b"", BANNER + DIAGNOSIS))
    return process


@pytest.mark.asyncio
async def test_a_failed_ffprobe_raises_with_the_diagnosis(tmp_path):
    """The one site whose text leaves in an exception, not only a log line."""
    from backend.app.services.timelapse_processor import TimelapseProcessor

    video = tmp_path / "t.mp4"
    video.write_bytes(b"x")
    with (
        patch("backend.app.services.timelapse_processor.get_ffmpeg_path", return_value="/usr/bin/ffmpeg"),
        patch(
            "backend.app.services.timelapse_processor.asyncio.create_subprocess_exec",
            new=AsyncMock(return_value=_failed_process()),
        ),
        pytest.raises(RuntimeError) as raised,
    ):
        await TimelapseProcessor(video).get_info()

    message = str(raised.value)
    assert "Invalid data found" in message
    assert "ffmpeg version" not in message
    assert "hunter2" not in message
