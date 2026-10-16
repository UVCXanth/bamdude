"""Maintainer repin tool for the STEP-preview CAD component (spec §8, §9). Never run on a user's machine.

python scripts/pin_step_runtime.py --wheels <dir> --index <pypi-index.json> [--now ISO] [--check]

Reads the exact wheels (a local directory of downloaded files) and the PyPI JSON of both packages (saved from
https://pypi.org/pypi/<name>/<version>/json, or the {name: {"info", "files"}} index the stage-0 research wrote),
verifies every wheel's SHA-256 and size against PyPI, inventories the native closure inside each wheel and writes
backend/app/data/step_runtime_manifest.json + step_runtime_closure.json. The status is ``release`` only when every
artifact was published at least MIN_AGE_DAYS before the pin (owner, Q9); otherwise ``candidate`` — installable only
with an explicit ``--allow-candidate`` that no official build passes. ``--check`` writes nothing and exits 1 when
the committed files differ from what the wheels and index say.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "backend" / "app" / "data"
sys.path.insert(0, str(ROOT))

from backend.app.step_runtime import (  # noqa: E402
    CLOSURE_NAME,
    MANIFEST_NAME,
    MIN_AGE_DAYS,
    PACKAGES,
    canonical,
    key_for_tags,
    wheel_tags,
)

NATIVE = re.compile(r"\.(so(\.\d+)*|dylib|dll|pyd)$", re.IGNORECASE)
PYTHONS = ("cp312", "cp313", "cp314")


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(UTC)


def native_closure(wheel: Path) -> list[dict]:
    out = []
    with zipfile.ZipFile(wheel) as z:
        for info in sorted(z.infolist(), key=lambda i: i.filename):
            if info.is_dir() or not NATIVE.search(info.filename):
                continue
            h = hashlib.sha256()
            with z.open(info) as f:
                for block in iter(lambda: f.read(1 << 20), b""):
                    h.update(block)
            out.append({"path": info.filename, "sha256": h.hexdigest(), "size": info.file_size})
    return out


def build(wheels: Path, index: dict, now: datetime) -> tuple[dict, dict]:
    local = {p.name: p for p in wheels.rglob("*.whl")}
    artifacts, closure, young = [], {}, []
    for name, version in PACKAGES:
        entry = index.get(name)
        if not entry or entry["info"]["version"] != version:
            raise SystemExit(f"index has no {name}=={version}")
        for f in entry["files"]:
            filename = f["filename"]
            if not filename.endswith(".whl") or f.get("yanked"):
                continue
            tags = sorted(wheel_tags(filename))
            if name == "cadquery-ocp-novtk" and not any(t.split("-")[0] in PYTHONS for t in tags):
                continue  # cp311: below the app's Python floor
            if filename not in local:
                raise SystemExit(f"wheel {filename} is not in {wheels}")
            data = local[filename].read_bytes()
            sha = hashlib.sha256(data).hexdigest()
            if sha != f["sha256"] or len(data) != f["size"]:
                raise SystemExit(f"{filename}: local bytes differ from PyPI (sha256/size)")
            uploaded = parse_time(f["upload_time_iso_8601"])
            if now - uploaded < timedelta(days=MIN_AGE_DAYS):
                young.append(filename)
            libs = native_closure(local[filename])
            closure[filename] = libs
            artifacts.append(
                {
                    "package": name,
                    "version": version,
                    "filename": filename,
                    "key": key_for_tags(tags) if name == "cadquery-ocp-novtk" else None,
                    "tags": tags,
                    "sha256": sha,
                    "size": len(data),
                    "upload_time": iso(uploaded),
                    "native_count": len(libs),
                    "closure_sha256": hashlib.sha256(canonical(libs)).hexdigest(),
                }
            )
    closure_doc = {"schema": 1, "artifacts": closure}
    manifest = {
        "schema": 1,
        "component": "step-preview",
        "status": "candidate" if young else "release",
        "pinned_at": iso(now),
        "min_age_days": MIN_AGE_DAYS,
        "packages": [{"name": n, "version": v} for n, v in PACKAGES],
        "requires": {"cadquery-ocp-novtk": ["cadquery-ocp-proxy==8.0.1.1.0"], "cadquery-ocp-proxy": []},
        "artifacts": sorted(artifacts, key=lambda a: a["filename"]),
        "closure_file": CLOSURE_NAME,
        "closure_sha256": hashlib.sha256(canonical(closure_doc)).hexdigest(),
    }
    if young:
        print(f"candidate: {len(young)} artifact(s) younger than {MIN_AGE_DAYS} days", file=sys.stderr)
    return manifest, closure_doc


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wheels", required=True, type=Path)
    ap.add_argument("--index", required=True, type=Path)
    ap.add_argument("--now", help="pin time (ISO, UTC); default the current time")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    if a.now:
        now = parse_time(a.now)
    elif a.check:  # the committed pin's own time, or every check would be stale
        now = parse_time(json.loads((DATA / MANIFEST_NAME).read_text(encoding="utf-8"))["pinned_at"])
    else:
        now = datetime.now(UTC)
    manifest, closure = build(a.wheels, json.loads(a.index.read_text(encoding="utf-8")), now)
    texts = {
        DATA / MANIFEST_NAME: json.dumps(manifest, indent=1) + "\n",
        DATA / CLOSURE_NAME: json.dumps(closure, indent=1) + "\n",
    }
    if a.check:
        # line ends normalised: a Windows checkout (autocrlf) holds the same committed text with CRLF
        stale = [
            p.name
            for p, t in texts.items()
            if not p.exists() or p.read_text(encoding="utf-8").replace("\r\n", "\n") != t
        ]
        if stale:
            print(f"out of date: {stale}", file=sys.stderr)
            return 1
        return 0
    for path, text in texts.items():
        path.write_text(text, encoding="utf-8", newline="\n")
    print(json.dumps({"status": manifest["status"], "artifacts": len(manifest["artifacts"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
