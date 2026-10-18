"""install.sh and the STEP preview component (spec stage C R3, R5, R5b; plan Task 5): asked only where it is
offered, never by default, the administrator's answer recorded first, then the system libraries, then the
component — and no failure of any of it changes what the installer does next.

The real install.sh is sourced (its own ``set -e`` included, as update.sh sources it) and run in bash against stub
shell functions and a stub venv python that records its arguments: nothing is installed."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

from backend.tests.unit.test_update_script_repairs_loop_flag import BASH

ROOT = Path(__file__).resolve().parents[3]
INSTALL_SH = ROOT / "install" / "install.sh"

pytestmark = pytest.mark.skipif(BASH is None, reason="named skip: bash is not available")

FAKE_PYTHON = r"""#!/usr/bin/env bash
printf 'python' >> "$CALLS"
for a in "$@"; do printf ' [%s]' "$a" >> "$CALLS"; done
echo >> "$CALLS"
case "$3" in
  select) exit "${FAKE_SELECT:-0}" ;;
  choose)
    if [[ "${FAKE_CHOOSE:-0}" == 0 ]]; then echo "{\"ok\": true, \"choice\": \"$4\"}"
    else echo '{"ok": false, "reason": "permission"}'; exit 1; fi ;;
  install)
    if [[ "${FAKE_INSTALL:-0}" == 0 ]]; then echo '{"ok": true, "bundle": "runtime/step-preview/k/d"}'
    else echo "{\"ok\": false, \"reason\": \"${FAKE_REASON:-pip_failed}\"}"; exit "$FAKE_INSTALL"; fi ;;
  status)
    if [[ -n "${FAKE_STATUS_RC:-}" ]]; then exit "$FAKE_STATUS_RC"; fi
    echo "{\"choice\": \"${FAKE_CHOICE:-none}\", \"bundle\": \"missing\"}" ;;
esac
"""

STUBS = r"""
sudo() {
  echo "sudo $*" >> "$CALLS"
  if [[ "$1" == "-u" ]]; then shift 2; fi
  if [[ "$1" == "apt-get" || "$1" == "dnf" || "$1" == "yum" ]] && [[ -n "${FAKE_SUDO_DENIED:-}" ]]; then return 1; fi
  "$@"
}
apt-get() { echo "apt-get $*" >> "$CALLS"; return "${FAKE_APT:-0}"; }
dnf() { echo "dnf $*" >> "$CALLS"; return "${FAKE_APT:-0}"; }
yum() { echo "yum $*" >> "$CALLS"; return "${FAKE_APT:-0}"; }
brew() { echo "brew $*" >> "$CALLS"; return 0; }
uname() { if [[ "$1" == "-m" ]]; then echo "${FAKE_ARCH:-x86_64}"; else command uname "$@"; fi; }
"""


def _run(tmp_path: Path, steps: str, *, os_type="debian", pkg="apt", venv=True, env=None, path_name="bam dude"):
    install_path = tmp_path / path_name
    calls = tmp_path / "calls.txt"
    calls.write_text("", encoding="utf-8")
    python = install_path / "venv" / "bin" / "python"
    if venv:
        python.parent.mkdir(parents=True)
        python.write_text(FAKE_PYTHON, encoding="utf-8", newline="\n")
        python.chmod(0o755)
    else:
        install_path.mkdir(parents=True)
    exports = {"CALLS": calls.as_posix(), **(env or {})}
    program = "\n".join(
        [
            *[f"export {k}='{v}'" for k, v in exports.items()],
            f"source '{INSTALL_SH.as_posix()}'",  # brings its `set -e`
            STUBS,
            f"OS_TYPE={os_type}; PKG_MANAGER={pkg}; SERVICE_USER=bamdude",
            f"INSTALL_PATH='{install_path.as_posix()}'",
            steps,
            'echo "AFTER the step: the installer goes on"',
        ]
    )
    script = tmp_path / "run.sh"
    script.write_text(program, encoding="utf-8", newline="\n")
    result = subprocess.run([BASH, script.as_posix()], capture_output=True, text=True, timeout=60)
    return result, calls.read_text(encoding="utf-8").splitlines(), install_path


def _helper(calls, verb):
    """The helper's calls of one subcommand — the verb right after the module, not a `--by install` value."""
    return [c for c in calls if c.startswith(f"python [-m] [backend.app.step_runtime] [{verb}]")]


def test_yes_alone_on_a_fresh_install_chooses_disabled_and_runs_no_package_manager(tmp_path):
    result, calls, _ = _run(
        tmp_path,
        'NON_INTERACTIVE=true; ask_step_preview; echo "CHOICE=$STEP_PREVIEW"; provision_step_preview',
        venv=True,
        env={"FAKE_STATUS_RC": "1"},  # what the not-yet-installed tree's helper answers: nothing usable
    )
    assert "CHOICE=no" in result.stdout and "AFTER the step" in result.stdout, result.stderr
    assert len(_helper(calls, "choose")) == 1 and "[disabled]" in _helper(calls, "choose")[0]
    assert _helper(calls, "install") == [] and not any(c.startswith(("apt-get", "dnf")) for c in calls)


def test_the_flag_runs_select_choose_libraries_install_in_that_order(tmp_path):
    result, calls, path = _run(tmp_path, "STEP_PREVIEW=yes; provision_step_preview")
    assert result.returncode == 0 and "AFTER the step" in result.stdout, result.stderr
    order = [c for c in calls if c.startswith(("python", "apt-get"))]
    verbs = [
        ("apt" if c.startswith("apt-get") else re.search(r"\[(select|choose|install)\]", c).group(1)) for c in order
    ]
    assert verbs == ["select", "choose", "apt", "install"], calls
    assert "[enabled] [--by] [install]" in _helper(calls, "choose")[0]
    assert "apt-get install -y libgl1 libx11-6 libexpat1 zlib1g" in calls
    assert sum(1 for c in calls if c.startswith("sudo -u bamdude")) == 3  # select, choose, install: the owner's


def test_fedora_installs_its_own_package_names(tmp_path):
    _, calls, _ = _run(tmp_path, "STEP_PREVIEW=yes; provision_step_preview", os_type="rhel", pkg="dnf")
    assert "dnf install -y mesa-libGL libX11 expat zlib" in calls


def test_macos_installs_no_package_and_runs_as_the_user(tmp_path):
    _, calls, _ = _run(tmp_path, "STEP_PREVIEW=yes; provision_step_preview", os_type="macos", pkg="brew")
    assert not any(c.startswith(("brew", "apt-get", "sudo")) for c in calls)
    assert _helper(calls, "install")


def test_a_rerun_keeps_enabled_through_the_installed_helper(tmp_path):
    result, calls, _ = _run(
        tmp_path,
        'NON_INTERACTIVE=true; ask_step_preview; echo "CHOICE=$STEP_PREVIEW"; provision_step_preview',
        env={"FAKE_CHOICE": "enabled"},
    )
    assert "CHOICE=yes" in result.stdout
    assert "[enabled]" in _helper(calls, "choose")[0] and _helper(calls, "install")


def test_an_old_helper_without_status_defaults_to_no(tmp_path):
    result, _, _ = _run(
        tmp_path, 'NON_INTERACTIVE=true; ask_step_preview; echo "CHOICE=$STEP_PREVIEW"', env={"FAKE_STATUS_RC": "2"}
    )
    assert "CHOICE=no" in result.stdout


def test_a_fresh_install_without_a_venv_defaults_to_no(tmp_path):
    result, calls, _ = _run(tmp_path, 'NON_INTERACTIVE=true; ask_step_preview; echo "CHOICE=$STEP_PREVIEW"', venv=False)
    assert "CHOICE=no" in result.stdout and calls == []


@pytest.mark.parametrize(
    ("os_type", "pkg", "arch"),
    [("arch", "pacman", "x86_64"), ("suse", "zypper", "x86_64"), ("debian", "apt", "armv7l")],
)
def test_arch_suse_and_other_machines_are_not_asked(tmp_path, os_type, pkg, arch):
    result, calls, _ = _run(
        tmp_path,
        'NON_INTERACTIVE=true; ask_step_preview; echo "CHOICE=[$STEP_PREVIEW]"; provision_step_preview',
        os_type=os_type,
        pkg=pkg,
        env={"FAKE_ARCH": arch},
    )
    assert "CHOICE=[]" in result.stdout and "AFTER the step" in result.stdout
    assert _helper(calls, "choose") == [] and _helper(calls, "install") == []


def test_an_unsupported_interpreter_writes_no_choice(tmp_path):
    result, calls, _ = _run(tmp_path, "STEP_PREVIEW=yes; provision_step_preview", env={"FAKE_SELECT": "3"})
    assert result.returncode == 0 and "AFTER the step" in result.stdout
    assert _helper(calls, "choose") == [] and _helper(calls, "install") == []


def test_a_choice_that_cannot_be_written_stops_only_the_cad_step(tmp_path):
    result, calls, _ = _run(tmp_path, "STEP_PREVIEW=yes; provision_step_preview", env={"FAKE_CHOOSE": "1"})
    assert result.returncode == 0 and "AFTER the step" in result.stdout, result.stderr
    assert _helper(calls, "install") == [] and not any(c.startswith("apt-get") for c in calls)
    assert "permission" in result.stdout + result.stderr


@pytest.mark.parametrize("env", [{"FAKE_APT": "100"}, {"FAKE_SUDO_DENIED": "1"}])
def test_a_failed_package_manager_still_lets_the_helper_try(tmp_path, env):
    result, calls, _ = _run(tmp_path, "STEP_PREVIEW=yes; provision_step_preview", env=env)
    assert result.returncode == 0 and "AFTER the step" in result.stdout, result.stderr
    assert _helper(calls, "install")


def test_a_failed_install_warns_with_the_package_and_never_fails(tmp_path):
    result, _, _ = _run(
        tmp_path,
        "STEP_PREVIEW=yes; provision_step_preview",
        env={"FAKE_INSTALL": "1", "FAKE_REASON": "smoke_failed:system_library:libGL.so.1"},
    )
    out = result.stdout + result.stderr
    assert result.returncode == 0 and "AFTER the step" in result.stdout
    assert "libgl1" in out and "step-preview.sh enable" in out


def test_an_install_path_with_a_space_is_quoted(tmp_path):
    _, calls, path = _run(tmp_path, "STEP_PREVIEW=yes; provision_step_preview", path_name="bam dude")
    assert all(f"[--app-dir] [{path.as_posix()}]" in c for c in _helper(calls, "install") + _helper(calls, "choose"))


def test_the_flag_is_parsed_and_documented():
    text = INSTALL_SH.read_text(encoding="utf-8")
    assert re.search(r"--with-step-preview\)\s+STEP_PREVIEW=\"yes\"", text)
    assert "--with-step-preview" in text.split("show_help() {", 1)[1].split("\n}\n", 1)[0]
