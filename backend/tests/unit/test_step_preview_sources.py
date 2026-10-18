"""The corresponding source of the STEP component's copyleft parts, delivered by BamDude itself (release gate of the
STEP thumbnails): OCCT, LibRaw, FreeImage and — on Linux — libgomp are what the Docker image and the Windows
installer carry under a licence that asks for their source. Every release that carries them gets one asset with
exactly that source, each file verified against an identity pinned in the notices (a vendor-signed source RPM's
SHA-256, a source archive's SHA-256, a git commit), and the notices that ship say where it is and offer it on
request for three years. Nothing here touches the network: the fetchers are replaced."""

from __future__ import annotations

import hashlib
import json
import tarfile
from pathlib import Path

import pytest
import yaml

from backend.app import step_runtime as sr
from scripts import step_preview_sources as sources

ROOT = Path(__file__).resolve().parents[3]
DATA = Path(sr.__file__).resolve().parent / "data"
NOTICES = json.loads((DATA / "step_runtime_notices.json").read_text(encoding="utf-8"))
WORKFLOW = ROOT / ".github" / "workflows" / "step-preview-sources.yml"


def test_the_copyleft_parts_are_exactly_these():
    """The rule, not a list, decides; this pins what it decides today. A repin that brings a new copyleft
    library changes this set, and with it the bundle."""
    found = {
        family: sorted(c["id"] for c in body["components"] if sources.is_copyleft(c))
        for family, body in NOTICES["families"].items()
    }
    assert found == {
        "linux": ["freeimage", "libgomp", "libraw", "occt"],
        "windows": ["freeimage", "libraw", "occt"],
        "macos": ["freeimage", "libraw", "occt"],
    }


def test_a_term_chosen_among_alternatives_decides():
    assert not sources.is_copyleft({"licence": "(FTL or GPLv2+) and BSD", "terms": "FTL"})
    assert sources.is_copyleft({"licence": "GPLv2 or GPLv3 or MPLv1.0", "terms": "FreeImage"})
    assert not sources.is_copyleft({"licence": "BSD-3-Clause"})


def test_every_copyleft_part_has_one_verifiable_source_and_the_same_source_is_delivered_once():
    plan = sources.plan(NOTICES)
    by_file = {s["file"]: s for s in plan}
    assert len(by_file) == len(plan) == 6
    occt = [s for s in plan if s["kind"] == "git"]
    assert len(occt) == 1 and occt[0]["commit"] == "b8f597c677811d1f9f4d8a97f5ae2825c0353a42"
    assert sorted(occt[0]["serves"]) == ["linux:occt", "macos:occt", "windows:occt"]
    for s in plan:
        if s["kind"] in ("srpm", "archive"):
            assert s["url"].startswith(("https://", "http://")) and len(s["sha256"]) == 64, s
    gcc = next(s for s in plan if s["serves"] == ["linux:libgomp"])
    assert gcc["file"] == "gcc-8.5.0-29.el8_10.alma.1.src.rpm" and "signed_by" in gcc


def test_a_copyleft_part_without_an_identity_is_refused():
    broken = json.loads(json.dumps(NOTICES))
    libraw = next(c for c in broken["families"]["linux"]["components"] if c["id"] == "libraw")
    del libraw["source"]["sha256"]
    with pytest.raises(sources.SourceError, match="linux:libraw"):
        sources.plan(broken)


def _fake_fetchers(tmp_path: Path, *, wrong: str | None = None):
    def fetch(url: str, dest: Path) -> None:
        source = next(s for s in sources.plan(NOTICES) if s.get("url") == url)
        data = sources_bytes.get(source["file"], b"other bytes")
        dest.write_bytes(b"tampered" if source["file"] == wrong else data)

    def archive_git(url: str, commit: str, prefix: str, dest: Path) -> None:
        dest.write_bytes(b"occt tree of " + commit.encode())

    return fetch, archive_git


sources_bytes: dict[str, bytes] = {}


@pytest.fixture
def pinned():
    """The notices with each archive/srpm pinned to bytes the fake fetcher serves."""
    notices = json.loads(json.dumps(NOTICES))
    sources_bytes.clear()
    for body in notices["families"].values():
        for c in body["components"]:
            s = c["source"]
            if sources.is_copyleft(c) and s["kind"] in ("srpm", "archive"):
                data = f"bytes of {s['url']}".encode()
                s["sha256"] = hashlib.sha256(data).hexdigest()
    for s in sources.plan(notices):
        if s["kind"] != "git":
            sources_bytes[s["file"]] = f"bytes of {s['url']}".encode()
    return notices


def test_the_bundle_carries_every_source_with_its_identity(tmp_path, pinned):
    fetch, archive_git = _fake_fetchers(tmp_path)
    bundle = sources.collect(pinned, tmp_path / "out", fetch=fetch, archive_git=archive_git)
    assert bundle.name == sources.bundle_name(pinned)
    assert (bundle.parent / f"{bundle.name}.sha256").read_text(encoding="ascii").split()[0] == hashlib.sha256(
        bundle.read_bytes()
    ).hexdigest()
    with tarfile.open(bundle) as tar:
        names = tar.getnames()
        manifest = json.load(tar.extractfile("SOURCES.json"))
        assert "README.txt" in names
        for entry in manifest["sources"]:
            data = tar.extractfile(f"sources/{entry['file']}").read()
            assert hashlib.sha256(data).hexdigest() == entry["sha256"]
            assert entry["serves"]
        assert all(m.mtime == 0 and m.uid == 0 and m.gid == 0 for m in tar.getmembers())
    assert manifest["closure_sha256"] == pinned["closure_sha256"]
    assert {e["kind"] for e in manifest["sources"]} == {"git", "srpm", "archive"}


def test_the_bundle_is_the_same_bytes_every_time(tmp_path, pinned):
    fetch, archive_git = _fake_fetchers(tmp_path)
    one = sources.collect(pinned, tmp_path / "a", fetch=fetch, archive_git=archive_git).read_bytes()
    two = sources.collect(pinned, tmp_path / "b", fetch=fetch, archive_git=archive_git).read_bytes()
    assert one == two


def test_a_source_that_is_not_the_pinned_bytes_leaves_no_bundle(tmp_path, pinned):
    victim = next(s["file"] for s in sources.plan(pinned) if s["kind"] == "srpm")
    fetch, archive_git = _fake_fetchers(tmp_path, wrong=victim)
    with pytest.raises(sources.SourceError, match=victim):
        sources.collect(pinned, tmp_path / "out", fetch=fetch, archive_git=archive_git)
    assert not (tmp_path / "out").exists() or list((tmp_path / "out").iterdir()) == []


def test_the_shipped_notices_name_the_bundle_and_offer_the_source():
    readme = (DATA / "step_runtime_notices" / "README.txt").read_text(encoding="utf-8")
    assert sources.bundle_name(NOTICES) in readme
    assert "https://github.com/kainpl/bamdude/releases" in readme
    assert "three years" in readme and "https://github.com/kainpl/bamdude/issues" in readme
    for name in ("Open CASCADE Technology", "LibRaw", "FreeImage", "libgomp"):
        assert name in readme.split("Corresponding source", 1)[1], name


def test_the_workflow_attaches_the_bundle_to_a_tag_release_only():
    wf = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    triggers = wf.get("on", wf.get(True))
    assert set(triggers) == {"push", "workflow_dispatch"} and triggers["push"]["tags"] == ["v*"]
    assert wf["permissions"] == {"contents": "read"}
    jobs = wf["jobs"]
    collect = jobs["collect"]
    assert any("step_preview_sources.py collect" in s.get("run", "") for s in collect["steps"])
    release = jobs["release"]
    assert "refs/tags/v" in release["if"] and release["permissions"] == {"contents": "write"}
    attach = next(s for s in release["steps"] if str(s.get("uses", "")).startswith("softprops/action-gh-release@"))
    assert "step-preview-sources" in attach["with"]["files"] and attach["with"]["fail_on_unmatched_files"] is True
    for name, job in jobs.items():
        if name != "release":
            assert job.get("permissions", {"contents": "read"}) == {"contents": "read"}


def test_a_dry_plan_needs_no_network(capsys):
    assert sources.main(["plan"]) == 0
    printed = json.loads(capsys.readouterr().out)
    assert printed["bundle"] == sources.bundle_name(NOTICES) and len(printed["sources"]) == 6
