"""The STEP-preview CAD component: committed catalog, interpreter selection, install and verify (spec §8).

Stdlib plus pip's own vendored ``packaging`` only, importable before the app runs and without a database or the
lifespan: Dockerfile, install.sh and the Windows build call ``python -m backend.app.step_runtime install|verify``.
Never imports OCP — only the disposable conversion child does (spec §6), after ``activate_bundle``.

Install selects by pip's own tag decoder; everything read-only afterwards (``locate``, ``verify``) needs no pip —
the final Docker image has none — and finds the bundle by its receipt: the fingerprint install wrote is recomputed
by the same function, so the two can never give opposite answers.

One truth: ``data/step_runtime_manifest.json`` (exact wheels, tags, upstream SHA-256, sizes, upload times, the
native-closure digest per wheel) and ``data/step_runtime_closure.json`` (every native library of every wheel),
both written by ``scripts/pin_step_runtime.py``. Requirements are generated from it, never kept beside it.

A bundle is ``<app_dir>/runtime/step-preview/<key>/<digest[:32]>/`` — ``site/`` (pip --target) and
``receipt.json`` — published by one rename after a full verify and an import smoke. Not DATA_DIR, not in backups.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import csv
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import sysconfig
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"
MANIFEST_NAME = "step_runtime_manifest.json"
CLOSURE_NAME = "step_runtime_closure.json"
PRODUCT_DIR = "step-preview"
MIN_AGE_DAYS = 14
PACKAGES = (("cadquery-ocp-novtk", "8.0.1.1.0"), ("cadquery-ocp-proxy", "8.0.1.1.0"))
EXIT_OK, EXIT_FAILED, EXIT_UNSUPPORTED = 0, 1, 3
INSTALL_SECONDS = 15 * 60
SMOKE_SECONDS = 120
NATIVE = re.compile(r"\.(so(\.\d+)*|dylib|dll|pyd)$", re.IGNORECASE)

_MANIFEST_KEYS = {
    "schema",
    "component",
    "status",
    "pinned_at",
    "min_age_days",
    "packages",
    "requires",
    "artifacts",
    "closure_file",
    "closure_sha256",
}
_ARTIFACT_KEYS = {
    "package",
    "version",
    "filename",
    "key",
    "tags",
    "sha256",
    "size",
    "upload_time",
    "native_count",
    "closure_sha256",
}
_PLATFORMS = {
    "win_amd64": "win-x64",
    "manylinux_2_28_x86_64": "linux-x64",
    "manylinux_2_28_aarch64": "linux-arm64",
    "macosx_11_0_x86_64": "darwin-x64",
    "macosx_11_0_arm64": "darwin-arm64",
}
_SHA = re.compile(r"[0-9a-f]{64}\Z")


class CatalogError(Exception):
    """The committed catalog is malformed or inconsistent: a build failure, never a fallback."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason


class Unsupported(Exception):
    """No pinned artifact for this interpreter's tags (exit 3, decided before any network)."""


class InstallError(Exception):
    """Install/import/DLL/smoke failure (exit 1)."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(UTC)


def wheel_tags(filename: str) -> set[str]:
    from pip._vendor.packaging.utils import parse_wheel_filename

    return {str(t) for t in parse_wheel_filename(filename)[3]}


def key_for_tags(tags) -> str:
    """'win-x64-cp312' from a wheel's tags; a platform the catalog does not know is a CatalogError."""
    keys = set()
    for tag in tags:
        python, _abi, plat = tag.split("-")
        if plat not in _PLATFORMS:
            raise CatalogError("unknown_platform", tag)
        keys.add(f"{_PLATFORMS[plat]}-{python}")
    if len(keys) != 1:
        raise CatalogError("artifact_fields", f"tags name {sorted(keys)}")
    return keys.pop()


def interpreter_tags() -> list[str]:
    """This interpreter's tags in pip's priority order, from pip's own vendored packaging (one decoder)."""
    from pip._vendor.packaging import tags

    return [str(t) for t in tags.sys_tags()]


def interpreter_fingerprint() -> dict:
    """What a bundle is bound to; install writes it, verify recomputes it with this same function. No uname."""
    return {
        "implementation": sys.implementation.name,
        "cache_tag": sys.implementation.cache_tag,
        "version": list(sys.version_info[:2]),
        "ext_suffix": sysconfig.get_config_var("EXT_SUFFIX"),
        "platform": sysconfig.get_platform(),
        "pointer_bits": struct.calcsize("P") * 8,
    }


# --- catalog ---------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Catalog:
    manifest: dict
    closure: dict
    digest: str


def load_catalog(data_dir: Path = DATA, *, decode_tags: bool = True) -> Catalog:
    """``decode_tags=False`` for the read-only paths without pip: the receipt binds the manifest digest, so the
    catalog they read is byte for byte the one install checked with the decoder."""
    try:
        manifest = json.loads((data_dir / MANIFEST_NAME).read_text(encoding="utf-8"))
        closure = json.loads((data_dir / CLOSURE_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CatalogError("unreadable", type(exc).__name__) from exc
    if not isinstance(manifest, dict) or set(manifest) != _MANIFEST_KEYS or manifest["schema"] != 1:
        raise CatalogError("manifest_keys")
    if manifest["status"] not in ("candidate", "release"):
        raise CatalogError("status")
    if manifest["component"] != "step-preview" or manifest["closure_file"] != CLOSURE_NAME:
        raise CatalogError("manifest_keys")
    if manifest["packages"] != [{"name": n, "version": v} for n, v in PACKAGES]:
        raise CatalogError("unknown_package", "packages")
    if hashlib.sha256(canonical(closure)).hexdigest() != manifest["closure_sha256"]:
        raise CatalogError("closure_digest", "closure file")
    if not isinstance(closure, dict) or set(closure) != {"schema", "artifacts"}:
        raise CatalogError("closure_digest", "closure shape")
    pinned = parse_time(manifest["pinned_at"])
    names = {n for n, _ in PACKAGES}
    seen_files, keys, proxies = set(), set(), 0
    for a in manifest["artifacts"]:
        if not isinstance(a, dict) or set(a) != _ARTIFACT_KEYS:
            raise CatalogError("artifact_fields", str(a.get("filename") if isinstance(a, dict) else a))
        if a["package"] not in names:
            raise CatalogError("unknown_package", a["package"])
        if (
            dict(PACKAGES)[a["package"]] != a["version"]
            or type(a["size"]) is not int
            or a["size"] <= 0
            or not isinstance(a["sha256"], str)
            or not _SHA.fullmatch(a["sha256"])
            or type(a["native_count"]) is not int
            or a["filename"] in seen_files
            or (decode_tags and sorted(wheel_tags(a["filename"])) != a["tags"])
        ):
            raise CatalogError("artifact_fields", a["filename"])
        seen_files.add(a["filename"])
        libs = closure["artifacts"].get(a["filename"])
        if (
            libs is None
            or len(libs) != a["native_count"]
            or hashlib.sha256(canonical(libs)).hexdigest() != a["closure_sha256"]
        ):
            raise CatalogError("closure_digest", a["filename"])
        if manifest["status"] == "release" and pinned - parse_time(a["upload_time"]) < timedelta(days=MIN_AGE_DAYS):
            raise CatalogError("young_pin", a["filename"])
        if a["package"] == "cadquery-ocp-proxy":
            proxies += 1
            if a["tags"] != ["py3-none-any"] or a["key"] is not None:
                raise CatalogError("artifact_fields", a["filename"])
        else:
            if a["key"] != key_for_tags(a["tags"]) or a["key"] in keys:
                raise CatalogError("artifact_fields", a["filename"])
            keys.add(a["key"])
    if proxies != 1:
        raise CatalogError("proxy_missing")
    if set(closure["artifacts"]) != seen_files:
        raise CatalogError("closure_digest", "closure names other wheels")
    return Catalog(manifest, closure, hashlib.sha256(canonical(manifest)).hexdigest())


@dataclass(frozen=True)
class Selection:
    key: str
    wheel: dict
    proxy: dict


def select(catalog: Catalog, tags: list[str] | None = None) -> Selection:
    """The first artifact pip itself would pick for these tags (priority order). Never uname."""
    tags = interpreter_tags() if tags is None else tags
    arts = catalog.manifest["artifacts"]
    proxy = next(a for a in arts if a["package"] == "cadquery-ocp-proxy")
    if "py3-none-any" not in tags:
        raise Unsupported("the proxy wheel is not installable here")
    for tag in tags:
        for a in arts:
            if a["package"] == "cadquery-ocp-novtk" and tag in a["tags"]:
                return Selection(a["key"], a, proxy)
    raise Unsupported("no pinned STEP-preview build for this interpreter")


def requirements(selection: Selection) -> str:
    return "".join(
        f"{a['package']}=={a['version']} --hash=sha256:{a['sha256']}\n" for a in (selection.wheel, selection.proxy)
    )


def bundle_root(app_dir: Path) -> Path:
    return Path(app_dir) / "runtime" / PRODUCT_DIR


def bundle_dir(app_dir: Path, key: str, digest: str) -> Path:
    return bundle_root(app_dir) / key / digest[:32]


# --- the administrator's choice (spec stage C R1) ----------------------------------------------------------------
#
# A native install carries the component only when its administrator chose it (owner's Q3): the choice is a marker
# beside the bundle root, written and read here alone. It is an intent, never evidence: whether a bundle works is
# for verify to say, and a marker written before a failed install does not make anything verified. Docker and the
# Windows installer carry the component by default and never read it.

CHOICE_FILE = "step-preview.choice.json"
CHOICES = ("enabled", "disabled")
CHOOSERS = ("install", "cli")


def choice_path(app_dir: Path) -> Path:
    return Path(app_dir) / "runtime" / CHOICE_FILE


def read_choice(app_dir: Path) -> str:
    """``enabled`` or ``disabled`` only from a marker of this schema; anything else — missing, unreadable, another
    schema or value — is ``none``, never ``enabled``."""
    try:
        body = json.loads(choice_path(app_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return "none"
    if not isinstance(body, dict) or body.get("schema") != 1 or body.get("choice") not in CHOICES:
        return "none"
    return body["choice"]


def write_choice(app_dir: Path, choice: str, *, by: str) -> None:
    """Replace the marker in one rename; a marker that cannot be written is the closed ``permission``."""
    if choice not in CHOICES or by not in CHOOSERS:
        raise ValueError(f"choice {choice!r} by {by!r}")
    target = choice_path(app_dir)
    body = {"schema": 1, "choice": choice, "decided_at": iso(datetime.now(UTC)), "by": by}
    temporary = target.with_name(f".{CHOICE_FILE}.{uuid.uuid4().hex}.tmp")
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(body, indent=1), encoding="utf-8")
        os.replace(temporary, target)
    except OSError as exc:
        with contextlib.suppress(OSError):
            temporary.unlink()
        raise InstallError("permission") from exc


def receipt_for(catalog: Catalog, selection: Selection, **extra) -> dict:
    return {
        "schema": 1,
        "manifest_digest": catalog.digest,
        "key": selection.key,
        "artifacts": [selection.wheel["filename"], selection.proxy["filename"]],
        "fingerprint": interpreter_fingerprint(),
        "status": catalog.manifest["status"],
        **extra,
    }


# --- verify ----------------------------------------------------------------------------------------------------


def _record_rows(info: Path):
    with (info / "RECORD").open(newline="", encoding="utf-8") as f:
        yield from csv.reader(f)


def _file_hash(path: Path) -> tuple[str, int]:
    h = hashlib.sha256()
    size = 0
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
            size += len(block)
    return h.hexdigest(), size


def verify_tree(site: Path, closure: list[dict]) -> list[str]:
    """Full read-only check of an installed site dir: RECORD consistency of both dists, no unlisted file, the native
    closure exactly the catalog's, the proxy present. RECORD is consistency, not an attestation (spec §8)."""
    problems = []
    infos = {p.name.split("-")[0]: p for p in site.glob("*.dist-info")}
    for dist in ("cadquery_ocp_novtk", "cadquery_ocp_proxy"):
        if dist not in infos:
            problems.append(f"{'proxy_missing' if dist.endswith('proxy') else 'package_missing'}:{dist}")
    listed = set()
    for info in infos.values():
        try:
            rows = list(_record_rows(info))
        except OSError:
            problems.append(f"record_missing:{info.name}")
            continue
        for row in rows:
            if not row:
                continue
            rel, digest, size = (row + ["", ""])[:3]
            listed.add(rel.replace("\\", "/"))
            path = site / rel
            if not digest:
                continue
            if not path.is_file():
                problems.append(f"record_mismatch:{rel}")
                continue
            algo, _, want = digest.partition("=")
            got, got_size = _file_hash(path)
            got_b64 = base64.urlsafe_b64encode(bytes.fromhex(got)).rstrip(b"=").decode()
            if algo != "sha256" or got_b64 != want or (size and int(size) != got_size):
                problems.append(f"record_mismatch:{rel}")
    natives = {}
    for path in site.rglob("*"):
        rel = path.relative_to(site).as_posix()
        if path.is_dir() or "__pycache__" in path.parts:
            continue
        if rel not in listed:
            problems.append(f"unlisted:{rel}")
        if NATIVE.search(path.name):
            natives[rel] = path
    problems += _requirements_unmet(site, infos)
    want = {lib["path"]: lib for lib in closure}
    for rel, path in natives.items():
        if rel not in want:
            problems.append(f"unknown_library:{rel}")
            continue
        got, got_size = _file_hash(path)
        if got != want[rel]["sha256"] or got_size != want[rel]["size"]:
            problems.append(f"closure_mismatch:{rel}")
    for rel in want:
        if rel not in natives:
            problems.append(f"closure_missing:{rel}")
    return problems


def _metadata(info: Path) -> dict[str, list[str]]:
    fields: dict[str, list[str]] = {}
    try:
        text = (info / "METADATA").read_text(encoding="utf-8")
    except OSError:
        return fields
    headers = text.replace("\r\n", "\n").split("\n\n", 1)[0]  # the body (long description) is not metadata
    for line in headers.splitlines():
        key, sep, value = line.partition(": ")
        if sep:
            fields.setdefault(key, []).append(value.strip())
    return fields


def _requirements_unmet(site: Path, infos: dict[str, Path]) -> list[str]:
    """pip check inside the bundle: every unconditional Requires-Dist pinned to a dist the bundle holds exactly."""
    versions = {}
    for info in infos.values():
        meta = _metadata(info)
        if meta.get("Name") and meta.get("Version"):
            versions[meta["Name"][0].lower().replace("_", "-")] = meta["Version"][0]
    problems = []
    for info in infos.values():
        for req in _metadata(info).get("Requires-Dist", []):
            if ";" in req:
                continue  # marker-gated (extras): not part of the pinned closure
            name, sep, version = req.replace(" ", "").partition("==")
            if not sep or versions.get(name.lower().replace("_", "-")) != version:
                problems.append(f"dependency_unmet:{req}")
    return problems


@dataclass(frozen=True)
class Located:
    ok: bool
    reason: str | None = None
    key: str | None = None
    site: Path | None = None
    bundle: Path | None = None
    digest: str | None = None


def locate(app_dir: Path, catalog: Catalog | None = None) -> Located:
    """Read-only and cheap (the main process calls it through disk()), no pip: the one bundle of this catalog whose
    receipt names THIS interpreter's fingerprint, or why not. Two such receipts are no answer."""
    try:
        catalog = catalog or load_catalog(decode_tags=False)
    except CatalogError:
        return Located(False, "catalog_invalid")
    proxy = next(a for a in catalog.manifest["artifacts"] if a["key"] is None)
    found, refused = [], None
    for wheel in catalog.manifest["artifacts"]:
        if wheel["key"] is None:
            continue
        sel = Selection(wheel["key"], wheel, proxy)
        target = bundle_dir(app_dir, sel.key, catalog.digest)
        try:
            receipt = json.loads((target / "receipt.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        except (OSError, ValueError):
            refused = refused or "receipt_unreadable"
            continue
        want = receipt_for(catalog, sel)
        if not isinstance(receipt, dict) or any(
            receipt.get(k) != want[k] for k in ("schema", "manifest_digest", "key", "artifacts", "fingerprint")
        ):
            refused = "receipt_mismatch"
            continue
        found.append((sel, target))
    if len(found) > 1:
        return Located(False, "receipt_mismatch")
    if not found:
        return Located(False, refused or "not_installed")
    sel, target = found[0]
    if not (target / "site" / "OCP").is_dir():
        return Located(False, "site_missing", sel.key)
    return Located(True, None, sel.key, target / "site", target, catalog.digest)


_SYSCONFIG_PLATFORMS = {"win-amd64": "win-x64", "linux-x86_64": "linux-x64", "linux-aarch64": "linux-arm64"}
_MACOS_PLATFORM = re.compile(r"macosx-[\d.]+-(x86_64|arm64|universal2)\Z")


def _python_tag() -> str:
    return f"cp{sys.version_info[0]}{sys.version_info[1]}" if sys.implementation.name == "cpython" else "other"


def _surely_unsupported(catalog: Catalog) -> bool:
    """Without pip: True only when no catalog key can serve this interpreter — its platform is none of the five the
    catalog knows, or its ABI none of the catalog's for that platform. Anything it cannot tell (a universal2 macOS
    interpreter, a musl Linux reporting linux-x86_64) is NOT unsupported: a missing bundle there stays a failure.
    A reason only, never a selection — install selects with pip's own decoder."""
    keys = {a["key"] for a in catalog.manifest["artifacts"] if a["key"]}
    plat = sysconfig.get_platform()
    mac = _MACOS_PLATFORM.match(plat)
    if mac:
        if mac.group(1) == "universal2":
            return False
        family = "darwin-x64" if mac.group(1) == "x86_64" else "darwin-arm64"
    elif plat in _SYSCONFIG_PLATFORMS:
        family = _SYSCONFIG_PLATFORMS[plat]
    else:
        return True
    return f"{family}-{_python_tag()}" not in keys


def refine_missing(found: Located) -> Located:
    """'not_installed' on an interpreter no artifact serves is 'unsupported': pip's decoder answers when pip is
    there to ask; without it (the final Docker image) only a platform or ABI the catalog surely lacks counts."""
    if found.reason != "not_installed":
        return found
    try:
        catalog = load_catalog(decode_tags=False)
    except CatalogError:
        return found
    try:
        select(catalog, interpreter_tags())
    except Unsupported:
        return Located(False, "unsupported")
    except ImportError:
        if _surely_unsupported(catalog):
            return Located(False, "unsupported")
    return found


def verify(app_dir: Path, *, full: bool = True, data_dir: Path = DATA) -> tuple[int, list[str]]:
    """Read-only, no pip: the receipt, a full rehash against the catalog and the import smoke."""
    try:
        catalog = load_catalog(data_dir, decode_tags=False)
    except CatalogError as exc:
        return EXIT_FAILED, [f"catalog_invalid:{exc.reason}"]
    found = refine_missing(locate(app_dir, catalog))
    if not found.ok:
        return (EXIT_UNSUPPORTED if found.reason == "unsupported" else EXIT_FAILED), [found.reason or "missing"]
    wheel = next(a for a in catalog.manifest["artifacts"] if a["key"] == found.key)
    problems = verify_tree(found.site, catalog.closure["artifacts"][wheel["filename"]]) if full else []
    if not problems:
        problems = smoke(found.site)
    return (EXIT_FAILED if problems else EXIT_OK), problems


def status(app_dir: Path, *, check: bool = False, data_dir: Path = DATA) -> tuple[int, dict]:
    """The choice and the bundle, in closed values without paths (spec stage C R2). Without ``check``: what the
    receipt says, cheaply — ``installed`` is never "works" (a receipt over an emptied site still locates). With
    ``check``: the full verify, ``works`` or the closed reason it failed with (the tree's as ``verify_failed:…``,
    as install words it; the smoke's as it is)."""
    answer = {"choice": read_choice(app_dir)}
    try:
        catalog = load_catalog(data_dir, decode_tags=False)
    except CatalogError as exc:
        return (EXIT_FAILED if check else EXIT_OK), {**answer, "bundle": f"catalog_invalid:{exc.reason}"}
    found = refine_missing(locate(app_dir, catalog))
    if not found.ok:
        bundle = {"not_installed": "missing"}.get(found.reason or "", found.reason or "missing")
        if not check:
            return EXIT_OK, {**answer, "bundle": bundle}
        return (EXIT_UNSUPPORTED if bundle == "unsupported" else EXIT_FAILED), {**answer, "bundle": bundle}
    if not check:
        return EXIT_OK, {**answer, "bundle": "installed"}
    wheel = next(a for a in catalog.manifest["artifacts"] if a["key"] == found.key)
    problems = [f"verify_failed:{p}" for p in verify_tree(found.site, catalog.closure["artifacts"][wheel["filename"]])]
    problems = problems or smoke(found.site)
    return (EXIT_FAILED, {**answer, "bundle": problems[0]}) if problems else (EXIT_OK, {**answer, "bundle": "works"})


PROBE_STEP = DATA / "step_probe" / "box_mm.step"
RENDER_SECONDS = 120
# The outer budget the in-app update gives one install (spec stage C R6b): a POLICY, not a proven upper bound — the
# lock wait, pip and each smoke child are bounded, the rehash and the proof of a tree's end are not. Past it the
# helper is stopped and its end still proven.
INSTALL_DEADLINE_SECONDS = 2 * INSTALL_SECONDS + SMOKE_SECONDS + 2 * RENDER_SECONDS
APP_ROOT = Path(__file__).resolve().parents[2]
MIN_DRAWN = 0.01  # of a picture's pixels must differ from its corner


def png_drawn(png: Path) -> bool:
    """A real PNG on which something was drawn: enough pixels differ from the corner (the background)."""
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(png) as img:
            if img.format != "PNG":
                return False
            rgba = img.convert("RGBA")
    except (OSError, UnidentifiedImageError):
        return False
    corner = rgba.getpixel((0, 0))
    raw = rgba.tobytes()
    differ = sum(1 for i in range(0, len(raw), 4) if tuple(raw[i : i + 4]) != corner)
    return differ >= MIN_DRAWN * rgba.width * rgba.height


def _child(module: str, request: dict, root: Path) -> dict | None:
    """One preview child as a preview runs it: the module, its one JSON request line, the worker environment. Its
    result.json, or None on a timeout (subprocess.run ends the single child it started)."""
    from backend.app.services.worker_env import worker_environment

    try:
        p = subprocess.run(
            [sys.executable, "-m", module],
            input=json.dumps(request) + "\n",
            cwd=str(APP_ROOT),
            capture_output=True,
            text=True,
            timeout=RENDER_SECONDS,
            env=worker_environment(root / "cache"),
        )
    except subprocess.TimeoutExpired:
        return None
    try:
        return json.loads((root / "result.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"outcome": f"rc={p.returncode}"}


def _convert(root: Path, site: Path, deadline: int) -> list[str]:
    shutil.copyfile(PROBE_STEP, root / "input.step")
    result = _child(
        "backend.app.services.step_thumbnail", {"root": str(root), "deadline": deadline, "site": str(site)}, root
    )
    if result is None:
        return ["smoke_timeout:convert"]
    if result.get("outcome") != "ok" or not (root / "mesh.stl").is_file():
        return [f"smoke_failed:convert:{result.get('outcome', 'unknown')}"]
    (root / "result.json").unlink(missing_ok=True)
    (root / "input.step").unlink(missing_ok=True)  # the PNG child gets only the mesh, as in a preview
    return []


def _render_png(root: Path, deadline: int) -> list[str]:
    result = _child(
        "backend.app.preview_render", {"root": str(root), "operation": "cad_png", "deadline": deadline}, root
    )
    if result is None:
        return ["smoke_timeout:png"]
    if result.get("outcome") != "ok":
        return [f"smoke_failed:png:{result.get('outcome', 'unknown')}"]
    return []


def smoke(site: Path) -> list[str]:
    """The acceptance of a bundle (spec §8, Codex A-R4): the import, then the shipped probe STEP converted by the
    converter child with exactly this bundle and its PNG rendered by the PNG child — the modules and environment a
    preview uses, never this process — and the picture decoded and showing something. Needs the backend beside the
    helper (``--import-only`` is the Docker build's early, named exception)."""
    import tempfile

    problems = import_smoke(site)
    if problems:
        return problems
    root = Path(tempfile.mkdtemp(prefix="bamdude-step-accept-"))  # never inside a (possibly read-only) bundle
    try:
        deadline = time.monotonic_ns() + int(2 * RENDER_SECONDS * 1e9)
        problems = _convert(root, site, deadline) or _render_png(root, deadline)
        if problems:
            return problems
        png = root / "preview.png"
        if not png.is_file() or not png_drawn(png):
            return ["smoke_failed:png_blank"]
        return []
    finally:
        shutil.rmtree(root, ignore_errors=True)


def import_smoke(site: Path, runner=subprocess.run) -> list[str]:
    """Import OCP from exactly this bundle in a fresh child (never in this process) and load the STEP reader,
    under the same environment whitelist every preview worker gets (no dev PATH tricks, OMP=1). Not an acceptance
    on its own: a reader that imports may still not read a STEP."""
    import tempfile

    from backend.app.services.worker_env import worker_environment

    cmd = [sys.executable, "-m", "backend.app.step_preview_probe", "--site", str(site)]
    cache = Path(tempfile.mkdtemp(prefix="bamdude-step-smoke-"))  # never inside a (possibly read-only) bundle
    try:
        p = runner(
            cmd,
            cwd=str(Path(__file__).resolve().parents[2]),
            capture_output=True,
            text=True,
            timeout=SMOKE_SECONDS,
            env=worker_environment(cache),
        )
    except subprocess.TimeoutExpired:
        return ["smoke_timeout"]
    finally:
        shutil.rmtree(cache, ignore_errors=True)
    try:
        out = json.loads(p.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        return [f"smoke_failed:rc={p.returncode}"]
    return [] if p.returncode == 0 and out.get("ok") else [f"smoke_failed:{out.get('reason', 'unknown')}"]


# --- install ---------------------------------------------------------------------------------------------------


def _pip_command(staging: Path, req: Path, wheels: Path | None) -> list[str]:
    cmd = [sys.executable, "-m", "pip", "--isolated", "--disable-pip-version-check", "install"]
    cmd += ["--target", str(staging / "site"), "--no-deps", "--only-binary=:all:", "--require-hashes"]
    cmd += ["--no-cache-dir", "--no-compile", "--no-input", "-r", str(req)]
    if wheels:
        cmd += ["--no-index", "--find-links", str(wheels)]
    return cmd


# The Windows loader opens a native library by a path of at most 250 UTF-16 units — lower than MAX_PATH - 1, and
# LongPathsEnabled or not; a library whose dependency lies past it fails too (measured 2026-10-18 after the installer
# acceptance refused a bundle whose deepest DLL lay at 259: 250 loads, 251 fails with ERROR_FILENAME_EXCED_RANGE,
# whatever the interpreter or working directory; 2026-10-16 had only bracketed it between 203 and 271).
PATH_LIMIT = 250 if sys.platform == "win32" else None


def _deepest_library(staging_site: Path, closure: list[dict]) -> int:
    longest = max((len(lib["path"]) for lib in closure), default=0)
    return len(str(staging_site.absolute()).encode("utf-16-le")) // 2 + 1 + longest


_LOCK_POLL = 0.25

if sys.platform == "win32":
    import msvcrt

    def _try_lock(handle) -> bool:
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except PermissionError:  # another process holds the byte
            return False
        return True

else:
    import fcntl

    def _try_lock(handle) -> bool:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        return True


@contextlib.contextmanager
def _platform_lock(root: Path, key: str, timeout: float):
    """One install of a platform+ABI at a time: a lock file the OS releases when its holder ends, however it ends.
    Both locks are per open handle, so two threads of one process exclude each other too. The file stays: removing
    it would race an install opening it."""
    try:
        root.mkdir(parents=True, exist_ok=True)
        handle = (root / f".{key}.lock").open("a+b")
    except PermissionError as exc:  # a tree a `sudo` run left root-owned (spec stage C R9)
        raise InstallError("permission") from exc
    with handle:
        deadline = time.monotonic() + timeout
        while not _try_lock(handle):
            if time.monotonic() >= deadline:
                raise InstallError("lock_timeout")
            time.sleep(_LOCK_POLL)
        yield  # the OS lock goes with the handle


OWNER_RECORD = "owner.pid"
INSTALLER = "installer"


def _writer_may_live(staging: Path) -> str | None:
    """Why a writer of this staging may still live; None only on a positive proof that none does (Codex A-R1).

    The installer writes its owner's record, then the launch's token (both before the spawn), then the
    bootstrap's record (before its go) — so no launch means nothing was ever started here. A record that cannot
    be read, a process that cannot be read, a boot that cannot be told and a scan that cannot be completed all
    keep the staging; another boot, no such process, another process under a recorded pid and a zombie prove an
    end. A launch without its bootstrap's record: that bootstrap never got its go, so once its owner is proven
    dead every holder of the token of the owner's user is ended. POSIX: the bootstrap led its own process group,
    and every member must be positively gone too."""
    from backend.app.services import part_render_tree as tree
    from backend.app.services.step_runtime_child import group_members

    if not (staging / f"{INSTALLER}.launch").exists():
        return None
    owner = staging / OWNER_RECORD
    why = tree.recorded_running(owner) if owner.exists() else None
    if why:
        return f"owner {why}"
    record = staging / f"{INSTALLER}.pid"
    if record.exists():
        why = tree.recorded_running(record)
        if why:
            return f"bootstrap {why}"
        if os.name != "nt":
            boot = tree.recorded_this_boot(record)
            if boot is None:
                return "bootstrap's boot unknown"
            if boot:
                try:
                    group = int(json.loads(record.read_text(encoding="ascii"))["pid"])
                except (OSError, ValueError, KeyError, TypeError):
                    return "bootstrap record unreadable"
                members = group_members(group)
                if members is None:
                    return "group scan unreadable"
                if members:
                    return f"group member pid={members[0]}"
    else:
        token = tree.launch_token(staging, INSTALLER)
        if token is None:
            return "launch unreadable"
        if not tree.end_launch_holders(token, 5, tree.recorded_user(owner)):
            return "an unreleased bootstrap not proven ended"
    for survivor in staging.glob("survivor-*.pid"):
        why = tree.recorded_running(survivor)
        if why:
            return f"survivor {why}"
    return None


def _reclaim_staging(own: Path) -> None:
    """Under this platform's lock a staging of it is a dead run's — unless a writer of it may still live
    (``_writer_may_live``), which keeps it for a later install. Never another platform's."""
    if not own.is_dir():
        return
    for path in own.iterdir():
        if not path.is_dir():
            continue
        if _writer_may_live(path):
            continue
        shutil.rmtree(path, ignore_errors=True)


def _intact(app_dir: Path, catalog: Catalog, target: Path, closure: list[dict], import_only: bool) -> bool:
    """The bundle under this pin's name is the one locate answers and passes a full verify and the acceptance."""
    found = locate(app_dir, catalog)
    if not found.ok or found.bundle != target:
        return False
    accept = import_smoke if import_only else smoke
    return not verify_tree(target / "site", closure) and not accept(target / "site")


def install(
    app_dir: Path,
    *,
    wheels: Path | None = None,
    allow_candidate: bool = False,
    data_dir: Path = DATA,
    runner=None,
    import_only: bool = False,
) -> Path:
    """Install this interpreter's bundle under its platform+ABI lock: an owned staging of its own key, pip through
    the whole-tree launcher, verify, smoke, one rename. A failed or interrupted install removes only its own
    staging — never the last good bundle, another digest or another platform; a tree whose end is not proven keeps
    its staging (a writer may live).

    A pin already in place answers ok only after its own full verify and smoke; one that fails them (or a stale
    tree under the pin's name) is repaired: it is set aside only once its verified replacement is ready, and a
    tree the OS will not move (a running converter holds it) is ``bundle_in_use``, left as it was."""
    from backend.app.services import step_runtime_child

    runner = runner or step_runtime_child.run_tree
    catalog = load_catalog(data_dir)
    sel = select(catalog)  # Unsupported -> exit 3, before any network or file
    if catalog.manifest["status"] != "release" and not allow_candidate:
        raise InstallError("candidate_pin")
    closure = catalog.closure["artifacts"][sel.wheel["filename"]]
    target = bundle_dir(app_dir, sel.key, catalog.digest)
    root = bundle_root(app_dir)
    if PATH_LIMIT is not None:  # staging is longer than the final bundle, so it bounds both
        deepest = _deepest_library(root / ".staging" / sel.key / ("0" * 32) / "site", closure)
        if deepest > PATH_LIMIT:
            raise InstallError("path_too_long", f"deepest library {deepest} > {PATH_LIMIT}; choose a shorter app dir")
    with _platform_lock(root, sel.key, INSTALL_SECONDS):
        _reclaim_staging(root / ".staging" / sel.key)
        if target.exists() and _intact(app_dir, catalog, target, closure, import_only):
            return target
        staging = root / ".staging" / sel.key / uuid.uuid4().hex
        staging.mkdir(parents=True)
        keep = False
        try:
            req = staging / "requirements.txt"
            req.write_text(requirements(sel), encoding="utf-8")
            from backend.app.services import part_render_tree as tree

            try:
                tree.record(staging / OWNER_RECORD, os.getpid())  # durable before anything is launched
            except Exception:
                raise InstallError("record_unwritable") from None  # nothing was started: the staging goes
            try:
                p = runner(
                    _pip_command(staging, req, wheels),
                    capture_output=True,
                    text=True,
                    timeout=INSTALL_SECONDS,
                    records=staging,
                )
            except subprocess.TimeoutExpired:
                raise InstallError("pip_timeout") from None
            except step_runtime_child.TreeUnproven:
                keep = True  # its records stay: the next install judges them
                raise InstallError("tree_unproven") from None
            except step_runtime_child.RecordUnwritable:
                raise InstallError("record_unwritable") from None  # never released, its end proven
            if p.returncode != 0:
                raise InstallError("pip_failed")
            problems = verify_tree(staging / "site", closure)
            if problems:
                raise InstallError(f"verify_failed:{problems[0]}")
            problems = (import_smoke if import_only else smoke)(staging / "site")
            if problems:
                raise InstallError(problems[0])
            req.unlink()
            (staging / OWNER_RECORD).unlink(missing_ok=True)  # records never travel into a bundle
            receipt = receipt_for(catalog, sel, installed_at=iso(datetime.now(UTC)), candidate=allow_candidate)
            (staging / "receipt.json").write_text(json.dumps(receipt, indent=1), encoding="utf-8")
            target.parent.mkdir(parents=True, exist_ok=True)
            aside = None
            if target.exists():  # broken or stale: set aside only now that its replacement is verified
                aside = root / ".staging" / sel.key / f"{uuid.uuid4().hex}-replaced"
                try:
                    os.replace(target, aside)
                except OSError:
                    raise InstallError("bundle_in_use") from None
            try:
                os.replace(staging, target)
            except OSError:
                if aside is not None:
                    with contextlib.suppress(OSError):
                        os.replace(aside, target)
                raise InstallError("rename_failed") from None
            if aside is not None:
                shutil.rmtree(aside, ignore_errors=True)
            return target
        finally:
            if not keep and staging.exists():
                shutil.rmtree(staging, ignore_errors=True)


PRUNE_LOCK_SECONDS = 5.0
_DIGEST_DIR = re.compile(r"[0-9a-f]{32}\Z")


def prune(
    app_dir: Path, *, other_keys: bool = False, lock_seconds: float = PRUNE_LOCK_SECONDS, data_dir: Path = DATA
) -> dict:
    """Old CAD bundles out of the way once nothing can render from them (spec stage B R10). The CALLER has already
    run a full verify of the current bundle and proven that nothing runs from this app dir (a stopped service):
    ``locate`` alone proves neither. Removes only other digests of the current key and — with ``other_keys``, the
    Windows installer's choice — bundles of this platform's other Python ABIs; never the current bundle, another
    platform or a name it does not know. Each key under its own lock, taken in a fixed order with a short budget (a
    busy key is kept, the rest goes on). A candidate is set aside first (a tree whose DLL is loaded will not move:
    in_use), then removed; a trash a failed removal left goes on the next prune; ``removed`` counts what is really
    gone. A staging whose writer may live is kept. Counts and closed reasons only, never a path."""
    kept: dict[str, int] = {}

    def keep(reason: str, count: int = 1) -> None:
        if count:
            kept[reason] = kept.get(reason, 0) + count

    def gone(path: Path) -> bool:
        with contextlib.suppress(OSError):
            shutil.rmtree(path)
        return not path.exists()

    try:
        catalog = load_catalog(data_dir, decode_tags=False)
    except CatalogError:
        return {"ok": False, "removed": 0, "kept": {}, "reason": "catalog_invalid"}
    found = locate(app_dir, catalog)
    if not found.ok:
        return {"ok": False, "removed": 0, "kept": {}, "reason": found.reason}
    root = bundle_root(app_dir)
    keys = {found.key}
    if other_keys:
        abi = re.compile(re.escape(found.key.rsplit("-", 1)[0]) + r"-cp3\d{1,2}\Z")
        keys |= {p.name for p in root.iterdir() if p.is_dir() and abi.match(p.name)}
    removed = 0
    for key in sorted(keys):
        candidates = [
            d
            for d in (root / key).iterdir()
            if d.is_dir() and _DIGEST_DIR.match(d.name) and d.resolve() != found.bundle.resolve()
        ]
        try:
            with _platform_lock(root, key, lock_seconds):
                for trash in (root / key).glob(".trash-*"):
                    if gone(trash):
                        removed += 1
                    else:
                        keep("remove_failed")
                for digest in candidates:
                    # Beside the digest it replaces, never deeper: <key>/.trash-<8 hex> is shorter than
                    # <key>/<32 hex>, and StepMaxAppDirLen leaves the deepest DLL exactly at the loader's limit.
                    aside = root / key / f".trash-{uuid.uuid4().hex[:8]}"
                    try:
                        os.replace(digest, aside)
                    except OSError:
                        keep("in_use")
                        continue
                    if gone(aside):
                        removed += 1
                    else:
                        keep("remove_failed")
                staging = root / ".staging" / key
                for path in sorted(staging.iterdir()) if staging.is_dir() else []:
                    if not path.is_dir():
                        continue
                    if _writer_may_live(path):
                        keep("writer_may_live")
                    elif gone(path):
                        removed += 1
                    else:
                        keep("remove_failed")
        except InstallError:  # lock_timeout: another install or prune of this key is running
            keep("busy", len(candidates))
    return {"ok": True, "removed": removed, "kept": kept}


def main(argv: list[str] | None = None, *, runner=None, data_dir: Path = DATA) -> int:
    ap = argparse.ArgumentParser(prog="python -m backend.app.step_runtime")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("install", "verify", "select", "requirements", "prune", "choose", "status"):
        p = sub.add_parser(name)
        p.add_argument("--app-dir", type=Path, default=Path(__file__).resolve().parents[2])
        if name == "choose":
            p.description = "Record the administrator's choice of the STEP component; installs nothing."
            p.add_argument("choice", choices=CHOICES)
            p.add_argument("--by", choices=CHOOSERS, required=True)
        if name == "status":
            p.add_argument(
                "--check", action="store_true", help="the full verify (rehash + STEP->PNG), not only the receipt"
            )
        if name == "install":
            p.add_argument("--wheels", type=Path, help="install offline from this directory of the pinned wheels")
            p.add_argument("--allow-candidate", action="store_true", help="development only; no official build")
            p.add_argument(
                "--if-enabled",
                action="store_true",
                help="only when the administrator chose the component; otherwise nothing at all (no network, no lock)",
            )
            p.add_argument(
                "--import-only",
                action="store_true",
                help="Docker's early layer only, before the backend is copied: no STEP->PNG yet; the final verify is "
                "the acceptance",
            )
        if name == "verify":
            p.add_argument("--quick", action="store_true", help="receipt only, no rehash and no smoke")
        if name == "prune":
            p.description = (
                "Remove old CAD bundles. Run only after a full verify of the current bundle and a proven stop of "
                "everything that renders from this app dir."
            )
            p.add_argument("--other-keys", action="store_true", help="also this platform's other Python ABIs")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "choose":
            write_choice(a.app_dir, a.choice, by=a.by)
            print(json.dumps({"ok": True, "choice": a.choice}))
            return EXIT_OK
        if a.cmd == "status":
            rc, answer = status(a.app_dir, check=a.check, data_dir=data_dir)
            print(json.dumps(answer))
            return rc
        if a.cmd == "install" and a.if_enabled and read_choice(a.app_dir) != "enabled":
            print(json.dumps({"ok": True, "skipped": "not_enabled"}))
            return EXIT_OK
        if a.cmd == "install":
            target = install(
                a.app_dir,
                wheels=a.wheels,
                allow_candidate=a.allow_candidate,
                data_dir=data_dir,
                runner=runner,
                import_only=a.import_only,
            )
            acceptance = "import_only" if a.import_only else "step_to_png"
            print(
                json.dumps({"ok": True, "bundle": target.relative_to(a.app_dir).as_posix(), "acceptance": acceptance})
            )
            return EXIT_OK
        if a.cmd == "prune":
            answer = prune(a.app_dir, other_keys=a.other_keys, data_dir=data_dir)
            print(json.dumps(answer))
            return EXIT_OK if answer["ok"] else EXIT_FAILED
        if a.cmd == "verify":
            if a.quick:
                found = refine_missing(locate(a.app_dir, load_catalog(data_dir, decode_tags=False)))
                rc = EXIT_OK if found.ok else EXIT_UNSUPPORTED if found.reason == "unsupported" else EXIT_FAILED
                print(json.dumps({"ok": found.ok, "reason": found.reason}))
                return rc
            rc, problems = verify(a.app_dir, data_dir=data_dir)
            print(json.dumps({"ok": rc == EXIT_OK, "problems": problems[:20]}))
            return rc
        catalog = load_catalog(data_dir)
        sel = select(catalog)
        print(sel.key if a.cmd == "select" else requirements(sel), end="\n" if a.cmd == "select" else "")
        return EXIT_OK
    except Unsupported as exc:
        print(json.dumps({"ok": False, "reason": "unsupported", "detail": str(exc)}))
        return EXIT_UNSUPPORTED
    except (CatalogError, InstallError) as exc:
        answer = {"ok": False, "reason": getattr(exc, "reason", "failed")}
        if getattr(exc, "detail", ""):
            answer["detail"] = exc.detail
        print(json.dumps(answer))
        return EXIT_FAILED
    except PermissionError:  # a tree a `sudo` run left root-owned (spec stage C R9): closed, never the raw class
        print(json.dumps({"ok": False, "reason": "permission"}))
        return EXIT_FAILED
    except Exception as exc:  # a closed answer; the traceback is not shown to the operator
        print(json.dumps({"ok": False, "reason": type(exc).__name__}))
        return EXIT_FAILED


if __name__ == "__main__":
    raise SystemExit(main())
