"""The corresponding source of the STEP component's copyleft parts, delivered by BamDude itself (release gate of the
STEP thumbnails): OCCT, LibRaw, FreeImage and — on Linux — libgomp are what the Docker image and the Windows
installer carry under a licence that asks for their source. Complete source is the upstream code AND what controlled
its build (Codex SRC-R1): a vendor's source RPM carries both; a conda-forge build adds its exact package's recipe —
meta.yaml, build scripts, patches — taken from that very package by its pinned SHA-256; OCCT adds the tree of the
build system that patched and compiled it, at its pinned commit. Every release that carries the component gets one
asset with all of it, and the notices that ship say where it is. Nothing here touches the network."""

from __future__ import annotations

import hashlib
import io
import json
import tarfile
import zipfile
from pathlib import Path

import pytest
import yaml

from backend.app import step_runtime as sr
from scripts import step_preview_sources as sources

ROOT = Path(__file__).resolve().parents[3]
DATA = Path(sr.__file__).resolve().parent / "data"
NOTICES = json.loads((DATA / "step_runtime_notices.json").read_text(encoding="utf-8"))
WORKFLOW = ROOT / ".github" / "workflows" / "step-preview-sources.yml"
BUILD_SYSTEM = ("https://github.com/bernhard-42/ocp-build-system", "eace4e42cfa2c162ac39bc36864534fe5f5787a6")


def _copyleft():
    for family, body in NOTICES["families"].items():
        for c in body["components"]:
            if sources.is_copyleft(c):
                yield family, c


def test_the_copyleft_parts_are_exactly_these():
    """The rule, not a list, decides; this pins what it decides today. A repin that brings a new copyleft
    library changes this set, and with it the bundle."""
    found = {}
    for family, c in _copyleft():
        found.setdefault(family, []).append(c["id"])
    assert {f: sorted(ids) for f, ids in found.items()} == {
        "linux": ["freeimage", "libgomp", "libraw", "occt"],
        "windows": ["freeimage", "libraw", "occt"],
        "macos": ["freeimage", "libraw", "occt"],
    }


def test_a_term_chosen_among_alternatives_decides():
    assert not sources.is_copyleft({"licence": "(FTL or GPLv2+) and BSD", "terms": "FTL"})
    assert sources.is_copyleft({"licence": "GPLv2 or GPLv3 or MPLv1.0", "terms": "FreeImage"})
    assert not sources.is_copyleft({"licence": "BSD-3-Clause"})


def test_every_copyleft_part_has_its_upstream_and_what_built_it():
    plan = sources.plan(NOTICES)
    served = {}
    for entry in plan:
        for who in entry["serves"]:
            served.setdefault(who.split("@")[0], set()).add(entry["role"])
    for family, c in _copyleft():
        roles = served[f"{family}:{c['id']}"]
        assert "upstream" in roles, (family, c["id"])
        assert "build" in roles or c["source"]["kind"] == "srpm", (family, c["id"])  # an SRPM is source + spec


def test_a_conda_build_brings_the_recipe_of_its_exact_package():
    recipes = [e for e in sources.plan(NOTICES) if e["kind"] == "conda-recipe"]
    pins = {
        (f"{family}:{c['id']}@{platform}"): p
        for family, c in _copyleft()
        for platform, p in (c.get("packages") or {}).items()
    }
    assert len(recipes) == len(pins) == 6
    for entry in recipes:
        (who,) = entry["serves"]
        assert entry["package"] == pins[who]["file"] and entry["package_sha256"] == pins[who]["sha256"]
        assert entry["url"] == f"https://conda.anaconda.org/conda-forge/{pins[who]['file']}"


def test_occt_brings_the_build_system_that_patched_and_compiled_it():
    (build,) = [e for e in sources.plan(NOTICES) if e["role"] == "build" and e["kind"] == "git"]
    assert (build["url"], build["commit"]) == BUILD_SYSTEM
    assert sorted(build["serves"]) == ["linux:occt", "macos:occt", "windows:occt"]


@pytest.mark.parametrize(
    ("family", "cid", "drop"),
    [
        ("linux", "libraw", ("source", "sha256")),
        ("windows", "freeimage", ("packages",)),
        ("macos", "occt", ("built_by",)),
    ],
)
def test_a_copyleft_part_without_a_verifiable_source_or_build_is_refused(family, cid, drop):
    broken = json.loads(json.dumps(NOTICES))
    component = next(c for c in broken["families"][family]["components"] if c["id"] == cid)
    holder = component
    for key in drop[:-1]:
        holder = holder[key]
    del holder[drop[-1]]
    with pytest.raises(sources.SourceError, match=f"{family}:{cid}"):
        sources.plan(broken)


RECIPE = {
    "info/recipe/meta.yaml": b"source:\n  patches:\n    - fix_one.patch\n",
    "info/recipe/bld.bat": b"patch -p1 -i %RECIPE_DIR%\\patches\\two.patch\n",
    "info/recipe/fix_one.patch": b"--- a\n+++ b\n",
    "info/recipe/patches/two.patch": b"--- c\n+++ d\n",
    "info/licenses/license-fi.txt": b"FreeImage Public License\n",
    "info/index.json": b'{"name": "x"}\n',
}


def _bytes_for(entry: dict) -> bytes:
    return f"bytes of {entry.get('url', entry['file'])}".encode()


@pytest.fixture
def pinned():
    """The notices with every archive, source RPM and conda package pinned to bytes the fake fetcher serves."""
    notices = json.loads(json.dumps(NOTICES))
    for body in notices["families"].values():
        for c in body["components"]:
            if not sources.is_copyleft(c):
                continue
            s = c["source"]
            if s["kind"] in ("srpm", "archive"):
                s["sha256"] = hashlib.sha256(f"bytes of {s['url']}".encode()).hexdigest()
            for p in (c.get("packages") or {}).values():
                url = f"https://conda.anaconda.org/conda-forge/{p['file']}"
                p["sha256"] = hashlib.sha256(f"bytes of {url}".encode()).hexdigest()
    return notices


def _fakes(*, wrong: str | None = None, recipe: dict | None = None):
    def fetch(url: str, dest: Path) -> None:
        data = f"bytes of {url}".encode()
        dest.write_bytes(b"tampered" if wrong and wrong in url else data)

    def archive_git(url: str, commit: str, prefix: str, dest: Path) -> None:
        dest.write_bytes(f"tree of {url} at {commit}".encode())

    def read_recipe(path: Path) -> dict[str, bytes]:
        return dict(RECIPE if recipe is None else recipe)

    return {"fetch": fetch, "archive_git": archive_git, "read_recipe": read_recipe}


def test_the_bundle_carries_every_source_with_its_identity(tmp_path, pinned):
    bundle = sources.collect(pinned, tmp_path / "out", **_fakes())
    assert bundle.name == sources.bundle_name(pinned)
    digest = (bundle.parent / f"{bundle.name}.sha256").read_text(encoding="ascii").split()[0]
    assert digest == hashlib.sha256(bundle.read_bytes()).hexdigest()
    with tarfile.open(bundle) as tar:
        manifest = json.load(tar.extractfile("SOURCES.json"))
        assert "README.txt" in tar.getnames()
        for entry in manifest["sources"]:
            data = tar.extractfile(f"sources/{entry['file']}").read()
            assert hashlib.sha256(data).hexdigest() == entry["sha256"] and entry["serves"]
        assert all(m.mtime == 0 and m.uid == 0 and m.gid == 0 for m in tar.getmembers())
        recipe = next(e for e in manifest["sources"] if e["kind"] == "conda-recipe")
        with tarfile.open(fileobj=tar.extractfile(f"sources/{recipe['file']}")) as inner:
            assert sorted(inner.getnames()) == sorted(RECIPE)
            for member in recipe["members"]:
                assert hashlib.sha256(inner.extractfile(member["name"]).read()).hexdigest() == member["sha256"]
    assert manifest["closure_sha256"] == pinned["closure_sha256"]
    assert {e["kind"] for e in manifest["sources"]} == {"git", "srpm", "archive", "conda-recipe"}


def test_the_bundle_is_the_same_bytes_every_time(tmp_path, pinned):
    one = sources.collect(pinned, tmp_path / "a", **_fakes()).read_bytes()
    two = sources.collect(pinned, tmp_path / "b", **_fakes()).read_bytes()
    assert one == two


@pytest.mark.parametrize(
    ("fakes", "match"),
    [
        ({"wrong": "LibRaw-0.19.5"}, "LibRaw-0.19.5"),  # an SRPM that is not the pinned bytes
        ({"wrong": "freeimage-3.18.0-h81f0cfa_25.conda"}, "h81f0cfa_25"),  # a conda package that is not the pin
        ({"recipe": {k: v for k, v in RECIPE.items() if k != "info/recipe/meta.yaml"}}, "meta.yaml"),
        ({"recipe": {k: v for k, v in RECIPE.items() if k != "info/recipe/patches/two.patch"}}, "two.patch"),
        ({"recipe": {k: v for k, v in RECIPE.items() if k != "info/recipe/fix_one.patch"}}, "fix_one.patch"),
    ],
)
def test_a_source_that_does_not_hold_leaves_no_bundle(tmp_path, pinned, fakes, match):
    with pytest.raises(sources.SourceError, match=match):
        sources.collect(pinned, tmp_path / "out", **_fakes(**fakes))
    assert not (tmp_path / "out").exists() or list((tmp_path / "out").iterdir()) == []


def test_a_real_conda_package_gives_up_its_recipe_and_licences_only(tmp_path):
    zstd = pytest.importorskip("compression.zstd", reason="named skip: stdlib zstd needs Python 3.14")
    info = io.BytesIO()
    with tarfile.open(fileobj=info, mode="w") as tar:
        for name, data in {**RECIPE, "info/files": b"Library/bin/FreeImage.dll\n", "info/../evil": b"x"}.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            tar.addfile(member, io.BytesIO(data))
    package = tmp_path / "freeimage-3.18.0-h81f0cfa_25.conda"
    with zipfile.ZipFile(package, "w") as z:
        z.writestr("metadata.json", "{}")
        z.writestr("pkg-freeimage-3.18.0-h81f0cfa_25.tar.zst", zstd.compress(b"binaries"))
        z.writestr("info-freeimage-3.18.0-h81f0cfa_25.tar.zst", zstd.compress(info.getvalue()))
    assert sources._conda_recipe(package) == RECIPE


def test_the_shipped_notices_name_the_bundle_and_offer_the_source():
    readme = (DATA / "step_runtime_notices" / "README.txt").read_text(encoding="utf-8")
    assert sources.bundle_name(NOTICES) in readme
    assert "https://github.com/kainpl/bamdude/releases" in readme
    assert "three years" in readme and "https://github.com/kainpl/bamdude/issues" in readme
    section = readme.split("Corresponding source", 1)[1]
    for name in ("Open CASCADE Technology", "LibRaw", "FreeImage", "libgomp", "recipe", "patches", "build system"):
        assert name in section, name


def test_the_workflow_attaches_the_bundle_to_a_tag_release_only():
    wf = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    triggers = wf.get("on", wf.get(True))
    assert set(triggers) == {"push", "workflow_dispatch"} and triggers["push"]["tags"] == ["v*"]
    assert wf["permissions"] == {"contents": "read"}
    jobs = wf["jobs"]
    collect = jobs["collect"]
    assert any("step_preview_sources.py collect" in s.get("run", "") for s in collect["steps"])
    python = next(s for s in collect["steps"] if str(s.get("uses", "")).startswith("actions/setup-python@"))
    assert python["with"]["python-version"] == "3.14"  # stdlib zstd for the conda recipes
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
    assert printed["bundle"] == sources.bundle_name(NOTICES)
    assert printed["sources"] == json.loads(json.dumps(sources.plan(NOTICES)))


# --- what the publishers of the image and the installer wait for (Codex SRC-R2) ---------------------------------

DOCKER = ROOT / ".github" / "workflows" / "docker-publish-tag.yml"
INSTALLER = ROOT / ".github" / "workflows" / "windows-installer.yml"


@pytest.fixture
def published(tmp_path, pinned):
    """A correct bundle of the pinned notices, as a release would carry it."""
    bundle = sources.collect(pinned, tmp_path / "made", **_fakes())
    digest = bundle.parent / f"{bundle.name}.sha256"
    return pinned, bundle, digest


def _release(bundle: Path, digest: Path, *, draft=False, state="uploaded", asset_digest=None):
    sha = hashlib.sha256(bundle.read_bytes()).hexdigest()
    return {
        "draft": draft,
        "assets": [
            {
                "name": bundle.name,
                "state": state,
                "digest": asset_digest or f"sha256:{sha}",
                "browser_download_url": f"https://example.invalid/{bundle.name}",
            },
            {
                "name": digest.name,
                "state": "uploaded",
                "browser_download_url": f"https://example.invalid/{digest.name}",
            },
        ],
    }


def _verify(notices, release_after, bundle, digest, *, polls=None, wait=60.0):
    now = [0.0]
    answers = list(release_after)

    def get_release(repo, tag, token):
        return answers.pop(0) if len(answers) > 1 else answers[0]

    def download(url, dest):
        src = bundle if url.endswith(".tar") else digest
        dest.write_bytes(src.read_bytes())

    def sleep(seconds):
        now[0] += seconds

    return sources.verify_release(
        notices,
        "kainpl/bamdude",
        "v0.8.0",
        wait=wait,
        poll=20,
        get_release=get_release,
        download=download,
        clock=lambda: now[0],
        sleep=sleep,
    )


def test_the_publishers_go_on_once_this_closures_bundle_is_published(published):
    notices, bundle, digest = published
    got = _verify(notices, [None, {"draft": False, "assets": []}, _release(bundle, digest)], bundle, digest)
    assert got == hashlib.sha256(bundle.read_bytes()).hexdigest()


@pytest.mark.parametrize(
    "release",
    [
        lambda b, d: None,  # the sources workflow failed: never created
        lambda b, d: _release(b, d, draft=True),  # a draft is no public copy
        lambda b, d: _release(b, d, state="starter"),  # an upload that did not finish
    ],
)
def test_no_published_bundle_holds_the_publishers(published, release):
    notices, bundle, digest = published
    with pytest.raises(sources.SourceError, match="after 60 s"):
        _verify(notices, [release(bundle, digest)], bundle, digest)


def test_a_bundle_of_another_closure_holds_the_publishers(published):
    notices, bundle, digest = published
    other = json.loads(json.dumps(notices))
    other["closure_sha256"] = notices["closure_sha256"][:12] + "0" * 52  # the same name, another closure
    with pytest.raises(sources.SourceError, match="another closure"):
        _verify(other, [_release(bundle, digest)], bundle, digest)


def test_bytes_other_than_the_published_digest_hold_the_publishers(published, tmp_path):
    notices, bundle, digest = published
    wrong = tmp_path / digest.name
    wrong.write_text("0" * 64 + f"  {bundle.name}\n", encoding="ascii")
    with pytest.raises(sources.SourceError, match="its .sha256 says"):
        _verify(notices, [_release(bundle, wrong)], bundle, wrong)
    with pytest.raises(sources.SourceError, match="digest"):
        _verify(notices, [_release(bundle, digest, asset_digest="sha256:" + "1" * 64)], bundle, digest)


def test_a_bundle_missing_a_source_holds_the_publishers(published, tmp_path):
    notices, bundle, _ = published
    cut = tmp_path / "cut" / bundle.name
    cut.parent.mkdir()
    with tarfile.open(bundle) as src, tarfile.open(cut, "w", format=tarfile.USTAR_FORMAT) as dst:
        for member in src.getmembers():
            if "-recipe.tar" not in member.name:  # every conda recipe gone, SOURCES.json kept
                dst.addfile(member, src.extractfile(member))
    digest = cut.parent / f"{cut.name}.sha256"
    digest.write_text(f"{hashlib.sha256(cut.read_bytes()).hexdigest()}  {cut.name}\n", encoding="ascii")
    with pytest.raises(sources.SourceError, match="lacks the bytes"):
        _verify(notices, [_release(cut, digest)], cut, digest)


def _waits_for_sources(workflow: Path, publisher: str) -> dict:
    jobs = yaml.safe_load(workflow.read_text(encoding="utf-8"))["jobs"]
    needs = jobs[publisher]["needs"]
    needs = needs if isinstance(needs, list) else [needs]
    (check,) = [n for n in needs if any("verify-release" in s.get("run", "") for s in jobs[n].get("steps", []))]
    return jobs[check]


@pytest.mark.parametrize(("workflow", "publisher"), [(DOCKER, "publish"), (INSTALLER, "release")])
def test_the_image_and_the_installer_publish_only_after_the_sources_of_their_tag(workflow, publisher):
    check = _waits_for_sources(workflow, publisher)
    step = next(s for s in check["steps"] if "verify-release" in s.get("run", ""))
    assert '--tag "$TAG"' in step["run"] and "--wait" in step["run"]
    assert step["env"]["TAG"] == "${{ github.ref_name }}"  # this tag's release, through env: no shell injection
    assert check.get("permissions") == {"contents": "read"}
    checkout = next(s for s in check["steps"] if str(s.get("uses", "")).startswith("actions/checkout@"))
    assert checkout["with"]["persist-credentials"] is False
