"""The restore barrier on the real route (spec §4.3, plan A5 N5–N7): a restore of the same library arriving while
a STEP picture is being published waits for that publication, then replaces files and database with the backup's —
no stale picture on the row, no dangling PNG, nothing published after it. SQLite always; PostgreSQL on a disposable
server named by PREVIEW_TEST_PG_DSN (the whole database is dropped and rebuilt)."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]

pytestmark = pytest.mark.requires_cad

EXPECTED = {
    "restore_waited_for_the_publication": True,
    "no_file_work_before_it": True,
    "publication_in_flight_completed": True,
    "restored": True,
    "thumbnail_path": None,  # the backup's row: the in-flight picture went with the old state
    "pngs": [],
    "old_file_gone": True,
    "step_restored": True,
    "publication_after_restore": False,  # closed until the restart the restore asks for
    "pngs_after": [],
}


def run(tmp_path: Path, url: str | None) -> dict:
    from backend.tests.cad_lane import cad_app_dir

    env = {
        **os.environ,
        "DATA_DIR": str(tmp_path / "data"),
        "DEBUG": "false",
        "BAMDUDE_IGNORE_DOTENV": "1",
        "BAMDUDE_STEP_TEST_APP_DIR": str(cad_app_dir()),
    }
    env.pop("MFA_ENCRYPTION_KEY", None)
    if url:
        env["DATABASE_URL"] = url
    else:
        env.pop("DATABASE_URL", None)
    (tmp_path / "out").mkdir()
    p = subprocess.run(
        [sys.executable, "-m", "backend.tests.integration.step_restore_runner", str(tmp_path / "out")],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=900,
    )
    assert p.returncode == 0, p.stdout[-3000:] + p.stderr[-8000:]
    return json.loads(p.stdout.strip().splitlines()[-1])


def test_a_restore_waits_for_a_step_publication_and_leaves_the_backups_library_on_sqlite(tmp_path):
    assert run(tmp_path, None) == {**EXPECTED, "dialect": "sqlite"}


@pytest.mark.skipif(not os.environ.get("PREVIEW_TEST_PG_DSN"), reason="disposable PostgreSQL only")
def test_a_restore_waits_for_a_step_publication_and_leaves_the_backups_library_on_postgres(tmp_path):
    assert run(tmp_path, os.environ["PREVIEW_TEST_PG_DSN"]) == {**EXPECTED, "dialect": "postgresql"}
