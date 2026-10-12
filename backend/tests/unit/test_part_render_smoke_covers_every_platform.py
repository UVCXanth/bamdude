"""Every platform the pin ships has a smoke job (part-render-node-lines-spec D8, consilium NL-R3)."""

from pathlib import Path

import yaml

from backend.app.services.render_runtime import PLATFORMS

SMOKE = Path(__file__).resolve().parents[3] / ".github" / "workflows" / "part-render-smoke.yml"


def _smoke() -> dict:
    return yaml.safe_load(SMOKE.read_text(encoding="utf-8"))


def test_the_smoke_covers_every_pinned_platform():
    jobs = _smoke()["jobs"]
    covered = {row["platform"] for row in jobs["smoke"]["strategy"]["matrix"]["include"]}
    if "armv7" in jobs:
        covered.add("linux-armv7l")
    assert covered == set(PLATFORMS), f"missing {set(PLATFORMS) - covered}, unknown {covered - set(PLATFORMS)}"


def test_every_smoke_job_checks_the_platform_it_promises():
    steps = _smoke()["jobs"]["smoke"]["steps"]
    assert any("platform_key()" in step.get("run", "") and "matrix.platform" in step.get("run", "") for step in steps)
