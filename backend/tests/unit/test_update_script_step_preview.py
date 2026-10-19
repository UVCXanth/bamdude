"""update.sh and the STEP preview component (spec stage C R4, R4a; plan Task 6; consilium C-R2, C2-R1): only an
install whose administrator enabled the component gets it refreshed, and an old bundle goes only when the stop of
the service is PROVEN — a successful systemctl query of a loaded unit that is inactive or failed, a cgroup v2
hierarchy, and the group recorded before the stop either gone or `populated 0` (descendants included). The state of
the unit alone never stands for the group, whatever it was before the update.

install.sh is sourced (update.sh does the same), update.sh's own two functions are lifted out of it, and everything
runs in bash under update.sh's `set -Eeuo pipefail` with an ERR trap that would show an accidental rollback."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

from backend.tests.unit.test_install_script_step_preview import FAKE_PYTHON
from backend.tests.unit.test_update_script_repairs_loop_flag import BASH

ROOT = Path(__file__).resolve().parents[3]
INSTALL_SH = ROOT / "install" / "install.sh"
UPDATE_SH = ROOT / "install" / "update.sh"

pytestmark = pytest.mark.skipif(BASH is None, reason="named skip: bash is not available")

GROUP = "/system.slice/bamdude.service"


def _lifted(name: str) -> str:
    text = UPDATE_SH.read_text(encoding="utf-8").replace("\r\n", "\n")
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", text, re.S | re.M)
    assert match, f"update.sh must define {name}()"
    return match.group(0)


STUBS = r"""
sudo() { echo "sudo $*" >> "$CALLS"; if [[ "$1" == "-u" ]]; then shift 2; fi; "$@"; }
apt-get() { echo "apt-get $*" >> "$CALLS"; return 0; }
stat() {
  if [[ "$1" == "-fc" && "$2" == "%T" ]]; then echo "${FAKE_FS:-cgroup2fs}"; return 0; fi
  command stat "$@"
}
systemctl() {
  echo "systemctl $*" >> "$CALLS"
  if [[ -n "${FAKE_SHOW_FAILS:-}" ]]; then return 1; fi
  case "$*" in
    *"-p ControlGroup"*) echo "${FAKE_CGROUP-/system.slice/bamdude.service}" ;;
    *"-p LoadState"*) echo "${FAKE_LOAD:-loaded}" ;;
    *"-p ActiveState"*)
      local seq=(${FAKE_ACTIVE:-inactive}) n
      n=$(cat "$COUNTER" 2>/dev/null || echo 0)
      echo "$n" > /dev/null
      if (( n < ${#seq[@]} )); then echo "${seq[$n]}"; else echo "${seq[${#seq[@]}-1]}"; fi
      echo $((n + 1)) > "$COUNTER" ;;
    *) true ;;
  esac
}
"""


# As update.sh runs it: the stop proven once right after `systemctl stop`, the component refreshed with the
# other runtimes, and the old bundle pruned last, just before the start — after the frontend build, so a failed
# build that rolls the code back finds the old code's bundle still there (shell review S2).
UPDATE_STEPS = (
    'record_service_cgroup; rm -f "$COUNTER"; STEP_STOP_PROVEN=0; '
    "if service_proven_stopped; then STEP_STOP_PROVEN=1; fi; "
    "refresh_enabled_step_preview; prune_old_step_preview"
)


def _run(
    tmp_path: Path, *, choice="enabled", events="populated 0", group_exists=True, env=None, steps=None, old_bundle=True
):
    install_path = tmp_path / "bam dude"
    calls, counter = tmp_path / "calls.txt", tmp_path / "counter"
    calls.write_text("", encoding="utf-8")
    python = install_path / "venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    # The current pin is installed unless its install failed (then status names it missing, as the real helper does).
    fake = FAKE_PYTHON.replace("  status)", "  prune) echo '{\"ok\": true}' ;;\n  status)").replace(
        '\\"bundle\\": \\"missing\\"',
        '\\"bundle\\": \\"$( [[ ${FAKE_INSTALL:-0} == 0 ]] && echo installed || echo missing )\\"',
    )
    assert "installed" in fake
    python.write_text(fake, encoding="utf-8", newline="\n")
    python.chmod(0o755)
    key = install_path / "runtime" / "step-preview" / "linux-x64-cp312"
    (key / ("a" * 32)).mkdir(parents=True)  # the current pin's bundle
    if old_bundle:
        (key / ("b" * 32)).mkdir()  # an earlier pin's, which only a proven stop lets go
    root = tmp_path / "cgroup"
    root.mkdir()
    (root / "cgroup.controllers").write_text("cpu memory\n", encoding="utf-8")
    group = root / GROUP.lstrip("/")
    if group_exists:
        group.mkdir(parents=True)
        if events is None:
            (group / "cgroup.events").mkdir()  # unreadable as a file
        else:
            (group / "cgroup.events").write_text(f"{events}\nfrozen 0\n", encoding="utf-8")
        (group / "cgroup.procs").write_text("", encoding="utf-8")
    exports = {
        "CALLS": calls.as_posix(),
        "COUNTER": counter.as_posix(),
        "FAKE_CHOICE": choice,
        "CGROUP_ROOT": root.as_posix(),
        **(env or {}),
    }
    program = "\n".join(
        [
            "set -Eeuo pipefail",
            "trap 'echo ERR-TRAP-FIRED' ERR",
            *[f"export {k}='{v}'" for k, v in exports.items()],
            f"source '{INSTALL_SH.as_posix()}'",
            STUBS,
            "OS_TYPE=debian; PKG_MANAGER=apt; SERVICE_USER=bamdude; SERVICE_NAME=bamdude",
            f"INSTALL_PATH='{install_path.as_posix()}'",
            _lifted("record_service_cgroup"),
            _lifted("service_proven_stopped"),
            'step_preview_may_prune() { [[ "$STEP_STOP_PROVEN" == 1 ]] && service_proven_stopped; }',
            steps or UPDATE_STEPS,
            'echo "AFTER the step: the update goes on"',
        ]
    )
    script = tmp_path / "run.sh"
    script.write_text(program, encoding="utf-8", newline="\n")
    result = subprocess.run([BASH, script.as_posix()], capture_output=True, text=True, timeout=60)
    assert "ERR-TRAP-FIRED" not in result.stdout, result.stdout
    assert "AFTER the step" in result.stdout, (result.stdout, result.stderr)
    return result, calls.read_text(encoding="utf-8").splitlines()


def _verbs(calls) -> list[str]:
    out = []
    for c in calls:
        m = re.match(r"python \[-m\] \[backend\.app\.step_runtime\] \[(\w+)\]", c)
        if m:
            out.append(m.group(1))
        elif c.startswith("apt-get update"):
            out.append("index")
        elif c.startswith("apt-get"):
            out.append("apt")
    return out


def test_an_install_without_a_choice_gets_nothing(tmp_path):
    _, calls = _run(tmp_path, choice="none")
    assert _verbs(calls) == ["status", "status"]


def test_an_enabled_install_is_refreshed_and_pruned_after_a_proven_stop(tmp_path):
    _, calls = _run(tmp_path)
    assert _verbs(calls) == ["status", "index", "apt", "install", "status", "prune"]
    install = next(c for c in calls if "[install]" in c and c.startswith("python"))
    assert "[--if-enabled]" in install
    prune = next(c for c in calls if "[prune]" in c)
    assert "[--other-keys]" not in prune


def test_a_vanished_recorded_group_is_proof(tmp_path):
    _, calls = _run(tmp_path, group_exists=False)
    assert _verbs(calls)[-1] == "prune"


@pytest.mark.parametrize(
    ("why", "kwargs"),
    [
        ("the query failed", {"env": {"FAKE_SHOW_FAILS": "1"}}),
        ("not a loaded unit", {"env": {"FAKE_LOAD": "not-found"}}),
        ("still stopping", {"env": {"FAKE_ACTIVE": "deactivating"}}),
        ("cgroup v1 or hybrid", {"env": {"FAKE_FS": "tmpfs"}}),
        ("cgroup.events unreadable", {"events": None}),
        ("a live descendant", {"events": "populated 1"}),
        ("no group recorded", {"env": {"FAKE_CGROUP": ""}}),
    ],
)
def test_no_prune_without_a_proof(tmp_path, why, kwargs):
    result, calls = _run(tmp_path, **kwargs)
    assert "prune" not in _verbs(calls), why
    assert "kept" in (result.stdout + result.stderr).lower(), why


def test_an_already_failed_service_with_a_live_descendant_is_not_pruned(tmp_path):
    _, calls = _run(tmp_path, events="populated 1", env={"FAKE_ACTIVE": "failed"})
    assert "prune" not in _verbs(calls)


def test_an_already_failed_service_with_an_empty_group_is_pruned(tmp_path):
    _, calls = _run(tmp_path, events="populated 0", env={"FAKE_ACTIVE": "failed"})
    assert _verbs(calls)[-1] == "prune"


def test_an_already_inactive_service_without_a_known_group_is_not_pruned(tmp_path):
    _, calls = _run(tmp_path, env={"FAKE_ACTIVE": "inactive", "FAKE_CGROUP": ""})
    assert "prune" not in _verbs(calls)


def test_a_service_that_came_back_before_the_prune_is_left_alone(tmp_path):
    _, calls = _run(tmp_path, env={"FAKE_ACTIVE": "inactive active"})
    assert "prune" not in _verbs(calls) and "install" in _verbs(calls)


def test_a_failed_refresh_never_fails_the_update(tmp_path):
    result, calls = _run(tmp_path, env={"FAKE_INSTALL": "1", "FAKE_REASON": "pip_failed"})
    assert "prune" not in _verbs(calls)
    assert "pip_failed" in result.stdout + result.stderr


def test_an_interpreter_the_catalog_lacks_leaves_the_component_alone(tmp_path):
    result, calls = _run(tmp_path, env={"FAKE_INSTALL": "3", "FAKE_REASON": "unsupported"})
    out = result.stdout + result.stderr
    assert "prune" not in _verbs(calls)
    assert "not available for this Python" in out and "try again" not in out


def test_a_root_owned_install_is_left_alone(tmp_path):
    result, calls = _run(tmp_path, steps="SERVICE_USER=root; " + UPDATE_STEPS)
    assert "install" not in _verbs(calls) and "prune" not in _verbs(calls)
    out = result.stdout + result.stderr
    assert out.count("belongs to root") == 1  # said once, by the refresh; the prune is silent about it


def test_nothing_old_to_prune_needs_no_proof_and_says_nothing(tmp_path):
    """Without an earlier bundle there is nothing to keep: no proof is asked and no «kept» warning is printed —
    on cgroup v1 it otherwise appeared on every update (shell review S8)."""
    result, calls = _run(tmp_path, old_bundle=False, env={"FAKE_FS": "tmpfs"})
    assert "install" in _verbs(calls) and "prune" not in _verbs(calls)
    assert "kept" not in (result.stdout + result.stderr).lower()


def test_a_state_that_cannot_be_read_is_said_not_swallowed(tmp_path):
    result, calls = _run(tmp_path, env={"FAKE_STATUS_RC": "1"})
    assert "install" not in _verbs(calls) and "prune" not in _verbs(calls)
    assert "could not be read" in result.stdout + result.stderr


def test_update_sh_prunes_last_just_before_the_start():
    text = UPDATE_SH.read_text(encoding="utf-8")
    start = text.index('log "Starting service: $SERVICE_NAME"')
    assert text.index("(refresh_step_preview)") < text.index("Building frontend") < text.index("(prune_step_preview)")
    assert text.index("repair_loop_flag\n") < text.index("(prune_step_preview)") < start
    stop = text.index('systemctl stop "$SERVICE_NAME"')
    proven = text.index("STEP_STOP_PROVEN=1")
    assert stop < proven < text.index("(refresh_step_preview)")


def test_the_group_is_recorded_whatever_the_state(tmp_path):
    result, _ = _run(
        tmp_path,
        env={"FAKE_ACTIVE": "failed"},
        steps='record_service_cgroup; echo "GROUP=[$SERVICE_CGROUP]"',
    )
    assert f"GROUP=[{GROUP}]" in result.stdout


def test_update_sh_records_before_the_stop_and_refreshes_after_the_render_runtime():
    text = UPDATE_SH.read_text(encoding="utf-8")
    body = text.split('log "Stopping service: $SERVICE_NAME"', 1)
    assert "record_service_cgroup" in body[0].splitlines()[-1] or "record_service_cgroup\n" in body[0][-200:]
    assert text.index("refresh_render_runtime)") < text.index("(refresh_step_preview)")
