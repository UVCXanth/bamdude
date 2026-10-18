"""update.sh changes the install's files as the install's owner, never as root (Codex C-I review, the updater's
ownership): git — the rollback included —, the venv's pip and npm run as the owner, who must be the service's user;
root keeps systemd. A root-run git met "dubious ownership" in the service user's tree on every fresh install, and
root-run writes left files the service could not change. Root-owned leftovers of earlier updates stop the update
before anything changes, with an explicit repair — never a hidden chown."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from backend.tests.unit.test_update_script_repairs_loop_flag import BASH

ROOT = Path(__file__).resolve().parents[3]
UPDATE_SH = ROOT / "install" / "update.sh"

pytestmark = pytest.mark.skipif(BASH is None, reason="named skip: bash is not available")


def _text() -> str:
    return UPDATE_SH.read_text(encoding="utf-8").replace("\r\n", "\n")


def _lifted(name: str) -> str:
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}\n", _text(), re.S | re.M)
    assert match, f"update.sh must define {name}()"
    return match.group(0)


PRELUDE = r"""
set -Eeuo pipefail
log() { printf '[bamdude-update] %s\n' "$*"; }
warn() { printf '[bamdude-update] WARN: %s\n' "$*" >&2; }
die() { printf '[bamdude-update] ERROR: %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"; }
"""


def _run(tmp_path: Path, body: str) -> subprocess.CompletedProcess:
    script = tmp_path / "run.sh"
    script.write_text(PRELUDE + body + '\necho "RC=0"\n', encoding="utf-8", newline="\n")
    return subprocess.run([BASH, script.as_posix()], capture_output=True, text=True, timeout=60)


@pytest.mark.parametrize(
    ("owner", "unit_user", "ok", "expected"),
    [
        ("bamdude", "bamdude", True, "bamdude"),
        ("root", "", True, "root"),  # a unit without User= runs as root
        ("bamdude", "", False, None),
        ("root", "bamdude", False, None),
        ("UNKNOWN", "bamdude", False, None),
    ],
)
def test_the_owner_must_be_the_services_user(tmp_path, owner, unit_user, ok, expected):
    body = "\n".join(
        [
            f'stat() {{ echo "{owner}"; }}',
            f'systemctl() {{ echo "{unit_user}"; }}',
            "sudo() { :; }",
            'INSTALL_DIR=/opt/bamdude SERVICE_NAME=bamdude INSTALL_OWNER=""',
            _lifted("resolve_install_owner"),
            'resolve_install_owner; echo "OWNER=$INSTALL_OWNER"',
        ]
    )
    result = _run(tmp_path, body)
    if ok:
        assert f"OWNER={expected}" in result.stdout, result.stderr
    else:
        assert result.returncode == 1 and "RC=0" not in result.stdout
        assert "Nothing was changed" in result.stderr, result.stderr


@pytest.mark.parametrize(("failing", "says"), [("systemctl", "runs as"), ("stat", "owns")])
def test_an_identity_that_cannot_be_read_stops_the_update(tmp_path, failing, says):
    """Codex C-I2-R1: a failed read is not an empty answer. `systemctl show` failing with nothing on stdout was read
    as "a unit without User=", that is root — on a root-owned tree, a match nobody proved."""
    stubs = {"stat": "stat() { echo root; }", "systemctl": 'systemctl() { echo ""; }'}
    stubs[failing] = f"{failing}() {{ return 1; }}"
    body = "\n".join(
        [
            *stubs.values(),
            "sudo() { :; }",
            'INSTALL_DIR=/opt/bamdude SERVICE_NAME=bamdude INSTALL_OWNER=""',
            _lifted("resolve_install_owner"),
            'resolve_install_owner; echo "OWNER=$INSTALL_OWNER"',
        ]
    )
    result = _run(tmp_path, body)
    assert result.returncode == 1 and "OWNER=" not in result.stdout, result.stdout
    assert says in result.stderr and "Nothing was changed" in result.stderr, result.stderr


@pytest.mark.parametrize(
    ("code", "stray", "accepted"), [(0, "", True), (1, "", False), (1, "/opt/bamdude/venv/x", False)]
)
def test_a_scan_that_did_not_finish_is_no_proof_of_a_clean_tree(tmp_path, code, stray, accepted):
    """An empty list from a scan that failed proves nothing; only a finished one may say "nobody else's"."""
    body = "\n".join(
        [
            f"find() {{ [ -n '{stray}' ] && echo '{stray}'; return {code}; }}",
            "INSTALL_DIR=/opt/bamdude BACKUP_DIR=/opt/bamdude/backups INSTALL_OWNER=bamdude",
            _lifted("check_owner_can_write"),
            "check_owner_can_write",
        ]
    )
    result = _run(tmp_path, body)
    if accepted:
        assert "RC=0" in result.stdout, result.stderr
    else:
        assert result.returncode == 1 and "Nothing was changed" in result.stderr, result.stderr
        assert ("venv/x" in result.stderr) == bool(stray), result.stderr


@pytest.mark.parametrize(("owner", "expected"), [("bamdude", "sudo -H -u bamdude git status"), ("root", "git status")])
def test_a_file_operation_runs_as_the_owner(tmp_path, owner, expected):
    calls = tmp_path / "calls.txt"
    body = "\n".join(
        [
            f"CALLS='{calls.as_posix()}'",
            'sudo() { echo "sudo $*" >> "$CALLS"; }',
            'git() { echo "git $*" >> "$CALLS"; }',
            f"INSTALL_OWNER={owner}",
            _lifted("as_owner"),
            "as_owner git status",
        ]
    )
    result = _run(tmp_path, body)
    assert "RC=0" in result.stdout, result.stderr
    assert calls.read_text(encoding="utf-8").splitlines() == [expected]


def _without_heredocs(text: str) -> str:
    return re.sub(r"<<\s*'?EOF'?\n.*?^EOF\n", "<<EOF\n", text, flags=re.S | re.M)


def test_every_file_operation_of_the_update_runs_as_the_owner():
    for line in _without_heredocs(_text()).splitlines():
        code = line.split("#", 1)[0]
        runs = re.search(r"(^|[\s(;&|])(git|npm)\s", code) or '"$VENV_PIP" install' in code
        if runs and not re.search(r"^\s*(log|warn|die)\b", code) and "command -v" not in code:
            assert "as_owner" in code, line


def test_the_owner_is_checked_before_anything_changes():
    text = _without_heredocs(_text())
    calls = [m.start() for m in re.finditer(r"^resolve_install_owner$", text, re.M)]
    checks = [m.start() for m in re.finditer(r"^check_owner_can_write$", text, re.M)]
    assert len(calls) == 1 and len(checks) == 1
    first_git = text.index("as_owner git", text.index("\nresolve_install_owner\n"))
    assert calls[0] < first_git
    assert calls[0] < checks[0] < text.index("\ncreate_backup\n") < text.index('systemctl stop "$SERVICE_NAME"')


def _posix_root_with_a_user() -> str:
    if os.name == "nt" or os.geteuid() != 0:
        pytest.skip("named skip: needs root on POSIX to make files another user owns")
    for name in ("tester", "nobody"):
        if subprocess.run(["id", "-u", name], capture_output=True).returncode == 0:
            return name
    pytest.skip("named skip: no unprivileged user to own the tree")


def _owned_tree(tmp_path: Path, user: str) -> Path:
    tree = tmp_path / "bamdude"
    for rel in ("venv/bin", "frontend", "data", "logs", "backups", "runtime/step-preview", ".git"):
        (tree / rel).mkdir(parents=True)
    for rel in ("venv/bin/python", "frontend/package.json", ".git/HEAD"):
        (tree / rel).write_text("x", encoding="utf-8")
    subprocess.run(["chown", "-R", f"{user}:", str(tree)], check=True)
    os.chmod(tmp_path, 0o755)
    return tree


@pytest.mark.parametrize(
    ("leftover", "stops"),
    [
        ("venv/bin/pip", True),
        (".git/objects", True),
        ("data/x.db", False),
        ("backups/b.zip", False),
        ("runtime/step-preview/k", False),
    ],
)
def test_root_owned_leftovers_stop_the_update_before_it_changes_anything(tmp_path, leftover, stops):
    user = _posix_root_with_a_user()
    tree = _owned_tree(tmp_path, user)
    (tree / leftover).parent.mkdir(parents=True, exist_ok=True)
    (tree / leftover).write_text("root's", encoding="utf-8")  # created by root: root-owned
    body = "\n".join(
        [
            f"INSTALL_DIR='{tree}' BACKUP_DIR='{tree}/backups' INSTALL_OWNER={user}",
            _lifted("check_owner_can_write"),
            "check_owner_can_write",
        ]
    )
    result = _run(tmp_path, body)
    if stops:
        assert result.returncode == 1 and "Nothing was changed" in result.stderr, result.stderr
        assert f"sudo chown -R {user}:" in result.stderr
    else:
        assert "RC=0" in result.stdout, result.stderr


def test_git_as_the_owner_updates_a_service_owned_checkout(tmp_path):
    """The defect and its cure on a real checkout the service user owns: root's git refuses it; the owner's git
    fetches and resets it, and every file it writes stays the owner's."""
    user = _posix_root_with_a_user()
    if not shutil.which("git") or not shutil.which("setpriv"):
        pytest.skip("named skip: needs git and setpriv")
    import tempfile

    shared = Path(tempfile.mkdtemp(dir="/tmp"))  # pytest's own tmp is root's 0700: the owner could not reach it
    shared.chmod(0o755)
    try:
        _owner_updates(shared, user)
    finally:
        shutil.rmtree(shared, ignore_errors=True)


def _owner_updates(tmp_path: Path, user: str) -> None:
    git = ["git", "-c", "user.email=a@b", "-c", "user.name=n"]
    source = tmp_path / "source"
    source.mkdir()
    subprocess.run([*git, "init", "-q", "-b", "main", str(source)], check=True)
    (source / "f").write_text("1", encoding="utf-8")
    subprocess.run([*git, "-C", str(source), "add", "f"], check=True)
    subprocess.run([*git, "-C", str(source), "commit", "-qm", "1"], check=True)
    checkout = tmp_path / "bamdude"
    subprocess.run(["git", "clone", "-q", source.as_uri(), str(checkout)], check=True)
    (source / "f").write_text("2", encoding="utf-8")
    (source / "g").write_text("new", encoding="utf-8")
    subprocess.run([*git, "-C", str(source), "add", "f", "g"], check=True)
    subprocess.run([*git, "-C", str(source), "commit", "-qm", "2"], check=True)
    new = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    subprocess.run(["chown", "-R", f"{user}:", str(checkout), str(source)], check=True)  # git judges the source too
    refused = subprocess.run(["git", "-C", str(checkout), "fetch", "-q", "origin"], capture_output=True, text=True)
    assert refused.returncode != 0 and "dubious ownership" in refused.stderr  # the defect, measured
    body = "\n".join(
        [
            # sudo as the box has it, made of setpriv: -H gives the owner's home, -u the owner
            'sudo() { local u=""; while [ $# -gt 0 ]; do case "$1" in -H) shift ;; -u) u="$2"; shift 2 ;; *) break ;; esac; done; '
            'setpriv --reuid="$u" --regid="$(id -g "$u")" --clear-groups env HOME=/tmp "$@"; }',
            f"INSTALL_OWNER={user}",
            _lifted("as_owner"),
            f"cd '{checkout}'",
            "as_owner git fetch -q origin",
            "as_owner git reset -q --hard origin/main",
        ]
    )
    result = _run(tmp_path, body)
    assert "RC=0" in result.stdout, result.stderr
    head = subprocess.run(
        ["git", "-c", f"safe.directory={checkout}", "-C", str(checkout), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
    )
    assert head.stdout.strip() == new
    strays = subprocess.run(["find", str(checkout), "!", "-user", user], capture_output=True, text=True).stdout
    assert strays == "", strays
