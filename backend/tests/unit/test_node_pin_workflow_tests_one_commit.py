"""node-pin.yml tests and reports ONE commit (part-render-node-lines-spec D7, consilium NL2-R1)."""

from pathlib import Path

import yaml

WORKFLOWS = Path(__file__).resolve().parents[3] / ".github" / "workflows"


def _load(name: str) -> dict:
    return yaml.safe_load((WORKFLOWS / name).read_text(encoding="utf-8"))


def test_the_smoke_is_handed_the_fixed_candidate_never_the_branch_name():
    jobs = _load("node-pin.yml")["jobs"]
    assert jobs["publish"]["outputs"]["candidate"] == "${{ steps.candidate.outputs.sha }}"
    assert jobs["smoke"]["with"]["ref"] == "${{ needs.publish.outputs.candidate }}"
    assert "needs.publish.outputs.candidate != ''" in jobs["smoke"]["if"]  # no candidate, no smoke


def test_the_report_names_the_tested_commit_apart_from_the_current_head():
    steps = _load("node-pin.yml")["jobs"]["report"]["steps"]
    issue = next(step for step in steps if "node_pin_report.py issue" in step.get("run", ""))
    assert issue["env"]["TESTED"] == "${{ needs.publish.outputs.candidate }}"
    assert "--tested-sha" in issue["run"] and "--current-sha" in issue["run"]


def test_every_smoke_checkout_takes_the_ref_and_checks_it():
    for name, job in _load("part-render-smoke.yml")["jobs"].items():
        checkout = next(step for step in job["steps"] if str(step.get("uses", "")).startswith("actions/checkout"))
        assert checkout["with"]["ref"] == "${{ inputs.ref }}", name
        assert any("git rev-parse HEAD" in step.get("run", "") for step in job["steps"]), name


def _runs(job: dict) -> str:
    return "\n".join(step.get("run", "") for step in job["steps"])


def test_the_job_that_makes_the_pin_holds_no_write_token():
    # final review I1: ~100 unhashed dependencies and the probe run in this job -- it may read, never push
    job = _load("node-pin.yml")["jobs"]["repin"]
    assert job["permissions"] == {"contents": "read"}
    checkout = next(step for step in job["steps"] if str(step.get("uses", "")).startswith("actions/checkout"))
    assert checkout["with"]["persist-credentials"] is False
    assert "requirements.txt" not in _runs(job) and "pip install psutil pillow" in _runs(job)


def test_the_job_that_pushes_verifies_the_pin_and_installs_nothing():
    job = _load("node-pin.yml")["jobs"]["publish"]
    assert job["permissions"] == {"contents": "write"}
    runs = _runs(job)
    assert "pip install" not in runs
    assert runs.index("pin_render_runtime.py --verify") < runs.index("git push")


def test_every_checkout_takes_the_base_and_the_base_defaults_to_dev():
    # final review I3: a live run on a temporary branch must be able to read that branch
    workflow = _load("node-pin.yml")
    assert "inputs.base" in workflow["env"]["BASE"] and "'dev'" in workflow["env"]["BASE"]
    for name, job in workflow["jobs"].items():
        for step in job.get("steps", []):
            if str(step.get("uses", "")).startswith("actions/checkout"):
                assert step["with"]["ref"] == "${{ env.BASE }}", name


def test_the_issue_lives_only_while_there_is_an_action():
    # final review M1/M7: notices go to the run summary, a pin with nothing left to do closes the issue
    runs = _runs(_load("node-pin.yml")["jobs"]["report"])
    assert "gh issue close" in runs and "GITHUB_STEP_SUMMARY" in runs


def test_the_push_job_holds_the_pin_to_the_check_and_the_base_golden():
    # security review: the artifact comes from the job that ran third-party packages -- the push job re-checks the
    # version the check chose, the golden against the base's, and that nothing but the two pin files changed
    runs = _runs(_load("node-pin.yml")["jobs"]["publish"])
    assert "--expect" in runs and "--base-golden" in runs
    assert "the pin artifact touched" in runs
    assert runs.index("--expect") < runs.index("git push")


def test_no_job_reads_back_an_artifact_the_untrusted_job_could_replace():
    # security review (artifact poisoning): the job that ran third-party packages holds the run's artifact token
    # and could re-upload node-pin-check; the check's report travels as an immutable job output instead
    jobs = _load("node-pin.yml")["jobs"]
    for name in ("publish", "report"):
        for step in jobs[name]["steps"]:
            if str(step.get("uses", "")).startswith("actions/download-artifact"):
                assert step["with"]["name"] != "node-pin-check", name
        assert any(
            step.get("env", {}).get("CHECK") == "${{ needs.check.outputs.report }}" for step in jobs[name]["steps"]
        ), name
    assert jobs["check"]["outputs"]["report"] == "${{ steps.check.outputs.report }}"
