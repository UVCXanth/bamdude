"""The tag's image is built natively on both arches and tagged from the digests it checked (owner, 2026-10-19).

The release built arm64 under QEMU, and the Dockerfile runs the STEP component's full verify — a real STEP turned
into a PNG under fixed 120 s child budgets — at build time: measured under emulation it passed with about twice the
headroom on a desktop, less on a hosted runner, and a failure would surface only after the immutable tag. Now amd64
and arm64 are built in parallel on native runners from one SHA, each pushed by digest only and checked inside the
pushed image on its own architecture, and the shared tags are composed from those checked digests — never rebuilt —
only after both builds and the sources check. A manual dispatch runs the same path and composes the list with
``--dry-run``: no tag is published."""

from __future__ import annotations

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github" / "workflows" / "docker-publish-tag.yml"


def _workflow() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def _jobs() -> dict:
    return _workflow()["jobs"]


def _runs(job: dict) -> str:
    return "\n".join(s.get("run", "") for s in job.get("steps", []))


def _step(job: dict, uses: str) -> dict:
    return next(s for s in job["steps"] if str(s.get("uses", "")).startswith(uses))


def test_both_arches_build_natively_in_parallel_from_one_sha():
    build = _jobs()["build"]
    pairs = {(m["platform"], m["runner"]) for m in build["strategy"]["matrix"]["include"]}
    assert pairs == {("linux/amd64", "ubuntu-24.04"), ("linux/arm64", "ubuntu-24.04-arm")}
    assert build["runs-on"] == "${{ matrix.runner }}"
    assert _step(build, "actions/checkout@")["with"]["ref"] == "${{ github.sha }}"  # both from one SHA
    assert _step(build, "docker/build-push-action@")["with"]["platforms"] == "${{ matrix.platform }}"
    assert "setup-qemu-action" not in WORKFLOW.read_text(encoding="utf-8")


def test_a_build_pushes_its_image_by_digest_only():
    push = _step(_jobs()["build"], "docker/build-push-action@")["with"]
    assert "tags" not in push and "push" not in push
    outputs = push["outputs"]
    assert "push-by-digest=true" in outputs and "push=true" in outputs
    assert "ghcr.io/kainpl/bamdude" in outputs and "docker.io/kainpl/bamdude" in outputs
    assert "STEP_PREVIEW_CANDIDATE" not in yaml.safe_dump(push)  # a release pin or no image


def test_each_image_is_checked_on_its_own_architecture_before_its_digest_is_kept():
    steps = _jobs()["build"]["steps"]
    names = [s.get("name", s.get("uses", "")) for s in steps]
    check = next(i for i, s in enumerate(steps) if "step_runtime verify" in s.get("run", ""))
    keep = next(i for i, s in enumerate(steps) if str(s.get("uses", "")).startswith("actions/upload-artifact@"))
    build = next(i for i, s in enumerate(steps) if str(s.get("uses", "")).startswith("docker/build-push-action@"))
    assert build < check < keep, names
    run = steps[check]["run"]
    assert "{{.Architecture}}" in run and '"$ARCH"' in run  # the pushed image is the arch it claims
    assert "python -m backend.app.step_render_probe" in run  # a real STEP rendered inside it
    assert "@$DIGEST" in run  # what was checked is the digest that is kept


def test_the_tags_come_from_the_checked_digests_after_both_builds_and_the_sources():
    publish = _jobs()["publish"]
    assert set(publish["needs"]) == {"build", "sources"}
    for word in ("always()", "failure()"):
        assert word not in str(publish.get("if", ""))
    assert not any(str(s.get("uses", "")).startswith("docker/build-push-action@") for s in publish["steps"])
    runs = _runs(publish)
    assert not re.search(r"docker (?:buildx )?build(?:\s|$)", runs) and "imagetools create" in runs
    assert "@$amd64" in runs and "@$arm64" in runs
    download = _step(publish, "actions/download-artifact@")["with"]
    assert download["pattern"] == "digest-*" and download["merge-multiple"] is True


def test_publish_runs_below_the_skipped_gate_of_a_manual_run_only_on_both_successes():
    """GitHub skips every job below a skipped one unless its `if:` carries a status function: the manual run's gate
    is skipped, and the first dispatch (run 39286953068) built and checked both arches but never ran publish. Past the
    skipped ancestor it may go only on the explicit success of both builds and the sources check."""
    condition = _jobs()["publish"]["if"]
    assert "!cancelled()" in condition
    assert "needs.build.result == 'success'" in condition and "needs.sources.result == 'success'" in condition


def test_the_ci_gate_still_holds_a_tag():
    jobs = _jobs()
    assert jobs["gate"]["if"] == "github.event_name == 'push'"
    condition = jobs["build"]["if"]
    assert "needs.gate.result == 'success'" in condition and "github.event_name == 'workflow_dispatch'" in condition


def test_a_manual_run_checks_the_path_and_tags_nothing():
    wf = _workflow()
    triggers = wf.get("on", wf.get(True))
    assert set(triggers) == {"push", "workflow_dispatch"} and triggers["push"]["tags"] == ["v*"]
    runs = _runs(_jobs()["publish"])
    assert "--dry-run" in runs and 'if [ "$EVENT" = push ]' in runs
    sources = _jobs()["sources"]
    collect = next(s for s in sources["steps"] if "step_preview_sources.py collect" in s.get("run", ""))
    assert collect["if"] == "github.event_name == 'workflow_dispatch'" and '--reuse-from "$REPO"' in collect["run"]
    verify = next(s for s in sources["steps"] if "verify-release" in s.get("run", ""))
    assert verify["if"] == "github.event_name == 'push'"
