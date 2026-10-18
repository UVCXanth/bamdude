"""The native install acceptance (spec stage C R12; plan Task 9): a dispatch-only workflow, one job per scenario,
GitHub redirected to a local remote that serves the candidate for every git context, the installed code proven by its
HEAD and the service by its process, a finite "y" for update.sh's questions and the phases it must reach.

The workflow itself only runs on disposable runners; here its structure is read, and the harness's pure-git and
reporting halves run for real."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from backend.tests.unit.test_update_script_repairs_loop_flag import BASH

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github" / "workflows" / "native-install-acceptance.yml"
SCRIPT = ROOT / "scripts" / "native_install_acceptance.sh"
SCENARIOS = ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "F1", "M1"]
LINUX = ["N1", "N2", "N3", "N4", "N5", "N6", "N7"]


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def _script() -> str:
    return SCRIPT.read_text(encoding="utf-8")


def _function(name: str) -> str:
    """The body of one shell function of the harness, up to its closing brace at column 0."""
    match = re.search(rf"^{re.escape(name)}\(\) \{{[^\n]*\n(.*?)^\}}", _script(), re.S | re.M)
    assert match, f"no function {name} in the harness"
    return match.group(1)


def _scenario_jobs() -> dict[str, dict]:
    jobs = _workflow()["jobs"]
    found = {}
    for job in jobs.values():
        for step in job.get("steps", []):
            m = re.search(r"native_install_acceptance\.sh (N[1-7]|F1|M1)\b", step.get("run", ""))
            if m:
                found[m.group(1)] = job
    return found


def test_the_native_acceptance_runs_only_by_hand_without_secrets():
    wf = _workflow()
    triggers = wf.get("on", wf.get(True))  # YAML 1.1 reads a bare `on` as True
    assert set(triggers) == {"workflow_dispatch"}
    assert set(triggers["workflow_dispatch"]["inputs"]["scope"]["options"]) == {"full", "diagnostic"}
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "secrets." not in text and "GITHUB_TOKEN" not in text and "github.token" not in text
    assert wf["permissions"] == {"contents": "read"}
    for job in wf["jobs"].values():
        assert job.get("permissions", {"contents": "read"}) == {"contents": "read"}
        for step in job.get("steps", []):
            if str(step.get("uses", "")).startswith("actions/checkout@"):
                assert step["with"]["persist-credentials"] is False


def test_every_scenario_is_its_own_job():
    jobs = _scenario_jobs()
    assert sorted(jobs) == sorted(SCENARIOS)
    assert len({id(job) for job in jobs.values()}) == len(SCENARIOS)
    for name, job in jobs.items():
        needs = job["needs"] if isinstance(job["needs"], list) else [job["needs"]]
        assert "fixture" in needs, name
        assert 0 < job["timeout-minutes"] <= 120, name
        always = [s for s in job["steps"] if s.get("if") == "always()"]
        assert any(f"native_install_acceptance.sh cleanup {name}" in s.get("run", "") for s in always), name
        assert any(
            s.get("with", {}).get("name") == f"native-acceptance-{name}"
            and s["with"]["path"].endswith(f"native-acceptance-{name}.json")
            for s in always
        ), name
    assert all(jobs[n]["runs-on"] == "ubuntu-latest" for n in LINUX)
    assert jobs["F1"]["container"]["image"] == "fedora:latest"
    assert jobs["M1"]["runs-on"] == "macos-latest"


def test_the_diagnostic_scope_runs_a_named_subset():
    jobs = _scenario_jobs()
    full_only = {n for n, job in jobs.items() if job.get("if") == "inputs.scope == 'full'"}
    assert full_only == set(SCENARIOS) - {"N1", "N2", "F1"}


def test_the_installed_code_is_proven_by_its_head():
    head = _function("expect_head")
    assert "rev-parse HEAD" in head and "fail" in head
    for name in SCENARIOS:
        body = _function(f"scenario_{name}")
        lines = [ln.strip() for ln in body.splitlines() if ln.strip() and not ln.strip().startswith("#")]
        for i, line in enumerate(lines):
            if re.match(r"(install_linux|install_macos|run_update|clone_as_ci)\b", line):
                assert lines[i + 1].startswith("expect_head "), f"{name}: no HEAD check after `{line}`"
    n3 = _function("scenario_N3")
    assert (
        n3.index('expect_head install "$BASELINE"')
        < n3.index("run_update")
        < n3.index('expect_head update "$CANDIDATE"')
    )


def test_the_service_is_the_one_installed():
    ours = _function("service_is_ours")
    assert "MainPID" in ours
    assert "/proc/$pid/cwd" in ours and "INSTALL_PATH" in ours
    assert "sport = :$PORT" in ours and "pid=$pid," in ours
    for name in LINUX:
        body = _function(f"scenario_{name}")
        assert "service_is_ours" in body, name
        if "http " in body:
            assert body.index("service_is_ours") < body.index("http "), name


def test_github_is_redirected_to_the_fixture_for_root_too():
    setup = _function("fixture_setup_linux")
    assert re.search(r"sudo git config --system url\.\"file://\$FIXTURE\"\.insteadOf \"\$REPO_URL\"", setup)
    assert re.search(r"sudo git config --system --add safe\.directory \"\$FIXTURE\"", setup)
    assert re.search(r"\$\(git ls-remote --get-url \"\$REPO_URL\"\)", setup)
    assert re.search(r"sudo git ls-remote --get-url \"\$REPO_URL\"", setup)
    assert setup.rindex("--get-url") < setup.index("remote_main_is")  # offline first, then the real one
    real = _function("remote_main_is")
    assert '$(git ls-remote "$REPO_URL"' in real and 'sudo git ls-remote "$REPO_URL"' in real
    assert setup.index("sudo git config --system") < setup.index("--get-url")
    assert 'REPO_URL="https://github.com/kainpl/bamdude.git"' in _script()
    for name in LINUX:
        body = _function(f"scenario_{name}")
        assert body.index("fixture_setup_linux") < body.index("install_linux"), name
    mac = _function("fixture_setup_macos")
    assert "git config --global url." in mac and "--get-url" in mac


def test_update_prompts_get_a_finite_yes_and_phases_are_checked():
    text = _script()
    assert not re.search(r"\byes\s*\|", text)
    update = _function("run_update")
    outside = text.replace(update, "")
    for line in outside.splitlines():
        code = line.split("#", 1)[0]
        if re.search(r"update\.sh", code):  # every other mention passes the script to run_update, never runs it
            assert re.match(r"\s*run_update ", code), line
    assert re.search(r"printf 'y\\ny\\n' \| logged update \"\$UPDATE_SECONDS\"", update)
    assert "bounded" in _function("logged") and "timeout" in _function("bounded")
    phases = _function("update_phases")
    for phase in ("Stopping service: bamdude", "Updating the STEP preview component", "Starting service: bamdude"):
        assert phase in phases
    for name in ("N3", "N4", "N7"):
        body = _function(f"scenario_{name}")
        after = body[body.index("run_update") :]
        want = "stop cad prune start" if name in ("N4", "N7") else "stop cad start"
        assert f"update_phases update {want}" in after, name


def _bash():
    if not shutil.which("git") or not BASH:
        pytest.skip("named skip: git or bash is not available")
    return BASH


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def test_the_fixture_serves_the_candidate_and_the_previous_release(tmp_path):
    bash = _bash()
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    for n, tag in ((1, "v0.6.1"), (2, "v0.7.0b1"), (3, "v0.7.0"), (4, None)):
        (repo / "f.txt").write_text(str(n), encoding="utf-8")
        _git(repo, "add", "f.txt")
        _git(repo, "-c", "user.email=a@b", "-c", "user.name=n", "commit", "-q", "-m", f"c{n}")
        if tag:
            _git(repo, "tag", tag)
    candidate = _git(repo, "rev-parse", "HEAD")
    out = tmp_path / "fixture"
    result = subprocess.run(
        [bash, SCRIPT.as_posix(), "fixture", out.as_posix(), candidate],
        cwd=repo,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    meta = json.loads((out / "fixture.json").read_text(encoding="utf-8"))
    assert meta == {
        "schema": 1,
        "candidate": candidate,
        "baseline": _git(repo, "rev-parse", "v0.7.0^{commit}"),
        "baseline_tag": "v0.7.0",
    }
    unpacked = tmp_path / "unpacked"
    unpacked.mkdir()
    subprocess.run(["tar", "-xf", "fixture/bamdude.git.tar", "-C", "unpacked"], cwd=tmp_path, check=True)
    heads = _git(unpacked, "--git-dir", "bamdude.git", "for-each-ref", "--format=%(refname) %(objectname)")
    assert heads.splitlines() == [
        f"refs/heads/baseline {meta['baseline']}",
        f"refs/heads/main {candidate}",
    ]


def test_a_failed_scenario_still_writes_its_report(tmp_path):
    bash = _bash()
    reports = tmp_path / "reports"
    result = subprocess.run(
        [bash, SCRIPT.as_posix(), "N1", (tmp_path / "no-fixture").as_posix()],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "REPORT_DIR": reports.as_posix(), "RUNNER_TEMP": tmp_path.as_posix()},
    )
    assert result.returncode != 0
    report = json.loads((reports / "native-acceptance-N1.json").read_text(encoding="utf-8"))
    assert report["scenario"] == "N1" and report["result"] == "failed"
    assert "fixture" in report["failure"]


def _sourced(tmp_path: Path, steps: str) -> tuple[int, str]:
    """Run steps against the harness's own functions, sourced under its own options."""
    program = "\n".join(
        [
            f"export REPORT_DIR='{(tmp_path / 'reports').as_posix()}' RUNNER_TEMP='{tmp_path.as_posix()}'",
            f"source '{SCRIPT.as_posix()}'",
            "rc=0",
            f"( {steps} ) || rc=$?",
            'echo "RC=$rc"',
        ]
    )
    script = tmp_path / "steps.sh"
    script.write_text(program, encoding="utf-8", newline="\n")
    result = subprocess.run([_bash(), script.as_posix()], capture_output=True, text=True, timeout=60)
    rc = re.search(r"RC=(\d+)", result.stdout)
    assert rc, result.stdout + result.stderr
    return int(rc.group(1)), result.stdout + result.stderr


UPDATE_LOG = """[bamdude-update] Stopping service: bamdude
[bamdude-update] Updating the STEP preview component (if enabled)
[bamdude-update] Starting service: bamdude
[bamdude-update] Update complete: aaaaaaa -> bbbbbbb
"""


@pytest.mark.parametrize(
    ("log", "phases", "missing"),
    [
        (UPDATE_LOG, "stop cad prune start", None),
        (UPDATE_LOG.replace("[bamdude-update] Starting service: bamdude\n", ""), "stop cad start", "start"),
        (UPDATE_LOG.replace("(if enabled)", ""), "stop cad start", "cad"),
        (
            UPDATE_LOG + "[WARN] The old STEP preview component was kept: the stop could not be proven\n",
            "prune",
            "prune",
        ),
    ],
)
def test_update_phases_refuses_a_log_that_missed_one(tmp_path, log, phases, missing):
    logs = tmp_path / "reports" / "logs"
    logs.mkdir(parents=True)
    (logs / "update.log").write_text(log, encoding="utf-8", newline="\n")
    rc, out = _sourced(tmp_path, f"update_phases update {phases}")
    if missing is None:
        assert rc == 0, out
    else:
        assert rc == 1 and f"did not reach its {missing} phase" in out, out


def test_expect_head_refuses_another_commit(tmp_path):
    _bash()  # the named skip before any git: an image without git skips, never errors
    repo = tmp_path / "install"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "-c", "user.email=a@b", "-c", "user.name=n", "commit", "-q", "--allow-empty", "-m", "x")
    head = _git(repo, "rev-parse", "HEAD")
    rc, out = _sourced(tmp_path, f"INSTALL_PATH='{repo.as_posix()}'; expect_head install {head}; echo \"$HEADS\"")
    assert rc == 0 and f'"expected": "{head}", "actual": "{head}"' in out, out
    rc, out = _sourced(tmp_path, f"INSTALL_PATH='{repo.as_posix()}'; expect_head install {'0' * 40}")
    assert rc == 1 and f"HEAD is {head}, expected {'0' * 40}" in out, out


def test_the_harness_parses_and_has_lf_endings():
    bash = _bash()
    assert SCRIPT.read_bytes().startswith(b"#!/usr/bin/env bash\n") and b"\r\n" not in SCRIPT.read_bytes()
    result = subprocess.run([bash, "-n", SCRIPT.as_posix()], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
