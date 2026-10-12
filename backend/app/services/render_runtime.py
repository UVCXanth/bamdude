"""The part-render runtime: the pinned official Node.js -- platform, provisioning, location (spec §6).

Stdlib only, importable before the app runs: Dockerfile, install.sh and the
Windows build call ``python -m backend.app.services.render_runtime provision``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform as _platform
import re
import shutil
import struct
import sys
import sysconfig
import tarfile
import tempfile
import time
import urllib.request
import zipfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

MANIFEST = Path(__file__).resolve().parents[1] / "data" / "render_runtime.json"
PRODUCT_DIR = "node"
# Node 24 official builds for five platforms; Node 22 -- the last line with an official linux-armv7l -- for 32-bit
# ARM (part-render-node-lines-spec D1, D2). The lines live in scripts/pin_render_runtime.py LINES.
PLATFORMS = ("linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win-x64", "linux-armv7l")
_ARMHF = "arm-linux-gnueabihf"
_ARM32_MACHINES = frozenset({"armv7l", "armv8l"})
_ARM64_KERNELS = frozenset({"aarch64", "arm64", "armv8l"})
_HEADERS = {"User-Agent": "BamDude render-runtime provisioning"}


class ProvisionError(RuntimeError):
    pass


class UnsupportedPlatform(ProvisionError):
    """No official Node.js build for this machine: part thumbnails run their fallback methods (no_runtime)."""


def interpreter_triplet() -> str:
    """This interpreter's target triplet from SOABI (``cpython-313-arm-linux-gnueabihf``), '' when it names none."""
    parts = (sysconfig.get_config_var("SOABI") or "").split("-", 2)
    return parts[2] if len(parts) == 3 else ""


def _interpreter_bits() -> int:
    """This interpreter's pointer width -- the USERLAND's, which uname does not report."""
    return struct.calcsize("P") * 8


def platform_key(
    system: str | None = None, machine: str | None = None, *, bits: int | None = None, triplet: str | None = None
) -> str:
    system = (system or _platform.system()).lower()
    machine = (machine or _platform.machine()).lower()
    bits = bits or _interpreter_bits()
    if system == "linux" and (machine in _ARM32_MACHINES or (bits == 32 and machine in _ARM64_KERNELS)):
        # uname names the KERNEL: Raspberry Pi OS 32-bit boots a 64-bit kernel on a Pi 4 / Pi 5 (aarch64) while the
        # userland is armhf. The official armv7l Node is glibc hard-float, so the userland decides (spec D4).
        abi = interpreter_triplet() if triplet is None else triplet
        if abi != _ARMHF:
            raise UnsupportedPlatform(
                f"no official Node.js build for a 32-bit ARM userland that is not armhf ({abi or 'unknown ABI'})"
            )
        key = "linux-armv7l"
    else:
        arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
        key = (
            {"linux": f"linux-{arch}", "darwin": f"darwin-{arch}", "windows": f"win-{arch}"}.get(system)
            if arch
            else None
        )
        if system == "linux" and bits == 32:
            raise UnsupportedPlatform(f"no official Node.js build for a 32-bit linux userland ({machine} kernel)")
    # ONE exit for every recognised machine (consilium NL-R1): a platform whose line ended and left PLATFORMS is
    # unsupported here -- exit 3 and the clean-up of D9 -- never a key the manifest no longer pins (exit 1, old Node
    # left on disk). armv6l (Pi 1, Zero), riscv64 ...: the top-view fallback (spec §5.3, §6.1), never a third-party build
    if key not in PLATFORMS:
        raise UnsupportedPlatform(f"no official Node.js build for {system}/{machine}")
    return key


_PLATFORM_ENTRY = re.compile(r"\.?((?:linux|darwin|win)-[a-z0-9]+)(?:\..*)?")


def prune_retired_platforms(runtime_root: Path) -> list[str]:
    """Spec D9: a platform that left PLATFORMS (its line ended, D3) leaves nothing executable behind -- its tree and
    its ``.<key>.*`` leftovers go. A pinned platform is never touched, this machine's or not: a checkout mounted
    into a container holds the HOST's Node. Names that are no platform key are not ours to judge."""
    product = runtime_root / PRODUCT_DIR
    if not product.is_dir():
        return []
    removed = []
    for entry in sorted(product.iterdir(), key=lambda p: p.name):
        match = _PLATFORM_ENTRY.fullmatch(entry.name)
        if match is None or match.group(1) in PLATFORMS:
            continue
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink()
        removed.append(entry.name)
    return removed


def artifacts_from_shasums(text: str, version: str, platforms: Iterable[str]) -> dict[str, tuple[str, str]]:
    """The official archive of each of ``platforms`` (one line's) in a release's SHASUMS256.txt: platform ->
    (file name, sha256).

    A platform the release does not publish is an error naming every such platform at once (consilium N1);
    no other build is ever substituted.
    """
    sums = {}
    for line in text.splitlines():
        fields = line.split()
        if len(fields) == 2:
            sums[fields[1]] = fields[0]
    found: dict[str, tuple[str, str]] = {}
    missing = []
    for key in platforms:
        name = f"node-{version}-{key}.{'zip' if key == 'win-x64' else 'tar.xz'}"
        if name in sums:
            found[key] = (name, sums[name])
        else:
            missing.append(key)
    if missing:
        raise ProvisionError(f"Node.js {version} publishes no official archive for {', '.join(missing)}")
    return found


def load_manifest(path: Path = MANIFEST) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def pinned_version(manifest: dict, key: str) -> str:
    """The version ``key`` is pinned to: its LINE's (part-render-node-lines-spec D1), written once per line."""
    entry = manifest["platforms"].get(key)
    if entry is None:
        raise ProvisionError(f"the manifest pins no build for {key}")
    return manifest["lines"][entry["line"]]["version"]


def download(url: str, dest: Path, limit: int | None = None) -> None:
    """Fetch ``url`` into ``dest``; past ``limit`` bytes (the pinned size) it stops instead of filling the disk."""
    size = 0
    with (
        urllib.request.urlopen(urllib.request.Request(url, headers=_HEADERS), timeout=60) as resp,
        dest.open("wb") as out,
    ):
        while block := resp.read(1024 * 1024):
            size += len(block)
            if limit is not None and size > limit:
                raise ProvisionError(f"{url}: larger than the pinned {limit} bytes")
            out.write(block)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _inside(root: Path, name: str) -> Path:
    """The archive entry ``name`` with its top directory stripped, refused if it would leave ``root``."""
    parts = Path(name).parts[1:]
    target = (root / Path(*parts)).resolve() if parts else root
    if target != root and root not in target.parents:
        raise ProvisionError(f"unsafe archive entry: {name}")
    return target


# What is installed of the official archive (owner, 2026-10-07): the executable and its licence. npm, npx,
# corepack, headers and docs are not needed by the renderer and do not belong beside a service.
_INSTALLED = frozenset({"bin/node", "node.exe", "LICENSE"})


def _extract(archive: Path, dest: Path) -> None:
    """Unpack the executable and the licence of the official archive (``node-vX-<platform>/...``),
    top directory stripped. Every entry is checked first: an archive with one unsafe entry is refused whole."""
    root = dest.resolve()
    try:
        if archive.name.endswith(".zip"):
            with zipfile.ZipFile(archive) as zf:
                infos = [(i, _inside(root, i.filename)) for i in zf.infolist()]
                for info, target in infos:
                    if target == root or info.is_dir() or target.relative_to(root).as_posix() not in _INSTALLED:
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(info) as src, target.open("wb") as out:
                        shutil.copyfileobj(src, out, 1024 * 1024)
            return
        with tarfile.open(archive, "r:*") as tf:
            members = []
            for m in tf.getmembers():
                target = _inside(root, m.name)
                if target == root or not m.isfile() or target.relative_to(root).as_posix() not in _INSTALLED:
                    continue
                m.name = target.relative_to(root).as_posix()
                members.append(m)
            tf.extractall(root, members=members, filter="data")
    except (tarfile.TarError, zipfile.BadZipFile) as exc:
        raise ProvisionError(f"broken archive: {exc}") from exc


def _executable(target: Path, key: str) -> Path:
    return target / "node.exe" if key == "win-x64" else target / "bin" / "node"


def _rename(src: Path, dst: Path, *, attempts: int = 20, delay: float = 0.5) -> None:
    """Rename, waiting out a short hold: on Windows a just-unpacked tree is held for a moment
    (an antivirus scanning the new node.exe) and refuses the rename; a hold that outlasts the
    retries is an error."""
    for attempt in range(attempts):
        try:
            src.rename(dst)
            return
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(delay)


def provision(
    runtime_root: Path,
    *,
    manifest: dict | None = None,
    platform: str | None = None,
    fetch: Callable[[str, Path, int | None], None] | None = None,
) -> Path:
    fetch = fetch or download  # looked up at call time: the CLI and its tests reach the module's download
    manifest = manifest or load_manifest()
    key = platform or platform_key()
    entry = manifest["platforms"].get(key)
    if entry is None:
        raise ProvisionError(f"the manifest pins no build for {key}")
    version = pinned_version(manifest, key)
    target = runtime_root / PRODUCT_DIR / key
    marker = target / "VERSION"
    # The marker alone is not an install: a quarantined or deleted executable
    # must be put back by the next run, not reported as already there.
    if (
        marker.is_file()
        and marker.read_text(encoding="utf-8").strip() == version
        and _executable(target, key).is_file()
    ):
        prune_retired_platforms(runtime_root)
        return target

    target.parent.mkdir(parents=True, exist_ok=True)
    staged = target.parent / f".{key}.{version}.part"
    shutil.rmtree(staged, ignore_errors=True)
    with tempfile.TemporaryDirectory(dir=target.parent, prefix=f".{key}.download.") as tmp:
        # Named after the URL so _extract sees the archive's suffix.
        archive = Path(tmp) / Path(entry["url"]).name
        fetch(entry["url"], archive, entry["bytes"])
        if archive.stat().st_size != entry["bytes"] or _sha256(archive) != entry["sha256"]:
            raise ProvisionError(f"{key}: sha256 or size does not match the manifest")
        staged.mkdir()
        try:
            _extract(archive, staged)
            (staged / "VERSION").write_text(version + "\n", encoding="utf-8")
        except BaseException:
            shutil.rmtree(staged, ignore_errors=True)
            raise
    old = target.parent / f".{key}.old"
    if target.exists():
        shutil.rmtree(old, ignore_errors=True)  # a stale backup of a swap that completed
        had_previous = True
        _rename(target, old)
    else:
        # No runtime in place: a backup left by an earlier failed restore is the only runtime there is,
        # and it stays until a runtime is back in place (Codex review 2026-10-07).
        had_previous = old.exists()
    try:
        _rename(staged, target)
    except OSError as exc:
        # The new tree is refused for good: put the previous runtime back where locate_in looks, never leave
        # the install with no Node at all; a failed restore keeps the backup and says where it is.
        if had_previous:
            try:
                _rename(old, target)
            except OSError as restore_exc:
                raise ProvisionError(
                    f"{key}: the new runtime could not be put in place ({exc}) and the previous one could not be "
                    f"restored ({restore_exc}); it is kept at {old}"
                ) from exc
        shutil.rmtree(staged, ignore_errors=True)
        kept = "; the previous one is kept" if had_previous else ""
        raise ProvisionError(f"{key}: the new runtime could not be put in place ({exc}){kept}") from exc
    shutil.rmtree(old, ignore_errors=True)
    prune_retired_platforms(runtime_root)
    return target


@dataclass(frozen=True)
class NodeInstall:
    executable: Path
    version: str
    platform: str


def locate(app_dir: Path) -> NodeInstall | None:
    """The provisioned Node under <app_dir>/runtime -- the only place looked at (spec §6.2)."""
    return locate_in(app_dir / "runtime")


def locate_in(runtime_root: Path, platform: str | None = None) -> NodeInstall | None:
    """The Node provisioned into this runtime directory.

    Three answers, never folded into one (consilium R5.3):
      NodeInstall          -- installed;
      None                 -- a supported platform with nothing installed: runtime_missing;
      UnsupportedPlatform  -- raised, never caught here: no official Node build exists for
                              this machine, part thumbnails run their fallback methods (no_runtime).
    """
    key = platform_key() if platform is None else platform
    if key not in PLATFORMS:
        raise UnsupportedPlatform(f"no official Node.js build for {key}")
    target = runtime_root / PRODUCT_DIR / key
    marker = target / "VERSION"
    executable = _executable(target, key)
    if not marker.is_file() or not executable.is_file():
        return None
    return NodeInstall(executable=executable, version=marker.read_text(encoding="utf-8").strip(), platform=key)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="render_runtime")
    sub = parser.add_subparsers(dest="command", required=True)
    prov = sub.add_parser("provision", help="install the pinned official Node.js")
    prov.add_argument("--runtime", type=Path, required=True)
    prov.add_argument("--platform", default=None)
    # The Docker build provisions from a copy of this module and the manifest
    # alone, before the rest of backend/ is copied, so the layer is cached.
    prov.add_argument("--manifest", type=Path, default=MANIFEST)
    args = parser.parse_args(argv)
    try:
        target = provision(args.runtime, manifest=load_manifest(args.manifest), platform=args.platform)
    except UnsupportedPlatform as exc:
        prune_retired_platforms(args.runtime)  # spec D9: a line that ended leaves no runtime behind
        print(f"render-runtime: {exc}: part thumbnails use the top-view fallback", file=sys.stderr)
        return 3
    except (ProvisionError, OSError) as exc:
        # A blocked host, a full disk or a tree still held after the retries: a message, not a traceback.
        print(f"render-runtime: {exc}", file=sys.stderr)
        return 1
    print(f"render-runtime: {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
