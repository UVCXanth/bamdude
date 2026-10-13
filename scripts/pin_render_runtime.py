"""Pin the official Node.js for every platform BamDude ships (spec §6.1; lines: part-render-node-lines-spec D1-D6).

A platform runs a LINE (LINES): the newest Node.js LTS line that publishes an
official build for it. For every line the script takes the newest LTS patch
from nodejs.org/dist/index.json, reads that release's SHASUMS256.txt.asc and
accepts its hashes only when one of the Node.js release keys vendored in
scripts/node-release-keys.asc signed it (gpg; TLS alone is not trusted) --
never a third-party build -- takes each platform's official archive through
render_runtime.artifacts_from_shasums, sizes it with a HEAD request and
rewrites backend/app/data/render_runtime.json. A line whose end of life
(nodejs/Release schedule.json) has passed is refused. Then it provisions this
machine's pin into <repo>/runtime and writes the stand's golden hashes on it.

index.json and schedule.json are read over TLS for WHICH version and WHICH
date only, never for a hash.

    python scripts/pin_render_runtime.py [--line 24=vX.Y.Z ...]   # pin: the newest patch of every line
    python scripts/pin_render_runtime.py --check                  # JSON report; exit 0 current, 2 action, 1 error

Update policy (spec §6.3): the pin is reviewed at every BamDude release and
checked weekly in CI (.github/workflows/node-pin.yml); between releases a
patch release carries a new pin when a Node.js security bulletin touches V8 or
a module the render script uses (zlib). The pin's date is in the manifest.

The release keys are every fingerprint of nodejs/release-keys keys.list
(vendored from commit 481637f813e9, 2026-09-01). A release signed by a key
that is not there is refused: refresh the file from that repository after
checking who the new releaser is.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from datetime import date
from pathlib import Path, PureWindowsPath

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.app.services.part_render_protocol import RENDERER_VERSION  # noqa: E402
from backend.app.services.render_runtime import (  # noqa: E402
    MANIFEST,
    PLATFORMS,
    ProvisionError,
    artifacts_from_shasums,
    load_manifest,
    locate_in,
    pinned_version,
    platform_key,
    provision,
)

GOLDEN = ROOT / "backend" / "app" / "data" / "render_probe" / "golden.json"
DIST = "https://nodejs.org/dist"
SCHEDULE = "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json"
KEYS = Path(__file__).resolve().with_name("node-release-keys.asc")
HEADERS = {"User-Agent": "BamDude render-runtime pin"}
# Spec D2: a platform runs the newest LTS line that publishes an official signed build for it. The table is code:
# a new major line is a maintainer's decision with acceptance, never pinned by this script on its own.
LINES: dict[str, tuple[str, ...]] = {
    "24": ("linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win-x64"),
    # the last line with an official linux-armv7l (Node 24 dropped it); its end of life ends armv7 (spec D3)
    "22": ("linux-armv7l",),
}
END_SOON_DAYS = 90


class PinError(RuntimeError):
    pass


def _open(url: str, method: str = "GET"):
    return urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS, method=method), timeout=60)


def fetch_json(url: str):
    with _open(url) as resp:
        return json.load(resp)


def _size(url: str) -> int:
    with _open(url, "HEAD") as resp:
        length = resp.headers.get("Content-Length")
    if length:
        return int(length)
    size = 0
    with _open(url) as resp:
        while block := resp.read(1024 * 1024):
            size += len(block)
    return size


def gpg_home(path: str, gpg: str) -> str:
    """``path`` as this gpg takes a --homedir: Git for Windows ships an MSYS gpg, which refuses ``C:\\...``."""
    if os.name != "nt":
        return path
    version = subprocess.run([gpg, "--version"], capture_output=True, text=True, check=True).stdout
    home_line = next((line for line in version.splitlines() if line.startswith("Home:")), "")
    if not home_line.split(":", 1)[-1].strip().startswith("/"):
        return path  # a native Windows gpg (Gpg4win) takes the Windows path as it is
    win = PureWindowsPath(path)
    return "/" + win.drive[0].lower() + "/" + "/".join(win.parts[1:])


def verify_shasums(signed: bytes, keys: bytes, gpg: str) -> str:
    """The body of a clear-signed SHASUMS256.txt.asc -- only when one of ``keys`` made a valid signature.

    A throwaway keyring holds nothing but ``keys``; the data goes through stdin (the MSYS gpg reads
    no Windows path) and the verdict is gpg's VALIDSIG status line, not its exit code alone.
    """
    with tempfile.TemporaryDirectory() as tmp:
        base = [gpg, "--homedir", gpg_home(tmp, gpg), "--batch"]
        subprocess.run([*base, "--quiet", "--import"], input=keys, capture_output=True, check=True)
        result = subprocess.run([*base, "--status-fd", "2", "--decrypt"], input=signed, capture_output=True)
    status = result.stderr.decode("utf-8", "replace")
    if result.returncode != 0 or "[GNUPG:] VALIDSIG " not in status:
        raise ProvisionError("SHASUMS256.txt.asc: no valid signature by a vendored Node.js release key")
    return result.stdout.decode("utf-8")


def _vkey(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.lstrip("v").split("."))


def newest_patch(releases: list[dict], line: str) -> str:
    """The newest LTS release of ``line`` in index.json."""
    found = [r["version"] for r in releases if r.get("lts") and r["version"].startswith(f"v{line}.")]
    if not found:
        raise PinError(f"no Node.js {line} LTS release in {DIST}/index.json")
    return max(found, key=_vkey)


def security_releases_after(releases: list[dict], line: str, pinned: str) -> list[str]:
    return sorted(
        (
            r["version"]
            for r in releases
            if r.get("security") and r["version"].startswith(f"v{line}.") and _vkey(r["version"]) > _vkey(pinned)
        ),
        key=_vkey,
    )


def end_of_life(schedule: dict, line: str) -> date:
    entry = schedule.get(f"v{line}")
    if not entry or "end" not in entry:
        raise PinError(f"nodejs/Release schedule.json names no end of life for Node.js {line}")
    return date.fromisoformat(entry["end"])


def newer_lts_lines(schedule: dict, today: date) -> list[str]:
    """LTS lines that have started, are still supported and are newer than every line of LINES (spec D2: reported,
    never pinned here)."""
    top = max(int(line) for line in LINES)
    found = []
    for name, entry in schedule.items():
        number = name.lstrip("v")
        if not number.isdigit() or int(number) <= top or "lts" not in entry:
            continue
        if date.fromisoformat(entry["lts"]) <= today < date.fromisoformat(entry["end"]):
            found.append(number)
    return sorted(found, key=int)


_VERSION = re.compile(r"v\d+\.\d+\.\d+")


def lts_release(releases: list[dict], line: str, version: str) -> str:
    """``version`` when it is a published LTS release of ``line``, else PinError -- before anything is downloaded
    (consilium NL-R2: the signature proves where an archive comes from, not that it fits the line policy). An older
    patch of the same LTS is allowed on purpose: the way back from a patch that broke the renderer."""
    if not _VERSION.fullmatch(version):
        raise PinError(f"--line {line}={version}: not a vX.Y.Z version")
    if not version.startswith(f"v{line}."):
        raise PinError(
            f"--line {line}={version}: not a Node.js {line} release; a new major is a LINES change (spec D2)"
        )
    release = next((r for r in releases if r["version"] == version), None)
    if release is None:
        raise PinError(f"--line {line}={version}: no such release in {DIST}/index.json")
    if not release.get("lts"):
        raise PinError(f"--line {line}={version}: not an LTS release")
    return version


def plan_versions(releases: list[dict], schedule: dict, today: date, overrides: dict[str, str]) -> dict[str, dict]:
    """{line: {version, end_of_life}} for every line of LINES; a line past its end of life is refused (spec D3)."""
    unknown = sorted(set(overrides) - set(LINES))
    if unknown:
        raise PinError(f"--line names no line of LINES: {', '.join(unknown)}")
    plan = {}
    for line, platforms in LINES.items():
        ends = end_of_life(schedule, line)
        if ends < today:
            raise PinError(
                f"Node.js {line} reached its end of life on {ends}: drop {', '.join(platforms)} from LINES and "
                "render_runtime.PLATFORMS (spec D3)"
            )
        version = lts_release(releases, line, overrides[line]) if line in overrides else newest_patch(releases, line)
        plan[line] = {"version": version, "end_of_life": ends.isoformat()}
    return plan


def check(manifest: dict, releases: list[dict], schedule: dict, today: date) -> dict:
    """Spec D6 --check: what the weekly workflow and the release manual ask. Reads, never writes."""
    lines = {}
    for line in LINES:
        pinned = (manifest.get("lines", {}).get(line) or {}).get("version", "v0.0.0")
        newest = newest_patch(releases, line)
        days = (end_of_life(schedule, line) - today).days
        lines[line] = {
            "pinned": pinned,
            "newest": newest,
            "behind": _vkey(newest) > _vkey(pinned),
            "missed_security": security_releases_after(releases, line, pinned),
            "end_of_life": end_of_life(schedule, line).isoformat(),
            "days_left": days,
            "end_soon": 0 <= days <= END_SOON_DAYS,
            "ended": days < 0,
        }
    new_lines = newer_lts_lines(schedule, today)
    ended = any(entry["ended"] for entry in lines.values())
    repin = any(entry["behind"] for entry in lines.values()) and not ended
    newest = sorted((entry["newest"] for entry in lines.values()), key=_vkey, reverse=True)
    return {
        "today": today.isoformat(),
        # final review M1: an ACTION is what a release must settle (a newer patch to pin, a line that ended); a NOTICE
        # is for the maintainer to read (a new LTS line, a line that ends within 90 days) and never holds a release
        "action": repin or ended,
        "notice": bool(new_lines) or any(entry["end_soon"] for entry in lines.values()),
        "repin": repin,
        "branch": "chore/node-pin-" + "-".join(newest),
        "lines": lines,
        "new_lines": new_lines,
    }


def check_exit_code(report: dict) -> int:
    """--check: 0 nothing to do, 2 an action (the release gate), 3 notices only, 1 an error (main)."""
    if report["action"]:
        return 2
    return 3 if report["notice"] else 0


_LINE_OVERRIDE = re.compile(r"(\d+)=(\S+)")


def parse_lines(items: list[str]) -> dict[str, str]:
    """``--line LINE=vX.Y.Z`` items; anything else is refused before the network (final review M6)."""
    overrides = {}
    for item in items:
        match = _LINE_OVERRIDE.fullmatch(item)
        if match is None:
            raise PinError(f"--line takes LINE=vX.Y.Z, got {item!r}")
        overrides[match.group(1)] = match.group(2)
    return overrides


def signed_shasums(version: str, gpg: str) -> str:
    with _open(f"{DIST}/{version}/SHASUMS256.txt.asc") as resp:
        signed = resp.read()
    return verify_shasums(signed, KEYS.read_bytes(), gpg)


def build_manifest(plan: dict[str, dict], shasums: dict[str, str], today: date, size=_size) -> dict:
    platforms = {}
    for line, pinned in plan.items():
        version = pinned["version"]
        for key, (name, sha256) in artifacts_from_shasums(shasums[version], version, LINES[line]).items():
            url = f"{DIST}/{version}/{name}"
            platforms[key] = {"line": line, "url": url, "sha256": sha256, "bytes": size(url)}
            print(f"{key}: Node {version}, {platforms[key]['bytes']} bytes {sha256}")
    return {
        "product": "node",
        "source": "nodejs.org/dist",
        "pinned_at": today.isoformat(),
        "lines": plan,
        "platforms": platforms,
    }


def render_fixtures(node: Path, workdir: Path) -> dict[str, dict[str, str]]:
    """{fixture: {object id: sha256}} of the probe's fixtures rendered with ``node``."""
    report = workdir / "probe.json"
    # the probe exits 1 when the golden is not comparable -- expected for a version not proven yet; the report says
    subprocess.run(
        [
            sys.executable,
            "-m",
            "backend.app.part_render_probe",
            "render",
            "--node",
            str(node),
            "--out",
            str(workdir / "png"),
            "--report",
            str(report),
        ],
        cwd=ROOT,
        capture_output=True,
    )
    if not report.is_file():
        raise PinError(f"the probe wrote no report with {node}")
    results = json.loads(report.read_text(encoding="utf-8"))["render"]
    failed = sorted(fixture for fixture, result in results.items() if not result["ok"])
    if failed:
        raise PinError(f"the fixtures did not render with {node}: {', '.join(failed)}")
    return {fixture: result["sha256"] for fixture, result in results.items()}


def agreed_golden(hashes: dict[str, dict], existing: dict | None, renderer: int) -> dict:
    """Spec D5: one set of PNGs for every pinned version, or no pin."""
    versions = sorted(hashes, key=_vkey)
    if len({json.dumps(hashes[v], sort_keys=True) for v in versions}) != 1:
        raise PinError(
            f"Node {' and '.join(versions)} render different pixels for the same file: a RENDERER_VERSION "
            "decision (parent spec §8.5), not a pin"
        )
    png = hashes[versions[0]]
    if existing and existing.get("renderer") == renderer:
        # only a fixture object present in both may not change; a fixture added since is no pixel change (review M2)
        old = existing.get("png_sha256") or {}
        changed = sorted(
            f"{fixture} {obj}"
            for fixture, objects in png.items()
            for obj, sha in objects.items()
            if old.get(fixture, {}).get(obj) not in (None, sha)
        )
        if changed:
            raise PinError(
                f"the pinned Node renders other pixels than the golden of renderer {renderer} ({', '.join(changed)}): "
                "a RENDERER_VERSION decision (parent spec §8.5), not a pin"
            )
    return {"renderer": renderer, "node": versions, "png_sha256": png}


def prove_golden(manifest: dict, shasums: dict[str, str], host: str, workdir: Path) -> dict:
    """Spec D5: every pinned version renders the fixtures on THIS machine -- the official build of that version
    for this platform, hashed from the same signed SHASUMS256.txt -- and the golden comes only from agreement."""
    hashes = {}
    for line, pinned in manifest["lines"].items():
        version = pinned["version"]
        name, sha256 = artifacts_from_shasums(shasums[version], version, (host,))[host]
        url = f"{DIST}/{version}/{name}"
        proof = {
            "lines": {line: {"version": version}},
            "platforms": {host: {"line": line, "url": url, "sha256": sha256, "bytes": _size(url)}},
        }
        root = workdir / version
        provision(root, manifest=proof, platform=host)
        found = locate_in(root, platform=host)
        if found is None:
            raise PinError(f"Node {version} was provisioned for {host}, but no executable is there")
        hashes[version] = render_fixtures(found.executable, root)
        print(f"proved Node {version} on {host}")
    existing = json.loads(GOLDEN.read_text(encoding="utf-8")) if GOLDEN.exists() else None
    return agreed_golden(hashes, existing, RENDERER_VERSION)


def verify_manifest(manifest: dict, shasums: dict[str, str], *, expected: dict | None = None) -> None:
    """Every platform of PLATFORMS is pinned on the line LINES puts it on, to the official archive of that line's
    version in its signed SHASUMS256.txt (final review I1: the job that pushes a pin re-checks, with gpg and the
    stdlib only, what the job that made it -- the one that ran third-party packages -- wrote). With ``expected`` (the
    --check report of a job that ran none) every line must be the version the check chose: an older signed release
    is just as official, and a downgrade is never pushed (security review)."""
    if expected is not None:
        for line, pinned in sorted(manifest["lines"].items()):
            chose = (expected.get("lines", {}).get(line) or {}).get("newest")
            if pinned.get("version") != chose:
                raise PinError(f"line {line}: pinned {pinned.get('version')}, the check chose {chose}")
    missing = sorted(set(PLATFORMS) - set(manifest["platforms"]))
    if missing:
        raise PinError(f"the manifest pins no build for {', '.join(missing)}")
    for key, entry in sorted(manifest["platforms"].items()):
        line = entry.get("line")
        if key not in LINES.get(line, ()):
            raise PinError(f"{key}: pinned on line {line}, but LINES puts it on another line")
        version = pinned_version(manifest, key)
        name, sha256 = artifacts_from_shasums(shasums[version], version, (key,))[key]
        if entry.get("url") != f"{DIST}/{version}/{name}" or entry.get("sha256") != sha256:
            raise PinError(f"{key}: the manifest's archive is not the official {name} of the signed SHASUMS256.txt")


def verify_golden(golden: dict, manifest: dict, *, base: dict | None) -> None:
    """The golden a pin job wrote is this renderer's, names exactly the manifest's versions and -- against the base
    branch's golden -- changes no pixel of a fixture both hold (spec D5; security review: the push job re-checks)."""
    if golden.get("renderer") != RENDERER_VERSION:
        raise PinError(f"the golden is renderer {golden.get('renderer')}'s, this is renderer {RENDERER_VERSION}")
    versions = sorted({pinned["version"] for pinned in manifest["lines"].values()}, key=_vkey)
    if golden.get("node") != versions:
        raise PinError(f"the golden names {golden.get('node')}, the manifest pins {versions}")
    if base is not None:
        agreed_golden({versions[-1]: golden.get("png_sha256") or {}}, base, RENDERER_VERSION)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--check", action="store_true", help="report the pin as JSON; exit 0 nothing, 2 action, 3 notices, 1 error"
    )
    mode.add_argument("--golden", action="store_true", help="prove and write the golden for the current pin only")
    mode.add_argument("--verify", action="store_true", help="check the manifest against the signed SHASUMS only")
    parser.add_argument("--line", action="append", default=[], metavar="LINE=vX.Y.Z", help="pin this patch of a line")
    parser.add_argument("--expect", type=Path, help="--verify: the --check report whose versions the pin must be")
    parser.add_argument("--base-golden", type=Path, help="--verify: the base branch's golden the pixels must keep")
    args = parser.parse_args(argv)
    if args.line and (args.check or args.golden or args.verify):
        parser.error("--line pins a version; it does not combine with --check, --golden or --verify")
    if (args.expect or args.base_golden) and not args.verify:
        parser.error("--expect and --base-golden belong to --verify")
    today = date.today()
    try:
        overrides = parse_lines(args.line)
        if args.verify:
            gpg = shutil.which("gpg")
            if gpg is None:
                print("gpg is required: the pin is checked only against a signed SHASUMS256.txt.asc", file=sys.stderr)
                return 1
            manifest = load_manifest()
            versions = sorted({pin["version"] for pin in manifest["lines"].values()}, key=_vkey)
            expected = json.loads(args.expect.read_text(encoding="utf-8")) if args.expect else None
            shasums = {version: signed_shasums(version, gpg) for version in versions}
            verify_manifest(manifest, shasums, expected=expected)
            base = json.loads(args.base_golden.read_text(encoding="utf-8")) if args.base_golden else None
            verify_golden(json.loads(GOLDEN.read_text(encoding="utf-8")), manifest, base=base)
            print(f"manifest and golden verified against the signed SHASUMS256.txt of {', '.join(versions)}")
            return 0
        releases, schedule = fetch_json(f"{DIST}/index.json"), fetch_json(SCHEDULE)
        if args.check:
            report = check(load_manifest(), releases, schedule, today)
            print(json.dumps(report, indent=2))
            return check_exit_code(report)
        gpg = shutil.which("gpg")
        if gpg is None:
            print("gpg is required: the pin is taken only from a signed SHASUMS256.txt.asc", file=sys.stderr)
            return 1
        if args.golden:
            manifest = load_manifest()
            shasums = {p["version"]: signed_shasums(p["version"], gpg) for p in manifest["lines"].values()}
        else:
            plan = plan_versions(releases, schedule, today, overrides)
            shasums = {pinned["version"]: signed_shasums(pinned["version"], gpg) for pinned in plan.values()}
            manifest = build_manifest(plan, shasums, today)
        # Spec D5: the golden is proven on every pinned version BEFORE anything is written -- a version that renders
        # other pixels leaves the manifest and the golden as they were.
        host = platform_key()
        with tempfile.TemporaryDirectory(prefix="node-pin-proof-", ignore_cleanup_errors=True) as tmp:
            golden = prove_golden(manifest, shasums, host, Path(tmp))
        if not args.golden:
            MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
            print(f"pinned {', '.join(f'{line}: {p["version"]}' for line, p in manifest['lines'].items())}")
        GOLDEN.write_text(json.dumps(golden, indent=2) + "\n", encoding="utf-8", newline="\n")
        target = provision(ROOT / "runtime", manifest=manifest)  # this machine's own pin, for the dev instance
        print(f"golden proved on {', '.join(golden['node'])}; provisioned {target}")
    except (PinError, ProvisionError, OSError, ValueError) as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
