"""Acceptance of the preview chain where it is installed (plan A7): a cube STL and — where this interpreter has a CAD
build — the shipped STEP fixture through the real PreviewRuntime to a PNG, as whoever runs it and with no network
(the broker is local). The Docker build runs it as the app's user in the final image; the platform smoke runs it
on every runner.

``python -m backend.app.step_render_probe [--app-dir DIR]`` prints one JSON line. Exit 0: every expected picture
rendered. Exit 3: this interpreter has no CAD build and the STL rendered (armv7 and the like: STL only). Exit 1:
anything else — a supported platform without its bundle included. Nothing is written outside a temporary dir.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import tempfile
from pathlib import Path

from backend.app import step_runtime

STEP_FIXTURE = step_runtime.PROBE_STEP
drawn = step_runtime.png_drawn  # one rule for "something was drawn", shared with the install's acceptance


def _cube_stl() -> str:
    v = [(x, y, z) for x in (0, 20) for y in (0, 20) for z in (0, 20)]
    faces = [(0, 2, 3, 1), (4, 5, 7, 6), (0, 1, 5, 4), (2, 6, 7, 3), (0, 4, 6, 2), (1, 3, 7, 5)]
    rows = ["solid cube"]
    for a, b, c, d in faces:
        for tri in ((a, b, c), (a, c, d)):
            rows.append(" facet normal 0 0 0\n  outer loop")
            rows += [f"   vertex {v[i][0]} {v[i][1]} {v[i][2]}" for i in tri]
            rows.append("  endloop\n endfacet")
    rows.append("endsolid cube")
    return "\n".join(rows) + "\n"


async def _render(runtime, path: Path, kind: str) -> dict:
    async with runtime.attempt({"mesh": (path, kind)}) as result:
        png = result.files.get("preview") if result.outcome == "ok" else None
        report = {"outcome": result.outcome, "png": png is not None and drawn(png)}
        if kind == "step":
            report["stage"] = result.stage
        return report


async def probe(app_dir: Path, *, work: Path) -> tuple[int, dict]:
    from backend.app.services.preview_runtime import PreviewRuntime

    found = step_runtime.refine_missing(step_runtime.locate(app_dir))
    work.mkdir(parents=True, exist_ok=True)
    runtime = PreviewRuntime(work / "preview", app_dir=app_dir)
    try:
        await runtime.start()
        cube = work / "cube.stl"
        cube.write_text(_cube_stl(), encoding="ascii")
        report = {"stl": await _render(runtime, cube, "stl")}
        report["step"] = await _render(runtime, STEP_FIXTURE, "step") if found.ok else {"outcome": found.reason}
    finally:
        await runtime.stop()
        for child in list(work.iterdir()):
            shutil.rmtree(child, ignore_errors=True) if child.is_dir() else child.unlink(missing_ok=True)
    stl_ok = report["stl"] == {"outcome": "ok", "png": True}
    if stl_ok and report["step"].get("outcome") == "ok" and report["step"].get("png"):
        return step_runtime.EXIT_OK, report
    if stl_ok and report["step"] == {"outcome": "unsupported"}:
        return step_runtime.EXIT_UNSUPPORTED, report
    return step_runtime.EXIT_FAILED, report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m backend.app.step_render_probe")
    ap.add_argument("--app-dir", type=Path, default=Path(__file__).resolve().parents[2])
    a = ap.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix="bamdude-render-probe-") as tmp:
        try:
            rc, report = asyncio.run(probe(a.app_dir, work=Path(tmp)))
        except Exception as exc:  # a closed answer; the traceback is not the operator's
            rc, report = step_runtime.EXIT_FAILED, {"error": type(exc).__name__}
    print(json.dumps({"ok": rc == step_runtime.EXIT_OK, **report}))
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
