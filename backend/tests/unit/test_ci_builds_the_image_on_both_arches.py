"""CI builds the production image natively on arm64 as well as x64, and publishes nothing (owner, 2026-10-17).

Every release publishes both arches, but CI used to build x64 only: a release tag was the first arm64 build the
image ever had, and the STEP bundle's arm64 wheels met the image for the first time on the way to users. The arm64
job runs every check the x64 job runs on the image itself, on a native runner, and has no way to push it."""

from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
CI = ROOT / ".github" / "workflows" / "ci.yml"


def _jobs() -> dict:
    return yaml.safe_load(CI.read_text(encoding="utf-8"))["jobs"]


def _image_checks(job: dict) -> list[str]:
    """The commands that run inside the built image (``docker run ... bamdude:test``)."""
    return [s["run"] for s in job["steps"] if "run" in s and "docker run" in s["run"] and "bamdude:test" in s["run"]]


def test_the_image_is_built_and_checked_natively_on_arm64():
    jobs = _jobs()
    x64, arm64 = jobs["docker-test"], jobs["docker-test-arm64"]
    assert arm64["runs-on"] == "ubuntu-24.04-arm"
    assert arm64["needs"] == x64["needs"] and arm64["if"] == x64["if"]  # gated exactly as the x64 image
    assert arm64["env"].get("STEP_PREVIEW_CANDIDATE") == x64["env"]["STEP_PREVIEW_CANDIDATE"]
    assert _image_checks(x64) and set(_image_checks(x64)) <= set(_image_checks(arm64))
    runs = " ".join(s.get("run", "") for s in arm64["steps"])
    assert "--build-arg STEP_PREVIEW_CANDIDATE" in runs
    assert "Architecture" in runs and "arm64" in runs  # it proves the image it checked is arm64


def _workflows():
    for path in sorted((ROOT / ".github" / "workflows").glob("*.yml")):
        yield path.name, yaml.safe_load(path.read_text(encoding="utf-8"))


def test_an_image_built_to_be_checked_carries_the_candidate_pin_and_a_published_one_never_does():
    """The Dockerfile refuses a candidate STEP pin unless STEP_PREVIEW_CANDIDATE=1 (a release must never ship one).
    So every image built to be TESTED or SCANNED asks for it — the Trivy scan of the Security Audit built without it
    and failed on every push while the pin was a candidate — and no image built to be PUBLISHED ever does."""
    checked, published = [], []
    for name, workflow in _workflows():
        for job_name, job in workflow["jobs"].items():
            env = {**(workflow.get("env") or {}), **(job.get("env") or {})}
            for step in job.get("steps", []):
                run = step.get("run", "")
                if "docker build" in run:
                    explicit = "--build-arg STEP_PREVIEW_CANDIDATE=1" in run
                    from_env = (
                        "--build-arg STEP_PREVIEW_CANDIDATE " in run + " " and env.get("STEP_PREVIEW_CANDIDATE") == "1"
                    )
                    checked.append((name, job_name, explicit or from_env))
                if step.get("uses", "").startswith("docker/build-push-action@"):
                    published.append((name, job_name, "STEP_PREVIEW_CANDIDATE" in yaml.safe_dump(step)))
    assert ("security.yml", "trivy", True) in checked
    assert [c for c in checked if not c[2]] == []
    assert published and [p for p in published if p[2]] == []


def test_the_arm64_job_can_publish_nothing():
    job = _jobs()["docker-test-arm64"]
    uses = [s["uses"] for s in job["steps"] if "uses" in s]
    assert all(u.startswith("actions/checkout@") for u in uses), uses  # no login, no build-push action
    runs = " ".join(s.get("run", "") for s in job["steps"])
    assert "docker push" not in runs and "docker login" not in runs and "--push" not in runs
    assert "secrets." not in yaml.safe_dump(job)
