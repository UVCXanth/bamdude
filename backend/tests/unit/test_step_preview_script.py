"""install/step-preview.sh — the administrator's enable, repair and check of the STEP preview component on a native
install (spec stage C R7, R5b, R6b; plan Task 7): the same CAD step as install.sh, recorded `--by cli`, an exit code
that follows the helper's, a check that names a missing system library by its package, and a first line that names
only the bounds the helper really has."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import pytest

from backend.app import step_runtime
from backend.tests.unit.test_install_script_step_preview import FAKE_PYTHON
from backend.tests.unit.test_update_script_repairs_loop_flag import BASH

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "install" / "step-preview.sh"

FAKE = FAKE_PYTHON.replace(
    "  status)\n",
    '  limits) echo \'{"lock_seconds": 900, "pip_seconds": 900, "smoke_seconds": 120, "render_seconds": 120}\' ;;\n'
    "  status)\n"
    '    if [[ "$4" == "--check" ]]; then echo "${FAKE_CHECK:-{}}"; exit "${FAKE_CHECK_RC:-0}"; fi\n',
)

STUBS = r"""
sudo() {
  echo "sudo $*" >> "$CALLS"
  if [[ "$1" == "-u" ]]; then shift 2; fi
  if [[ "$1" == "apt-get" || "$1" == "dnf" ]] && [[ -n "${FAKE_APT:-}" ]]; then return "$FAKE_APT"; fi
  "$@"
}
apt-get() { echo "apt-get $*" >> "$CALLS"; return 0; }
dnf() { echo "dnf $*" >> "$CALLS"; return 0; }
uname() { if [[ "$1" == "-m" ]]; then echo x86_64; else command uname "$@"; fi; }
"""


def _run(tmp_path: Path, steps: str, *, os_type="debian", pkg="apt", env=None):
    bash = pytest.importorskip("shutil").which("bash") and BASH
    if not bash:
        pytest.skip("named skip: bash is not available")
    install_path = tmp_path / "bam dude"
    calls = tmp_path / "calls.txt"
    calls.write_text("", encoding="utf-8")
    python = install_path / "venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.write_text(FAKE, encoding="utf-8", newline="\n")
    python.chmod(0o755)
    exports = {"CALLS": calls.as_posix(), **(env or {})}
    program = "\n".join(
        [
            *[f"export {k}='{v}'" for k, v in exports.items()],
            f"source '{SCRIPT.as_posix()}'",  # brings install.sh and the script's own options
            STUBS,
            f"OS_TYPE={os_type}; PKG_MANAGER={pkg}; SERVICE_USER=bamdude",
            f"INSTALL_PATH='{install_path.as_posix()}'",
            "rc=0",
            steps + " || rc=$?",
            'echo "RC=$rc"',
        ]
    )
    script = tmp_path / "run.sh"
    script.write_text(program, encoding="utf-8", newline="\n")
    result = subprocess.run([BASH, script.as_posix()], capture_output=True, text=True, timeout=60)
    rc = re.search(r"RC=(\d+)", result.stdout)
    assert rc, (result.stdout, result.stderr)
    return int(rc.group(1)), result.stdout + result.stderr, calls.read_text(encoding="utf-8").splitlines()


def _verbs(calls):
    out = []
    for c in calls:
        m = re.match(r"python \[-m\] \[backend\.app\.step_runtime\] \[(\w+)\]", c)
        if m:
            out.append(m.group(1))
        elif c.startswith(("apt-get", "dnf")):
            out.append("packages")
    return out


def test_enable_runs_the_cad_step_as_the_owner_with_cli(tmp_path):
    rc, out, calls = _run(tmp_path, "step_preview_enable")
    assert rc == 0, out
    assert _verbs(calls) == ["select", "choose", "packages", "install"]
    choose = next(c for c in calls if "[choose]" in c)
    assert "[enabled] [--by] [cli]" in choose
    assert all(c.startswith("sudo -u bamdude") for c in calls if c.startswith("sudo") and "apt-get" not in c)


@pytest.mark.parametrize(
    ("env", "code"),
    [({"FAKE_CHOOSE": "1"}, 1), ({"FAKE_APT": "100"}, 0), ({"FAKE_INSTALL": "1"}, 1)],
)
def test_enable_exit_codes_follow_the_contract(tmp_path, env, code):
    rc, out, _ = _run(tmp_path, "step_preview_enable", env=env)
    assert rc == code, out
    if env.get("FAKE_APT"):
        assert "anyway" in out  # the libraries failed, the component was tried and worked


def test_enable_on_arch_warns_about_libraries_and_still_installs(tmp_path):
    rc, out, calls = _run(tmp_path, "step_preview_enable", os_type="arch", pkg="pacman")
    assert rc == 0 and "libGL" in out
    assert "install" in _verbs(calls) and "packages" not in _verbs(calls)


@pytest.mark.parametrize(("pkg", "package"), [("apt", "libgl1"), ("dnf", "mesa-libGL")])
def test_status_checks_and_translates_the_soname(tmp_path, pkg, package):
    check = json.dumps({"choice": "enabled", "bundle": "smoke_failed:system_library:libGL.so.1"})
    rc, out, calls = _run(tmp_path, "step_preview_status", pkg=pkg, env={"FAKE_CHECK": check, "FAKE_CHECK_RC": "1"})
    assert rc == 1 and package in out and "step-preview.sh enable" in out
    assert any("[status] [--check]" in c for c in calls)


def test_status_of_a_disabled_install_says_how_to_enable(tmp_path):
    check = json.dumps({"choice": "disabled", "bundle": "missing"})
    rc, out, _ = _run(tmp_path, "step_preview_status", env={"FAKE_CHECK": check, "FAKE_CHECK_RC": "1"})
    assert "disabled" in out.lower() and "step-preview.sh enable" in out


def test_the_first_line_names_only_the_real_bounds(tmp_path):
    rc, out, _ = _run(tmp_path, "step_preview_bounds")
    first = out.strip().splitlines()[0]
    assert "15 min" in first and "120 s" in first and "not bounded" in first


def test_the_helper_answers_its_limits():
    import io
    from contextlib import redirect_stdout

    buf = io.StringIO()
    with redirect_stdout(buf):
        assert step_runtime.main(["limits"]) == 0
    assert json.loads(buf.getvalue()) == {
        "lock_seconds": step_runtime.INSTALL_SECONDS,
        "pip_seconds": step_runtime.INSTALL_SECONDS,
        "smoke_seconds": step_runtime.SMOKE_SECONDS,
        "render_seconds": step_runtime.RENDER_SECONDS,
    }


def test_the_script_is_executable_and_parses():
    assert SCRIPT.read_bytes().startswith(b"#!/usr/bin/env bash\n")
    assert b"\r\n" not in SCRIPT.read_bytes()
