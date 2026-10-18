"""The Windows installer workflow (spec stage B R6, R13; plan Task 7): only a pushed tag publishes, only after the
FULL acceptance of the very artifact it publishes, never a candidate pin; the acceptance runs every scenario on a
real Windows runner without secrets and without a window nobody can answer."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW_TEXT = (ROOT / ".github" / "workflows" / "windows-installer.yml").read_text(encoding="utf-8")
WORKFLOW = yaml.safe_load(WORKFLOW_TEXT)
JOBS = WORKFLOW["jobs"]
ACCEPT = (ROOT / "scripts" / "windows_installer_acceptance.ps1").read_text(encoding="utf-8")
CHECK = ROOT / "scripts" / "check_release_payload.py"


def _runs(job: str) -> str:
    return "\n".join(str(step.get("run", "")) + str(step.get("uses", "")) for step in JOBS[job].get("steps", []))


def test_only_a_pushed_tag_publishes_and_only_after_full_acceptance():
    release = JOBS["release"]
    assert release["needs"] == "acceptance" or release["needs"] == ["acceptance"]
    condition = release["if"]
    assert "github.event_name == 'push'" in condition
    assert "startsWith(github.ref, 'refs/tags/v')" in condition
    assert "needs.acceptance.outputs.full == 'true'" in condition
    assert JOBS["acceptance"]["needs"] in ("build", ["build"])
    assert "softprops/action-gh-release" in _runs("release")
    assert all("softprops/action-gh-release" not in _runs(job) for job in JOBS if job != "release")


def test_a_tag_never_builds_or_publishes_a_candidate():
    inputs = (WORKFLOW.get("on") or WORKFLOW.get(True))["workflow_dispatch"]["inputs"]
    assert inputs["step_preview_candidate"]["default"] is False
    stage = next(s for s in JOBS["build"]["steps"] if "build.py" in str(s.get("run", "")))
    assert stage["env"]["CANDIDATE"] == "${{ github.ref_type != 'tag' && inputs.step_preview_candidate }}"
    assert "$env:CANDIDATE -eq 'true'" in stage["run"]
    assert WORKFLOW_TEXT.count("--allow-candidate-cad") == 1  # nowhere else
    assert "check_release_payload.py check" in _runs("release")


def test_the_release_publishes_the_accepted_artifact_without_rebuilding():
    runs = _runs("release")
    assert "build.py" not in runs and "ISCC" not in runs
    assert "actions/download-artifact" in runs


def test_the_full_acceptance_runs_every_scenario():
    scenarios = ["S1", "S2", "S3", "S4", "S4b", "S5", "S8", "S6", "S7", "S0"]
    for name in scenarios:
        assert re.search(rf"^function {name} \{{", ACCEPT, re.M), name
    full = re.search(r"\$Full = @\(([^)]*)\)", ACCEPT).group(1)
    assert [n.strip().strip("'") for n in full.split(",")] == scenarios
    starts = re.findall(r"Start-Process[^\n]*", ACCEPT)
    assert starts and all("-PassThru" in s for s in starts)
    setup = re.search(r"^function Invoke-Setup \{.*?^\}", ACCEPT, re.M | re.S).group(0)
    for flag in ("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG="):
        assert flag in setup, flag
    assert "WaitForExit" in setup and "taskkill" in setup  # a deadline, and the whole tree ended past it
    assert "53d4579e114a2f1622dc702118e91344503d929eb80b57fd30513414940563a2" in ACCEPT  # v0.7.0, the exact asset


def test_check_release_payload_refuses_candidate_or_another_exe(tmp_path):
    exe = tmp_path / "setup.exe"
    exe.write_bytes(b"MZ installer bytes")
    sha = hashlib.sha256(exe.read_bytes()).hexdigest()

    def check(payload: dict, acceptance: dict) -> int:
        (tmp_path / "payload.json").write_text(json.dumps(payload), encoding="utf-8")
        (tmp_path / "acceptance.json").write_text(json.dumps(acceptance), encoding="utf-8")
        cmd = [
            sys.executable,
            str(CHECK),
            "check",
            "--exe",
            str(exe),
            "--payload",
            str(tmp_path / "payload.json"),
            "--acceptance",
            str(tmp_path / "acceptance.json"),
        ]
        return subprocess.run(cmd, capture_output=True, timeout=60).returncode

    good_payload = {"sha256": sha, "receipt_status": "release"}
    good = {"sha256": sha, "installed_receipt_status": "release", "full": True, "scenarios": {"S1": "passed"}}
    assert check(good_payload, good) == 0
    assert check({**good_payload, "receipt_status": "candidate"}, good) == 1
    assert check(good_payload, {**good, "installed_receipt_status": "candidate"}) == 1
    assert check(good_payload, {**good, "sha256": "0" * 64}) == 1
    assert check({**good_payload, "sha256": "0" * 64}, good) == 1
    assert check(good_payload, {**good, "full": False}) == 1
    assert check(good_payload, {**good, "scenarios": {"S1": "failed: x"}}) == 1


def test_the_acceptance_holds_no_secrets():
    assert "secrets." not in WORKFLOW_TEXT
    assert WORKFLOW["permissions"] == {"contents": "read"}
    for job in ("build", "acceptance"):
        assert JOBS[job]["permissions"] == {"contents": "read"}, job
    assert JOBS["release"]["permissions"] == {"contents": "write"}
