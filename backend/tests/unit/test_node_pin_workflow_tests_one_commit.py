"""node-pin.yml tests and reports ONE commit (part-render-node-lines-spec D7, consilium NL2-R1)."""

from pathlib import Path

import yaml

WORKFLOWS = Path(__file__).resolve().parents[3] / ".github" / "workflows"


def _load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def test_the_smoke_is_handed_the_fixed_candidate_never_the_branch_name():
    jobs = _load("node-pin.yml")["jobs"]
    assert jobs["repin"]["outputs"]["candidate"] == "${{ steps.candidate.outputs.sha }}"
    assert jobs["smoke"]["with"]["ref"] == "${{ needs.repin.outputs.candidate }}"
    assert "needs.repin.outputs.candidate != ''" in jobs["smoke"]["if"]  # no candidate, no smoke


def test_the_report_names_the_tested_commit_apart_from_the_current_head():
    steps = _load("node-pin.yml")["jobs"]["report"]["steps"]
    issue = next(step for step in steps if "node_pin_report.py issue" in step.get("run", ""))
    assert issue["env"]["TESTED"] == "${{ needs.repin.outputs.candidate }}"
    assert "--tested-sha" in issue["run"] and "--current-sha" in issue["run"]


def test_every_smoke_checkout_takes_the_ref_and_checks_it():
    for name, job in _load("part-render-smoke.yml")["jobs"].items():
        checkout = next(step for step in job["steps"] if str(step.get("uses", "")).startswith("actions/checkout"))
        assert checkout["with"]["ref"] == "${{ inputs.ref }}", name
        assert any("git rev-parse HEAD" in step.get("run", "") for step in job["steps"]), name
