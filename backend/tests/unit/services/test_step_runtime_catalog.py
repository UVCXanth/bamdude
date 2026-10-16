"""The STEP-preview CAD catalog, interpreter selection, install refusals and verify (spec §8, plan A1)."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from backend.app import step_runtime as sr

WIN312 = ["cp312-cp312-win_amd64", "cp312-abi3-win_amd64", "cp312-none-win_amd64", "py3-none-any"]
LINUX_ARM313 = ["cp313-cp313-manylinux_2_28_aarch64", "cp313-abi3-manylinux_2_28_aarch64", "py3-none-any"]


def catalog_copy(tmp_path: Path, mutate=None, closure_mutate=None) -> Path:
    """A writable copy of the committed catalog; the closure digest is re-signed after a closure mutation."""
    manifest = json.loads((sr.DATA / sr.MANIFEST_NAME).read_text(encoding="utf-8"))
    closure = json.loads((sr.DATA / sr.CLOSURE_NAME).read_text(encoding="utf-8"))
    if closure_mutate:
        closure_mutate(closure)
        manifest["closure_sha256"] = hashlib.sha256(sr.canonical(closure)).hexdigest()
    if mutate:
        mutate(manifest)
    tmp_path.mkdir(parents=True, exist_ok=True)
    (tmp_path / sr.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    (tmp_path / sr.CLOSURE_NAME).write_text(json.dumps(closure), encoding="utf-8")
    return tmp_path


# --- the committed catalog -------------------------------------------------------------------------------------


def test_committed_catalog_loads_and_covers_five_platforms_three_pythons():
    cat = sr.load_catalog()
    keys = {a["key"] for a in cat.manifest["artifacts"] if a["package"] == "cadquery-ocp-novtk"}
    assert keys == {
        f"{p}-{py}"
        for p in ("linux-x64", "linux-arm64", "win-x64", "darwin-x64", "darwin-arm64")
        for py in ("cp312", "cp313", "cp314")
    }
    proxies = [a for a in cat.manifest["artifacts"] if a["package"] == "cadquery-ocp-proxy"]
    assert len(proxies) == 1 and proxies[0]["tags"] == ["py3-none-any"]
    assert len(cat.digest) == 64


def test_every_artifact_carries_hash_size_time_and_a_closure():
    cat = sr.load_catalog()
    for a in cat.manifest["artifacts"]:
        assert len(a["sha256"]) == 64 and a["size"] > 0 and a["upload_time"].endswith("Z")
        libs = cat.closure["artifacts"][a["filename"]]
        assert len(libs) == a["native_count"]
        if a["package"] == "cadquery-ocp-novtk":
            assert a["native_count"] > 10  # OCCT itself + the bundled third-party libraries


@pytest.mark.parametrize(
    ("mutation", "reason"),
    [
        (lambda m: m.update(extra=1), "manifest_keys"),
        (lambda m: m["artifacts"].append({**m["artifacts"][0], "package": "vtk"}), "unknown_package"),
        (
            lambda m: m.__setitem__("artifacts", [a for a in m["artifacts"] if a["package"] != "cadquery-ocp-proxy"]),
            "proxy_missing",
        ),
        (lambda m: m["artifacts"][0].update(size="47747323"), "artifact_fields"),
        (lambda m: m["artifacts"][0].update(sha256="0" * 63), "artifact_fields"),
        (lambda m: m.update(closure_sha256="0" * 64), "closure_digest"),
        (lambda m: m["artifacts"][0].update(closure_sha256="0" * 64), "closure_digest"),
        (lambda m: m.update(status="released"), "status"),
    ],
)
def test_catalog_refuses_anything_outside_its_closed_shape(tmp_path, mutation, reason):
    with pytest.raises(sr.CatalogError) as err:
        sr.load_catalog(catalog_copy(tmp_path, mutation))
    assert err.value.reason == reason


def test_unknown_library_in_a_closure_is_refused(tmp_path):
    def add(closure):
        first = next(iter(closure["artifacts"]))
        closure["artifacts"][first].append({"path": "OCP/libmystery.so", "sha256": "1" * 64, "size": 1})

    # closure grew but the artifact still claims its old count/digest
    with pytest.raises(sr.CatalogError) as err:
        sr.load_catalog(catalog_copy(tmp_path, closure_mutate=add))
    assert err.value.reason == "closure_digest"


def test_a_release_pin_younger_than_fourteen_days_is_refused(tmp_path):
    def young(m):
        m["status"] = "release"
        m["pinned_at"] = "2026-10-16T00:00:00Z"  # wheels uploaded 2026-10-05: eleven days

    with pytest.raises(sr.CatalogError) as err:
        sr.load_catalog(catalog_copy(tmp_path, young))
    assert err.value.reason == "young_pin"


def test_a_release_pin_old_enough_loads(tmp_path):
    def old(m):
        m["status"] = "release"
        m["pinned_at"] = "2026-10-20T00:00:00Z"

    assert sr.load_catalog(catalog_copy(tmp_path, old)).manifest["status"] == "release"


# --- selection by the interpreter's tags (never uname) ---------------------------------------------------------


def test_selection_follows_the_interpreters_tags():
    cat = sr.load_catalog()
    sel = sr.select(cat, WIN312)
    assert sel.key == "win-x64-cp312"
    assert sel.wheel["filename"].endswith("cp312-cp312-win_amd64.whl")
    assert sel.proxy["filename"] == "cadquery_ocp_proxy-8.0.1.1.0-py3-none-any.whl"
    assert sr.select(cat, LINUX_ARM313).key == "linux-arm64-cp313"


def test_selection_ignores_uname(monkeypatch):
    import platform

    monkeypatch.setattr(platform, "machine", lambda: "aarch64")
    monkeypatch.setattr(platform, "system", lambda: "Linux")
    assert sr.select(sr.load_catalog(), WIN312).key == "win-x64-cp312"


@pytest.mark.parametrize(
    "tags",
    [
        ["cp315-cp315-win_amd64", "py3-none-any"],  # no build for a future Python
        ["cp312-cp312-musllinux_1_2_x86_64", "py3-none-any"],  # musl
        ["cp312-cp312-manylinux_2_28_armv7l", "cp312-cp312-linux_armv7l", "py3-none-any"],  # 32-bit ARM
        ["cp312-cp312-win32", "py3-none-any"],  # 32-bit Windows Python
        ["cp312-cp312-win_amd64"],  # proxy not installable
    ],
)
def test_unsupported_interpreters_are_refused(tags):
    with pytest.raises(sr.Unsupported):
        sr.select(sr.load_catalog(), tags)


def test_unsupported_install_exits_3_without_touching_pip_or_network(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(sr, "interpreter_tags", lambda: ["cp315-cp315-win_amd64", "py3-none-any"])
    rc = sr.main(["install", "--app-dir", str(tmp_path)], runner=lambda *a, **k: calls.append(a))
    assert rc == sr.EXIT_UNSUPPORTED and calls == []
    assert not (tmp_path / "runtime").exists()


def test_candidate_pin_is_not_installed_without_the_explicit_flag(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(sr, "interpreter_tags", lambda: WIN312)
    data = catalog_copy(tmp_path / "data", lambda m: m.update(status="candidate"))
    rc = sr.main(["install", "--app-dir", str(tmp_path / "app")], runner=lambda *a, **k: calls.append(a), data_dir=data)
    assert rc == sr.EXIT_FAILED and calls == []


def test_requirements_are_generated_from_the_catalog_only():
    cat = sr.load_catalog()
    sel = sr.select(cat, WIN312)
    lines = sr.requirements(sel).strip().splitlines()
    assert lines == [
        f"cadquery-ocp-novtk==8.0.1.1.0 --hash=sha256:{sel.wheel['sha256']}",
        f"cadquery-ocp-proxy==8.0.1.1.0 --hash=sha256:{sel.proxy['sha256']}",
    ]


def test_pip_command_is_isolated_hash_pinned_binary_only(tmp_path, monkeypatch):
    seen = {}

    def runner(cmd, **kwargs):
        seen["cmd"] = cmd
        raise sr.InstallError("stop_here")

    monkeypatch.setattr(sr, "interpreter_tags", lambda: WIN312)
    data = catalog_copy(tmp_path / "data")
    rc = sr.main(
        ["install", "--app-dir", str(tmp_path / "app"), "--allow-candidate", "--wheels", str(tmp_path / "w")],
        runner=runner,
        data_dir=data,
    )
    cmd = seen["cmd"]
    assert rc == sr.EXIT_FAILED
    for flag in ("--isolated", "--target", "--no-deps", "--only-binary=:all:", "--require-hashes", "--no-cache-dir"):
        assert flag in cmd
    assert "--no-index" in cmd and "--find-links" in cmd
    staging = tmp_path / "app" / "runtime" / "step-preview" / ".staging" / "win-x64-cp312"  # staging is per platform
    assert not staging.exists() or not any(staging.iterdir())  # a failed install leaves no staging of its own


# --- verify: RECORD, closure, receipt, one fingerprint ---------------------------------------------------------


def _record_hash(data: bytes) -> str:
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()


def fake_bundle(
    tmp_path: Path, *, native=b"\x7fELF lib", extra_native=None, drop_proxy=False, tamper=False, drop_native=False
):
    """A synthetic installed site dir + a matching synthetic catalog (two dists, one native library)."""
    site = tmp_path / "site"
    files = {
        "cadquery_ocp_novtk-8.0.1.1.0.dist-info/METADATA": b"Name: cadquery-ocp-novtk\nVersion: 8.0.1.1.0\n",
        "OCP/__init__.py": b"",
        "OCP/libTKernel.so": native,
    }
    if not drop_proxy:
        files["cadquery_ocp_proxy-8.0.1.1.0.dist-info/METADATA"] = b"Name: cadquery-ocp-proxy\nVersion: 8.0.1.1.0\n"
    for rel, data in files.items():
        (site / rel).parent.mkdir(parents=True, exist_ok=True)
        (site / rel).write_bytes(data)
    for dist in ("cadquery_ocp_novtk", "cadquery_ocp_proxy"):
        info = site / f"{dist}-8.0.1.1.0.dist-info"
        if not info.exists():
            continue
        rows = [
            f"{rel},{_record_hash(d)},{len(d)}"
            for rel, d in files.items()
            if rel.startswith(dist) or (dist == "cadquery_ocp_novtk" and rel.startswith("OCP/"))
        ]
        rows.append(f"{dist}-8.0.1.1.0.dist-info/RECORD,,")
        (info / "RECORD").write_text("\n".join(rows) + "\n", encoding="utf-8")
    if tamper:
        (site / "OCP" / "__init__.py").write_bytes(b"import os\n")
    if extra_native:
        (site / "OCP" / extra_native).write_bytes(b"unknown")
    if drop_native:
        (site / "OCP" / "libTKernel.so").unlink()  # a DLL gone after install
    closure = [{"path": "OCP/libTKernel.so", "sha256": hashlib.sha256(b"\x7fELF lib").hexdigest(), "size": 8}]
    return site, closure


def test_full_verify_accepts_a_consistent_tree(tmp_path):
    site, closure = fake_bundle(tmp_path)
    assert sr.verify_tree(site, closure) == []


@pytest.mark.parametrize(
    ("kwargs", "problem"),
    [
        ({"tamper": True}, "record_mismatch"),
        ({"extra_native": "libextra.so"}, "unknown_library"),
        ({"native": b"\x7fELF other"}, "closure_mismatch"),
        ({"drop_proxy": True}, "proxy_missing"),
        ({"drop_native": True}, "closure_missing"),
    ],
)
def test_full_verify_names_what_is_wrong(tmp_path, kwargs, problem):
    site, closure = fake_bundle(tmp_path, **kwargs)
    assert problem in {p.split(":")[0] for p in sr.verify_tree(site, closure)}


def test_locate_needs_a_receipt_matching_this_catalog_and_interpreter(tmp_path, monkeypatch):
    monkeypatch.setattr(sr, "interpreter_tags", lambda: WIN312)
    cat = sr.load_catalog()
    sel = sr.select(cat, WIN312)
    assert sr.locate(tmp_path, cat).reason == "not_installed"
    target = sr.bundle_dir(tmp_path, sel.key, cat.digest)
    (target / "site" / "OCP").mkdir(parents=True)
    receipt = sr.receipt_for(cat, sel)
    (target / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
    found = sr.locate(tmp_path, cat)
    assert found.ok and found.site == target / "site"
    bad = copy.deepcopy(receipt)
    bad["fingerprint"]["ext_suffix"] = ".cpython-312-no-such-platform.so"  # never this interpreter's
    (target / "receipt.json").write_text(json.dumps(bad), encoding="utf-8")
    assert sr.locate(tmp_path, cat).reason == "receipt_mismatch"


def test_install_and_verify_use_one_fingerprint_function(monkeypatch):
    """Two tag decoders must never give opposite answers: the receipt's fingerprint IS what verify recomputes."""
    cat = sr.load_catalog()
    sel = sr.select(cat, WIN312)
    assert sr.receipt_for(cat, sel)["fingerprint"] == sr.interpreter_fingerprint()
    import platform

    monkeypatch.setattr(platform, "machine", lambda: "riscv64")  # uname is not part of the fingerprint
    assert sr.receipt_for(cat, sel)["fingerprint"] == sr.interpreter_fingerprint()


def test_bundle_lives_under_app_dir_runtime_not_data_dir(tmp_path):
    cat = sr.load_catalog()
    path = sr.bundle_dir(tmp_path, "win-x64-cp312", cat.digest)
    assert path.relative_to(tmp_path).parts[:3] == ("runtime", "step-preview", "win-x64-cp312")


def test_pin_tool_check_matches_the_committed_catalog(tmp_path):
    """The committed files are exactly what the pin tool derives (no second hand-edited truth)."""
    import os
    import subprocess
    import sys

    wheels = Path(os.environ.get("BAMDUDE_STEP_WHEELS", "") or "/nonexistent")
    if not wheels.is_dir():
        pytest.skip("named skip: BAMDUDE_STEP_WHEELS does not name the pinned wheels (maintainer check)")
    root = Path(sr.__file__).resolve().parents[2]
    p = subprocess.run(
        [
            sys.executable,
            str(root / "scripts" / "pin_step_runtime.py"),
            "--wheels",
            str(wheels),
            "--index",
            str(wheels / "pypi-index.json"),
            "--check",
        ],
        capture_output=True,
        text=True,
    )
    assert p.returncode == 0, p.stderr


def test_utc_helpers_round_trip():
    now = datetime(2026, 10, 19, 16, 23, 45, tzinfo=UTC)
    assert sr.parse_time(sr.iso(now)) == now
    assert sr.parse_time("2026-10-05T16:23:45Z") + timedelta(days=14) == now


NO_PIP = "import sys\nsys.modules['pip'] = None  # the final Docker image removed pip\n"


def _without_pip(code: str, *args: str):
    import subprocess
    import sys

    root = Path(sr.__file__).resolve().parents[2]
    p = subprocess.run(
        [sys.executable, "-c", NO_PIP + code, *args], cwd=str(root), capture_output=True, text=True, timeout=120
    )
    return p.returncode, p.stdout.strip().splitlines()[-1] if p.stdout.strip() else p.stderr[-2000:]


def _installed_here(app: Path) -> sr.Selection:
    cat = sr.load_catalog()
    try:
        sel = sr.select(cat)
    except sr.Unsupported:
        pytest.skip("named skip: no pinned STEP-preview build for this interpreter")
    target = sr.bundle_dir(app, sel.key, cat.digest)
    (target / "site" / "OCP").mkdir(parents=True)
    (target / "receipt.json").write_text(json.dumps(sr.receipt_for(cat, sel)), encoding="utf-8")
    return sel


def test_the_runtime_finds_its_bundle_without_pip(tmp_path):
    sel = _installed_here(tmp_path)
    rc, line = _without_pip(
        "import json\nfrom pathlib import Path\nfrom backend.app import step_runtime as sr\n"
        "f = sr.locate(Path(sys.argv[1]))\nprint(json.dumps({'ok': f.ok, 'reason': f.reason, 'key': f.key}))\n",
        str(tmp_path),
    )
    assert rc == 0, line
    assert json.loads(line) == {"ok": True, "reason": None, "key": sel.key}


def test_the_read_only_verify_runs_without_pip(tmp_path):
    _installed_here(tmp_path)
    rc, line = _without_pip(
        "from backend.app import step_runtime as sr\nraise SystemExit(sr.main(['verify', '--quick', '--app-dir', sys.argv[1]]))\n",
        str(tmp_path),
    )
    assert (rc, json.loads(line)) == (0, {"ok": True, "reason": None})


def test_a_receipt_of_this_interpreter_under_two_keys_is_ambiguous(tmp_path):
    sel = _installed_here(tmp_path)
    cat = sr.load_catalog()
    other = next(a for a in cat.manifest["artifacts"] if a["key"] not in (None, sel.key))
    copied = sr.bundle_dir(tmp_path, other["key"], cat.digest)
    (copied / "site" / "OCP").mkdir(parents=True)
    receipt = sr.receipt_for(cat, sr.Selection(other["key"], other, sel.proxy))
    (copied / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
    assert sr.locate(tmp_path).reason == "receipt_mismatch"


def test_verify_on_an_interpreter_no_artifact_serves_exits_3(tmp_path, monkeypatch):
    monkeypatch.setattr(sr, "interpreter_tags", lambda: ["cp312-cp312-linux_armv7l", "py3-none-any"])
    assert sr.verify(tmp_path) == (sr.EXIT_UNSUPPORTED, ["unsupported"])
    assert sr.verify(tmp_path, full=False) == (sr.EXIT_UNSUPPORTED, ["unsupported"])


def test_verify_of_a_supported_interpreter_without_a_bundle_exits_1(tmp_path, monkeypatch):
    monkeypatch.setattr(sr, "interpreter_tags", lambda: WIN312)
    assert sr.verify(tmp_path) == (sr.EXIT_FAILED, ["not_installed"])


def test_both_doors_that_name_the_bundle_work_without_pip(tmp_path):
    """Main's descriptor and the service's own reconstruction — the two readers in a running Docker image."""
    sel = _installed_here(tmp_path / "app")
    digest = sr.load_catalog().digest
    rc, line = _without_pip(
        "import asyncio, json\nfrom pathlib import Path\n"
        "from backend.app.preview_service import Service\n"
        "from backend.app.services.preview_runtime import PreviewRuntime\n"
        "app = Path(sys.argv[1])\n"
        "cad = asyncio.run(PreviewRuntime(Path(sys.argv[2]), app_dir=app).cad_descriptor())\n"
        "site = Service({'app_dir': str(app)}).cad_site(cad or {})\n"
        "print(json.dumps({'cad': cad, 'site': site is not None and site.is_dir()}))\n",
        str(tmp_path / "app"),
        str(tmp_path / "preview"),
    )
    assert rc == 0, line
    assert json.loads(line) == {"cad": {"manifest_digest": digest, "bundle_key": sel.key}, "site": True}


@pytest.mark.parametrize(
    ("platform", "python", "expected"),
    [
        ("linux-armv7l", None, [3, ["unsupported"]]),  # a 32-bit Pi image: no pip, no CAD build
        ("win32", None, [3, ["unsupported"]]),
        ("linux-x86_64", "cp311", [3, ["unsupported"]]),  # below the catalog's ABIs
        ("linux-x86_64", None, [1, ["not_installed"]]),  # supported here: a missing bundle stays a failure
        ("macosx-11.0-universal2", None, [1, ["not_installed"]]),  # cannot tell without pip: never "unsupported"
    ],
)
def test_without_pip_only_a_platform_the_catalog_surely_lacks_is_unsupported(tmp_path, platform, python, expected):
    """The final Docker image has no pip: verify must still tell an armv7 image (exit 3) from a supported platform
    whose bundle is missing (exit 1) — or the image build fails on an architecture it is meant to skip."""
    code = (
        "import json, sysconfig\nfrom pathlib import Path\nfrom backend.app import step_runtime as sr\n"
        "sysconfig.get_platform = lambda: sys.argv[2]\n"
        "if sys.argv[3]:\n    sr._python_tag = lambda: sys.argv[3]\n"
        "print(json.dumps(list(sr.verify(Path(sys.argv[1])))))\n"
    )
    rc, line = _without_pip(code, str(tmp_path), platform, python or "")
    assert rc == 0, line
    assert json.loads(line) == expected
