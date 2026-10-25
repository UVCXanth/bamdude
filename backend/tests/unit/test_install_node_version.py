"""Run the installer's real Node gate and retry path without installing anything."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from backend.tests.unit.test_update_script_repairs_loop_flag import BASH

ROOT = Path(__file__).resolve().parents[3]
INSTALL = ROOT / "install" / "install.sh"
pytestmark = pytest.mark.skipif(BASH is None, reason="bash is not available")


def run_shell(tmp_path: Path, body: str) -> subprocess.CompletedProcess:
    script = tmp_path / "check.sh"
    script.write_text(f"source '{INSTALL.as_posix()}'\n{body}\n", encoding="utf-8", newline="\n")
    return subprocess.run([BASH, script.as_posix()], capture_output=True, text=True, timeout=15)


@pytest.mark.parametrize(
    ("version", "accepted"),
    [
        ("v18.20.0", False),
        ("v20.19.0", False),
        ("v21.7.3", False),
        ("v22.12.0", False),
        ("v22.21.99", False),
        ("v22.22.0", True),
        ("v22.22.1", True),
        ("v22.23.0", True),
        ("v23.0.0", True),
        ("v24.0.0", True),
        ("", False),
        ("v22", False),
        ("v22.22", False),
        ("broken", False),
        ("v22.22.0-rc.1", False),
        ("v24.0.0\nnoise", False),
        ("v999999999999999999999.0.0", False),
    ],
)
def test_node_version_gate(tmp_path, version, accepted):
    result = run_shell(tmp_path, f"node() {{ printf '%s\\n' '{version}'; }}\ncheck_node_version")
    assert (result.returncode == 0) is accepted, result.stdout + result.stderr
    assert "integer expression expected" not in result.stderr
    if not accepted:
        assert "22.22.0" in result.stdout


def test_failed_node_command_is_not_accepted_even_with_valid_stdout(tmp_path):
    result = run_shell(tmp_path, "node() { printf 'v24.0.0\\n'; return 7; }\ncheck_node_version")
    assert result.returncode != 0


def test_missing_node_is_not_accepted(tmp_path):
    result = run_shell(tmp_path, "PATH=/nonexistent\ncheck_node_version")
    assert result.returncode != 0


@pytest.mark.parametrize(
    ("initial", "installed", "accepted", "install_count"),
    [
        ("v22.22.0", "v22.22.0", True, 0),
        ("v20.19.0", "v22.22.0", True, 1),
        ("v22.21.9", "v22.21.9", False, 1),
    ],
)
def test_build_rechecks_after_one_install(tmp_path, initial, installed, accepted, install_count):
    (tmp_path / "frontend").mkdir()
    result = run_shell(
        tmp_path,
        f"""INSTALL_PATH='{tmp_path.as_posix()}'
OS_TYPE=macos
VERSION='{initial}'
node() {{ printf '%s\\n' "$VERSION"; }}
install_nodejs() {{ printf 'INSTALL_NODE\\n'; VERSION='{installed}'; }}
npm() {{ printf 'NPM %s\\n' "$*"; }}
build_frontend
""",
    )
    assert (result.returncode == 0) is accepted, result.stdout + result.stderr
    assert result.stdout.count("INSTALL_NODE") == install_count
    assert result.stdout.count("NPM ci") == int(accepted)
    assert result.stdout.count("NPM run build") == int(accepted)
