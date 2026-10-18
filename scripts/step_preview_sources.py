"""The corresponding source of the STEP-preview CAD component's copyleft parts, as one release asset.

  python scripts/step_preview_sources.py plan               what the bundle will hold, from the notices alone
  python scripts/step_preview_sources.py collect --out DIR  fetch, verify and pack it: DIR/<bundle> + <bundle>.sha256

The Docker image and the Windows installer carry the component; the parts of it under a licence that asks for their
source (decided by the licence BamDude distributes each under: its chosen ``terms``, else its ``licence``) get that
source from BamDude itself, attached to every release (.github/workflows/step-preview-sources.yml), and the notices
that ship with the component say where it is. Each source is taken by an identity the notices pin — a source RPM or
archive by its SHA-256, a git tree by its commit, archived with ``git archive`` — and any other bytes are refused;
nothing is packed until every source holds. The same sources make the same bundle, byte for byte."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "backend" / "app" / "data"
NOTICES = DATA / "step_runtime_notices.json"
README = DATA / "step_runtime_notices" / "README.txt"
# A licence that asks for the source of what is distributed (weak copyleft included). FTL, BSD, MIT and the like do not.
COPYLEFT = re.compile(r"\b(L?GPL|MPL|CDDL|FreeImage)\b")
USER_AGENT = "bamdude-step-preview-sources (+https://github.com/kainpl/bamdude)"
FETCH_SECONDS = 600
GIT_SECONDS = 1800
CARRIED = ("url", "ref", "commit", "name", "vendor", "signed_by")


class SourceError(RuntimeError):
    """A source the bundle cannot honestly carry: no pinned identity, or bytes other than the pinned ones."""


def load_notices() -> dict:
    return json.loads(NOTICES.read_text(encoding="utf-8"))


def is_copyleft(component: dict) -> bool:
    return bool(COPYLEFT.search(component.get("terms") or component["licence"]))


def bundle_name(notices: dict) -> str:
    """Named by the closure the notices were made for: a repin that changes the closure names a new bundle."""
    return f"bamdude-step-preview-sources-{notices['closure_sha256'][:12]}.tar"


def _file_name(component_id: str, source: dict) -> str:
    if source["kind"] == "srpm":
        return source["name"]
    if source["kind"] == "git":
        return f"{component_id}-{source['ref']}-{source['commit'][:12]}.tar.gz"
    base = source["url"].rsplit("/", 1)[-1]
    return base if base.casefold().startswith(component_id.casefold()) else f"{component_id}-{base}"


def _identity(source: dict) -> tuple | None:
    if source["kind"] == "git":
        if source.get("url") and re.fullmatch(r"[0-9a-f]{40}", source.get("commit", "")):
            return ("git", source["url"], source["commit"])
        return None
    if source["kind"] in ("srpm", "archive"):
        url = str(source.get("url", ""))
        if url.startswith(("https://", "http://")) and re.fullmatch(r"[0-9a-f]{64}", source.get("sha256", "")):
            return (source["kind"], source["sha256"])
    return None


def plan(notices: dict) -> list[dict]:
    """Every copyleft part's source, once however many families it serves; refused unless each one is pinned."""
    found: dict[tuple, dict] = {}
    vague = []
    for family, body in notices["families"].items():
        for component in body["components"]:
            if not is_copyleft(component):
                continue
            who = f"{family}:{component['id']}"
            source = component["source"]
            key = _identity(source)
            if key is None:
                vague.append(who)
                continue
            entry = found.setdefault(
                key,
                {
                    "kind": source["kind"],
                    **{k: source[k] for k in (*CARRIED, "sha256") if k in source},
                    "file": _file_name(component["id"], source),
                    "licence": component.get("terms") or component["licence"],
                    "serves": [],
                },
            )
            entry["serves"].append(who)
    if vague:
        raise SourceError("no verifiable source for: " + ", ".join(vague))
    files = [entry["file"] for entry in found.values()]
    if len(set(files)) != len(files):
        raise SourceError(f"two sources would share a file name: {sorted(files)}")
    return sorted(found.values(), key=lambda entry: entry["file"])


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _fetch(url: str, dest: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=FETCH_SECONDS) as response, dest.open("wb") as out:
        shutil.copyfileobj(response, out, 1 << 20)


def _archive_git(url: str, commit: str, prefix: str, dest: Path) -> None:
    """The tree of exactly that commit (git checks every object against its hash), gzipped without a time."""
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo.git"
        subprocess.run(["git", "init", "-q", "--bare", str(repo)], check=True)
        subprocess.run(
            ["git", "-C", str(repo), "fetch", "-q", "--depth", "1", url, commit], check=True, timeout=GIT_SECONDS
        )
        got = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "--verify", f"{commit}^{{commit}}"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        if got != commit:
            raise SourceError(f"{url} answered {got or 'nothing'} for commit {commit}")
        plain = Path(tmp) / "tree.tar"
        subprocess.run(
            ["git", "-C", str(repo), "archive", "--format=tar", f"--prefix={prefix}/", f"--output={plain}", commit],
            check=True,
            timeout=GIT_SECONDS,
        )
        with (
            plain.open("rb") as src,
            dest.open("wb") as raw,
            gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as out,
        ):
            shutil.copyfileobj(src, out, 1 << 20)


def _pack(root: Path, names: list[str], dest: Path) -> None:
    with tarfile.open(dest, "w", format=tarfile.USTAR_FORMAT) as tar:
        for name in sorted(names):
            path = root / name
            info = tarfile.TarInfo(name)
            info.size = path.stat().st_size
            info.mtime = 0
            info.mode = 0o644
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            with path.open("rb") as stream:
                tar.addfile(info, stream)


def collect(notices: dict, out: Path, *, fetch=_fetch, archive_git=_archive_git) -> Path:
    """Fetch and verify every source, then pack the bundle; on any refusal nothing is written to ``out``."""
    entries = plan(notices)
    out = Path(out)
    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp)
        (stage / "sources").mkdir()
        manifest = []
        for entry in entries:
            dest = stage / "sources" / entry["file"]
            if entry["kind"] == "git":
                archive_git(entry["url"], entry["commit"], entry["file"].removesuffix(".tar.gz"), dest)
            else:
                fetch(entry["url"], dest)
            digest = _sha256(dest)
            if entry["kind"] != "git" and digest != entry["sha256"]:
                raise SourceError(f"{entry['file']}: SHA-256 {digest}, the notices pin {entry['sha256']}")
            manifest.append(
                {
                    **{k: entry[k] for k in ("kind", *CARRIED, "licence") if k in entry},
                    "file": entry["file"],
                    "sha256": digest,
                    "serves": sorted(entry["serves"]),
                }
            )
        document = {
            "schema": 1,
            "component": notices["component"],
            "closure_sha256": notices["closure_sha256"],
            "sources": manifest,
        }
        (stage / "SOURCES.json").write_text(json.dumps(document, indent=1, sort_keys=True) + "\n", encoding="utf-8")
        shutil.copyfile(README, stage / "README.txt")
        out.mkdir(parents=True, exist_ok=True)
        bundle = out / bundle_name(notices)
        partial = out / f"{bundle.name}.part"
        _pack(stage, ["README.txt", "SOURCES.json", *(f"sources/{m['file']}" for m in manifest)], partial)
        partial.replace(bundle)
    (out / f"{bundle.name}.sha256").write_text(f"{_sha256(bundle)}  {bundle.name}\n", encoding="ascii")
    return bundle


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="step_preview_sources.py")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("plan")
    collecting = commands.add_parser("collect")
    collecting.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    notices = load_notices()
    try:
        if args.command == "plan":
            print(json.dumps({"bundle": bundle_name(notices), "sources": plan(notices)}, indent=1, sort_keys=True))
            return 0
        bundle = collect(notices, args.out)
    except SourceError as exc:
        print(f"sources: FAILED: {exc}", file=sys.stderr)
        return 1
    print(f"sources: {bundle.name}, {bundle.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
