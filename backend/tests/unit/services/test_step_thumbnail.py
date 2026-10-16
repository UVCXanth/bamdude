"""The STEP conversion child against the independent fixture oracle (spec §7, plan A2).

Every run is a real child process (``python -m backend.app.services.step_thumbnail``) under the worker
environment whitelist, in a private attempt directory under a Unicode parent, with the installed bundle. The
oracle is the fixture generator's expected.json (construction parameters, never an OCCT read), and the geometry is
measured from the STL file the child wrote — not from the child's own report.
"""

from __future__ import annotations

import json
import math
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

import pytest

from backend.app.services.preview_protocol import CAD_TRIANGLES
from backend.app.services.worker_env import worker_environment

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = ROOT / "backend" / "tests" / "fixtures" / "step"
CHILD = ROOT / "backend" / "app" / "services" / "step_thumbnail.py"
TOL = 1e-3


def _fixtures(kind: str):
    out = []
    for d in ("authored", "occt"):
        expected = json.loads((FIXTURES / d / "expected.json").read_text(encoding="utf-8"))
        for name, exp in expected.items():
            if exp["kind"] == kind:
                out.append(pytest.param(FIXTURES / d / name, exp, id=f"{d}/{name}"))
    return out


def run_converter(tmp_path: Path, source: Path | None, site: Path, **cfg) -> tuple[int, dict | None, Path]:
    root = tmp_path / "спроба Україна" / "attempt"
    root.mkdir(parents=True)
    if source is not None:
        shutil.copyfile(source, root / "input.step")
    (root / "keep.txt").write_text("not the child's", encoding="utf-8")
    request = {"root": str(root), "deadline": time.monotonic_ns() + int(120e9), "site": str(site), **cfg}
    p = subprocess.run(
        [sys.executable, "-m", "backend.app.services.step_thumbnail"],
        cwd=ROOT,
        input=(json.dumps(request) + "\n").encode(),
        capture_output=True,
        env=worker_environment(tmp_path / "cache"),
        timeout=180,
    )
    assert (root / "keep.txt").read_text(encoding="utf-8") == "not the child's"  # cleanup only of its own files
    assert (root / "input.step").exists() == (source is not None)
    result = json.loads((root / "result.json").read_text(encoding="utf-8")) if (root / "result.json").exists() else None
    return p.returncode, result, root


def read_stl(path: Path):
    data = path.read_bytes()
    (n,) = struct.unpack_from("<I", data, 80)
    assert len(data) == 84 + 50 * n
    tris = []
    for i in range(n):
        values = struct.unpack_from("<12f", data, 84 + 50 * i)
        tris.append((values[3:6], values[6:9], values[9:12]))
    return n, tris


def stl_geometry(tris):
    lo = [min(p[k] for t in tris for p in t) for k in range(3)]
    hi = [max(p[k] for t in tris for p in t) for k in range(3)]
    volume = 0.0
    for a, b, c in tris:
        volume += (
            a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
        ) / 6.0
    return [lo, hi], volume


# The closed reason each negative fixture must be refused for, from what its generator built (expected.json "why").
EXPECTED_WHY = {
    "asm_mirror_axes.step": "unsupported_mirror_axes",  # left-handed CTO axes in an assembly
    "mirror_x_axis1.step": "unsupported_mirror_axes",  # OCCT would apply a rotation instead of the mirror
    "mirror_z_axis3.step": "unsupported_mirror_axes",
    "box_float32_overflow.step": "implausible_bounds",  # x extent 5.08e38 mm
    "empty_0bytes.step": "read_status",
    "empty_data.step": "no_roots",  # header + empty DATA, no product
    "external_only.step": "external_reference",
    "mixed_embedded_external.step": "external_reference",  # one component lives in external-part.stp
    "face_bspline_bad.step": "transfer_fail",  # OCCT drops the face; only the transfer check list shows it
    "face_edge_zero_dir.step": "transfer_fail",
    "face_dangling_bound.step": "load_fail",  # a bound naming a missing entity: refused at load
    "face_zero_normal.step": "mesh_flags",  # the mesher fails on the face
    "nongeometric.step": "root_not_transferred",  # product without any shape representation
    "null_root_dangling.step": "root_not_transferred",
    "null_root_wrong_type.step": "root_not_transferred",
    "trunc_25.step": "read_status",
    "trunc_50.step": "read_status",
    "trunc_90.step": "read_status",
    "trunc_after_root1.step": "read_status",
    "trunc_no_end_marker.step": "read_status",
}


@pytest.fixture
def site():
    from backend.tests.cad_lane import located

    return located().site


@pytest.mark.requires_cad
@pytest.mark.parametrize(("fixture", "exp"), _fixtures("ok"))
def test_positive_fixtures_match_the_oracle(tmp_path, site, fixture, exp):
    rc, result, root = run_converter(tmp_path, fixture, site)
    assert rc == 0 and result["outcome"] == "ok", result
    n, tris = read_stl(root / "mesh.stl")
    assert n == result["triangles"] <= CAD_TRIANGLES
    bounds, volume = stl_geometry(tris)
    deflection = result["deflection_mm"]
    for i in range(2):
        for k in range(3):
            # float32 STL vertices: relative error ~1e-7 of the coordinate, plus the chord deflection
            tol = max(TOL, deflection, abs(exp["bounds_mm"][i][k]) * 2e-7)
            assert abs(bounds[i][k] - exp["bounds_mm"][i][k]) <= tol, (i, k, bounds, exp["bounds_mm"])
    vol_tol = max(exp["abs_volume_mm3"] * 1e-5, exp.get("area_mm2", 0.0) * deflection)
    # the STL's own signed volume: a mirrored instance with the wrong winding would subtract, not add
    assert abs(volume - exp["abs_volume_mm3"]) <= vol_tol, (volume, exp["abs_volume_mm3"])
    assert result["negative_volume_solids"] == 0
    assert result["face_occurrences"] == exp["face_occurrences"]
    assert result["solids"] == exp["solids"]


@pytest.mark.requires_cad
@pytest.mark.parametrize(("fixture", "exp"), _fixtures("reject"))
def test_negative_fixtures_are_refused_without_an_stl(tmp_path, site, fixture, exp):
    rc, result, root = run_converter(tmp_path, fixture, site)
    assert rc == 1 and result["outcome"] == "render_failed", result
    assert result["why"] == EXPECTED_WHY[fixture.name], result
    assert not (root / "mesh.stl").exists() and not (root / "mesh.stl.part").exists()


@pytest.mark.requires_cad
@pytest.mark.parametrize("order", [("box_mm.step", "box_inch.step"), ("box_inch.step", "box_mm.step")])
def test_units_are_millimetres_even_when_the_static_unit_says_metres(tmp_path, site, order):
    """The static unit is forced to M (seam); only SetSystemLengthUnit after ReadFile keeps millimetres. Both
    twins, both orders, each in its own process."""
    expected = json.loads((FIXTURES / "authored" / "expected.json").read_text(encoding="utf-8"))
    for i, name in enumerate(order):
        rc, result, root = run_converter(
            tmp_path / str(i), FIXTURES / "authored" / name, site, faults=["static_unit_m"]
        )
        assert rc == 0, result
        bounds, _ = stl_geometry(read_stl(root / "mesh.stl")[1])
        for k in range(3):
            assert abs(bounds[1][k] - expected[name]["bounds_mm"][1][k]) <= 1e-3, (name, bounds)


@pytest.mark.requires_cad
def test_a_face_without_triangulation_refuses_the_whole_model(tmp_path, site):
    rc, result, root = run_converter(
        tmp_path, FIXTURES / "authored" / "l_prism.step", site, faults=["drop_triangulation"]
    )
    assert (rc, result["outcome"], result["why"]) == (1, "render_failed", "missing_triangulation")
    assert not (root / "mesh.stl").exists()


@pytest.mark.requires_cad
@pytest.mark.parametrize(
    ("cap", "value", "why", "stage"),
    [
        ("byte_cap", 100, "byte_cap", "snapshot"),
        ("face_cap", 3, "face_cap", "transfer"),
        ("triangle_cap", 4, "triangle_cap", "mesh"),
    ],
)
def test_caps_refuse_before_anything_is_written(tmp_path, site, cap, value, why, stage):
    rc, result, root = run_converter(tmp_path, FIXTURES / "authored" / "l_prism.step", site, **{cap: value})
    assert (result["outcome"], result["why"], result["stage"]) == ("resource_limit", why, stage)
    assert not (root / "mesh.stl").exists() and not (root / "mesh.stl.part").exists()


@pytest.mark.requires_cad
def test_a_bootstrap_cannot_raise_a_cap(tmp_path, site):
    rc, result, _ = run_converter(tmp_path, FIXTURES / "authored" / "l_prism.step", site, triangle_cap=10**9)
    assert result["outcome"] == "ok"  # accepted, but the effective cap stays the protocol's
    assert result["triangles"] <= CAD_TRIANGLES


@pytest.mark.requires_cad
def test_an_interrupted_write_leaves_no_stl(tmp_path, site):
    rc, result, root = run_converter(tmp_path, FIXTURES / "occt" / "sphere_r50.step", site, faults=["interrupt_write"])
    assert (rc, result["outcome"]) == (1, "render_failed")
    assert not (root / "mesh.stl").exists() and not (root / "mesh.stl.part").exists()


def test_missing_bundle_is_cad_unavailable(tmp_path):
    empty = tmp_path / "no-bundle"
    empty.mkdir()
    rc, result, root = run_converter(tmp_path, FIXTURES / "authored" / "box_mm.step", empty)
    assert (result["outcome"], result["why"], result["stage"]) == ("cad_unavailable", "bundle_import", "cad_import")
    assert not (root / "mesh.stl").exists()


def test_broken_native_library_is_cad_unavailable(tmp_path):
    broken = tmp_path / "broken-bundle"
    (broken / "OCP").mkdir(parents=True)
    (broken / "OCP" / "__init__.py").write_text("raise ImportError('DLL load failed while importing OCP')\n", "utf-8")
    rc, result, _ = run_converter(tmp_path, FIXTURES / "authored" / "box_mm.step", broken)
    assert (result["outcome"], result["why"]) == ("cad_unavailable", "bundle_import")


def test_an_unknown_fault_name_is_refused(tmp_path):
    rc, result, _ = run_converter(tmp_path, FIXTURES / "authored" / "box_mm.step", tmp_path, faults=["rm_rf"])
    assert (result["outcome"], result["why"]) == ("render_failed", "protocol_error")


@pytest.mark.requires_cad
@pytest.mark.skipif(sys.platform != "win32", reason="named skip: the Windows error-dialog check")
def test_a_native_crash_is_reaped_promptly_without_a_wer_dialog(tmp_path, site):
    import psutil

    started = time.monotonic()
    rc, result, _ = run_converter(tmp_path, FIXTURES / "authored" / "box_mm.step", site, faults=["access_violation"])
    assert rc & 0xFFFFFFFF == 0xC0000005 and result is None  # a crash writes no result: the parent decides
    assert time.monotonic() - started < 60
    assert not [p for p in psutil.process_iter(["name"]) if (p.info["name"] or "").lower() == "werfault.exe"]


def test_the_converter_never_installs_signal_handlers_or_imports_the_renderer():
    source = CHILD.read_text(encoding="utf-8")
    assert "SetSignal" not in source  # OSD.SetSignal is never called (spec §7)
    for name in ("stl_thumbnail", "trimesh", "matplotlib", "sqlalchemy", "backend.app.api", "backend.app.models"):
        assert name not in source


def test_result_json_is_bounded_and_closed(tmp_path):
    rc, result, _ = run_converter(tmp_path, None, tmp_path)
    assert result["outcome"] == "render_failed" and math.isfinite(result["elapsed_s"])
    assert set(result) <= {"pid", "outcome", "why", "stage", "elapsed_s"}
