"""Child-side activation of the STEP-preview bundle (spec §8) — the one way OCP is imported, in a child only.

``activate_bundle(site)`` puts exactly the main-approved bundle first, removes the user site and every other entry
that could supply an ``OCP`` package, imports it and proves its origin is inside the bundle. ``python -m
backend.app.step_preview_probe --site <dir>`` is the install/verify smoke: import, load the STEP reader, one JSON
line on stdout. Never imported by the main process or the preview service.
"""

from __future__ import annotations

import argparse
import json
import os
import site as _site
import sys
from pathlib import Path


class BundleOriginError(ImportError):
    """OCP came from somewhere other than the approved bundle."""


def _foreign(entry: str, bundle: Path) -> bool:
    """A path entry that could supply OCP from outside the bundle: the user site or any dir holding an OCP package."""
    if not entry:
        return False
    try:
        path = Path(entry).resolve()
    except OSError:
        return True
    if path == bundle:
        return False
    user = _site.getusersitepackages() if _site.ENABLE_USER_SITE is not False else None
    if user and Path(user).resolve() == path:
        return True
    return (path / "OCP").exists()


def activate_bundle(site: Path) -> Path:
    bundle = Path(site).resolve()
    if "OCP" in sys.modules:
        raise BundleOriginError("OCP was imported before the bundle was activated")
    sys.dont_write_bytecode = True  # the bundle is immutable; no __pycache__ written into it
    sys.path[:] = [str(bundle), *(p for p in sys.path if not _foreign(p, bundle))]
    import OCP

    origin = Path(OCP.__file__).resolve()
    if bundle not in origin.parents:
        raise BundleOriginError("OCP origin is outside the bundle")
    return origin


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", required=True, type=Path)
    a = ap.parse_args(argv)
    if os.name == "nt":
        import ctypes

        ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002 | 0x8000)  # no Windows error dialog before a DLL load
    try:
        origin = activate_bundle(a.site)
        from OCP.STEPControl import STEPControl_Reader

        STEPControl_Reader()
        print(json.dumps({"ok": True, "origin": origin.relative_to(Path(a.site).resolve()).as_posix()}))
        return 0
    except BundleOriginError:
        print(json.dumps({"ok": False, "reason": "origin"}))
    except ImportError:
        print(json.dumps({"ok": False, "reason": "import"}))
    except Exception as exc:
        print(json.dumps({"ok": False, "reason": type(exc).__name__}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
