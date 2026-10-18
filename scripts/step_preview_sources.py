"""The corresponding source of the STEP-preview CAD component's copyleft parts, as one release asset.

  python scripts/step_preview_sources.py plan                 what the bundle will hold, from the notices alone
  python scripts/step_preview_sources.py collect --out DIR    fetch, verify and pack it: DIR/<bundle> + <bundle>.sha256
  python scripts/step_preview_sources.py verify-release --repo OWNER/NAME --tag vX --wait SECONDS
                                                              wait for this closure's bundle on that release, verify it

The Docker image and the Windows installer carry the component; the parts of it under a licence that asks for their
source (decided by the licence BamDude distributes each under: its chosen ``terms``, else its ``licence``) get that
source from BamDude itself, attached to every release (.github/workflows/step-preview-sources.yml), and the notices
that ship with the component say where it is. Complete source is the upstream code AND what controlled its build:

  - a vendor's source RPM carries both (source, spec, patches);
  - a conda-forge build adds the recipe of its exact package — meta.yaml or recipe.yaml, the build scripts, every
    patch they name and the licences — read out of that package, taken by its pinned SHA-256 (``packages``);
  - a part a build system compiled itself adds that build system's tree at its pinned commit (``built_by``).

Each source is taken by an identity the notices pin — a source RPM, archive or conda package by its SHA-256, a git
tree by its commit, archived with ``git archive`` — and any other bytes are refused; a recipe without its recipe file
or without a patch its build names is refused too. Nothing is packed until every source holds, and the same sources
make the same bundle, byte for byte. ``verify-release`` is what the publishers of the image and the installer wait
for: this closure's bundle on the tag's published release, uploaded, every source in it as pinned."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "backend" / "app" / "data"
NOTICES = DATA / "step_runtime_notices.json"
README = DATA / "step_runtime_notices" / "README.txt"
# A licence that asks for the source of what is distributed (weak copyleft included). FTL, BSD, MIT and the like do not.
COPYLEFT = re.compile(r"\b(L?GPL|MPL|CDDL|FreeImage)\b")
CONDA = "https://conda.anaconda.org/conda-forge"
API = "https://api.github.com"
USER_AGENT = "bamdude-step-preview-sources (+https://github.com/kainpl/bamdude)"
FETCH_SECONDS = 600
GIT_SECONDS = 1800
RECIPE_FILES = ("meta.yaml", "recipe.yaml")
BUILD_SCRIPTS = (
    "meta.yaml",
    "recipe.yaml",
    "rendered_recipe.yaml",
    "bld.bat",
    "build.bat",
    "build.sh",
    "conda_build.sh",
)
PATCH = re.compile(r"[A-Za-z0-9_][\w.+-]*\.patch\b")
RECIPE_LIMIT = 64 * 1024 * 1024
CARRIED = ("url", "ref", "commit", "name", "vendor", "signed_by", "package", "package_sha256")


class SourceError(RuntimeError):
    """A source the bundle cannot honestly carry: no pinned identity, or bytes other than the pinned ones."""


def load_notices() -> dict:
    return json.loads(NOTICES.read_text(encoding="utf-8"))


def is_copyleft(component: dict) -> bool:
    return bool(COPYLEFT.search(component.get("terms") or component["licence"]))


def bundle_name(notices: dict) -> str:
    """Named by the closure the notices were made for: a repin that changes the closure names a new bundle."""
    return f"bamdude-step-preview-sources-{notices['closure_sha256'][:12]}.tar"


def _upstream_file(component_id: str, source: dict) -> str:
    if source["kind"] == "srpm":
        return source["name"]
    if source["kind"] == "git":
        return f"{component_id}-{source['ref']}-{source['commit'][:12]}.tar.gz"
    base = source["url"].rsplit("/", 1)[-1]
    return base if base.casefold().startswith(component_id.casefold()) else f"{component_id}-{base}"


def _pinned_git(url: str, commit: str) -> bool:
    return bool(url) and bool(re.fullmatch(r"[0-9a-f]{40}", commit or ""))


def _pinned_bytes(source: dict) -> bool:
    url = str(source.get("url", ""))
    return url.startswith(("https://", "http://")) and bool(re.fullmatch(r"[0-9a-f]{64}", source.get("sha256", "")))


def _upstream(family: str, component: dict) -> tuple[tuple, dict] | None:
    source = component["source"]
    if source["kind"] == "git" and _pinned_git(source.get("url", ""), source.get("commit", "")):
        key = ("git", source["url"], source["commit"])
    elif source["kind"] in ("srpm", "archive") and _pinned_bytes(source):
        key = (source["kind"], source["sha256"])
    else:
        return None
    entry = {
        "kind": source["kind"],
        "role": "upstream",
        **{k: source[k] for k in (*CARRIED, "sha256") if k in source},
        "file": _upstream_file(component["id"], source),
    }
    return key, entry


def _builds(family: str, component: dict) -> list[tuple[tuple, dict, str]] | None:
    """What controlled the part's build, beside its upstream: [] for a source RPM (it carries its spec and patches),
    None when nothing says how it was built."""
    if component["source"]["kind"] == "srpm":
        return []
    found = []
    for platform, package in sorted((component.get("packages") or {}).items()):
        if not re.fullmatch(r"[0-9a-f]{64}", package.get("sha256", "")) or "/" not in package.get("file", ""):
            return None
        subdir, name = package["file"].split("/", 1)
        entry = {
            "kind": "conda-recipe",
            "role": "build",
            "url": f"{CONDA}/{package['file']}",
            "package": package["file"],
            "package_sha256": package["sha256"],
            "file": f"{name.removesuffix('.conda')}-{subdir}-recipe.tar",
        }
        found.append((("conda-recipe", package["sha256"]), entry, f"@{platform}"))
    built = component.get("built_by")
    if built:
        if not _pinned_git(built.get("url", ""), built.get("commit", "")):
            return None
        repo = built["url"].rstrip("/").rsplit("/", 1)[-1]
        entry = {
            "kind": "git",
            "role": "build",
            "url": built["url"],
            "commit": built["commit"],
            "file": f"{repo}-{built['commit'][:12]}.tar.gz",
        }
        found.append((("git", built["url"], built["commit"]), entry, ""))
    return found or None


def plan(notices: dict) -> list[dict]:
    """Every copyleft part's upstream and build sources, each once however many parts it serves; refused unless
    each one is pinned and every part says how it was built."""
    found: dict[tuple, dict] = {}
    vague = []
    for family, body in notices["families"].items():
        for component in body["components"]:
            if not is_copyleft(component):
                continue
            who = f"{family}:{component['id']}"
            upstream, builds = _upstream(family, component), _builds(family, component)
            if upstream is None or builds is None:
                vague.append(who)
                continue
            licence = component.get("terms") or component["licence"]
            for key, entry, suffix in [(*upstream, ""), *builds]:
                found.setdefault(key, {**entry, "licence": licence, "serves": []})["serves"].append(who + suffix)
    if vague:
        raise SourceError("no verifiable upstream or no build record for: " + ", ".join(vague))
    files = [entry["file"] for entry in found.values()]
    if len(set(files)) != len(files):
        raise SourceError(f"two sources would share a file name: {sorted(files)}")
    return sorted(found.values(), key=lambda entry: entry["file"])


def _sha256_stream(stream) -> str:
    digest = hashlib.sha256()
    for block in iter(lambda: stream.read(1 << 20), b""):
        digest.update(block)
    return digest.hexdigest()


def _sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return _sha256_stream(stream)


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


def _zstd_decompress(data: bytes) -> bytes:
    try:
        from compression import zstd  # Python 3.14+
    except ImportError:
        zstd = None
    if zstd is not None:
        return zstd.decompress(data)
    if shutil.which("zstd"):
        return subprocess.run(["zstd", "-dc"], input=data, check=True, capture_output=True).stdout
    raise SourceError("reading a conda package needs Python 3.14 (compression.zstd) or the zstd tool")


def _conda_recipe(package: Path) -> dict[str, bytes]:
    """The recipe, the licences and the index of a .conda package — never its binaries."""
    with zipfile.ZipFile(package) as archive:
        infos = [n for n in archive.namelist() if n.startswith("info-") and n.endswith(".tar.zst")]
        if len(infos) != 1:
            raise SourceError(f"{package.name}: not one info archive in the package")
        data = _zstd_decompress(archive.read(infos[0]))
    found: dict[str, bytes] = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for member in tar.getmembers():
            name = member.name
            if not (name.startswith(("info/recipe/", "info/licenses/")) or name == "info/index.json"):
                continue
            if not member.isfile() or ".." in PurePosixPath(name).parts or name.startswith("/"):
                raise SourceError(f"{package.name}: {name!r} is not a plain file of the recipe")
            total += member.size
            if total > RECIPE_LIMIT:
                raise SourceError(f"{package.name}: the recipe is larger than {RECIPE_LIMIT} bytes")
            found[name] = tar.extractfile(member).read()
    return found


def _check_recipe(package: str, recipe: dict[str, bytes]) -> None:
    """The recipe file is there, and so is every patch the recipe or its build scripts apply."""
    names = {PurePosixPath(n).name: n for n in recipe if n.startswith("info/recipe/")}
    if not any(f"info/recipe/{f}" in recipe for f in RECIPE_FILES):
        raise SourceError(f"{package}: no meta.yaml or recipe.yaml in its recipe")
    for script in BUILD_SCRIPTS:
        text = recipe.get(f"info/recipe/{script}", b"").decode("utf-8", "replace")
        for patch in PATCH.findall(text):
            if patch not in names:
                raise SourceError(f"{package}: {script} applies {patch}, which its recipe does not carry")


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


def _pack_recipe(recipe: dict[str, bytes], dest: Path) -> list[dict]:
    with tempfile.TemporaryDirectory() as tmp:
        for name, data in recipe.items():
            path = Path(tmp) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        _pack(Path(tmp), list(recipe), dest)
    return [
        {"name": n, "sha256": hashlib.sha256(recipe[n]).hexdigest(), "size": len(recipe[n])} for n in sorted(recipe)
    ]


def collect(notices: dict, out: Path, *, fetch=_fetch, archive_git=_archive_git, read_recipe=_conda_recipe) -> Path:
    """Fetch and verify every source, then pack the bundle; on any refusal nothing is written to ``out``."""
    entries = plan(notices)
    out = Path(out)
    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp)
        (stage / "sources").mkdir()
        (stage / "packages").mkdir()
        manifest = []
        for entry in entries:
            dest = stage / "sources" / entry["file"]
            record = {k: entry[k] for k in ("kind", "role", *CARRIED, "licence") if k in entry}
            if entry["kind"] == "git":
                archive_git(entry["url"], entry["commit"], entry["file"].removesuffix(".tar.gz"), dest)
            elif entry["kind"] == "conda-recipe":
                package = stage / "packages" / entry["package"].replace("/", "-")
                fetch(entry["url"], package)
                if _sha256(package) != entry["package_sha256"]:
                    raise SourceError(f"{entry['package']}: not the package the notices pin")
                recipe = read_recipe(package)
                _check_recipe(entry["package"], recipe)
                record["members"] = _pack_recipe(recipe, dest)
            else:
                fetch(entry["url"], dest)
            digest = _sha256(dest)
            if entry["kind"] in ("srpm", "archive") and digest != entry["sha256"]:
                raise SourceError(f"{entry['file']}: SHA-256 {digest}, the notices pin {entry['sha256']}")
            manifest.append({**record, "file": entry["file"], "sha256": digest, "serves": sorted(entry["serves"])})
        document = {
            "schema": 2,
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


# --- what the publishers wait for --------------------------------------------------------------------------------


def published_bundle(release: dict | None, name: str) -> tuple[dict, dict] | None:
    """The bundle and its .sha256 on a PUBLISHED release, both fully uploaded; anything less is not there yet."""
    if not release or release.get("draft"):
        return None
    assets = {a["name"]: a for a in release.get("assets", []) if a.get("state") == "uploaded"}
    bundle, digest = assets.get(name), assets.get(f"{name}.sha256")
    return (bundle, digest) if bundle and digest else None


def verify_bundle(notices: dict, bundle: Path, digest_text: str, asset_digest: str | None = None) -> None:
    """The bundle is this closure's and complete: its bytes as its .sha256 (and GitHub's digest) say, its
    SOURCES.json for this closure, every planned source in it with its pinned identity and the bytes it names."""
    got = _sha256(bundle)
    words = digest_text.split()
    if not words or words[0] != got:
        raise SourceError(f"the bundle's SHA-256 is {got}, its .sha256 says {words[0] if words else 'nothing'}")
    if asset_digest and asset_digest != f"sha256:{got}":
        raise SourceError(f"the release asset's digest {asset_digest} is not its bytes")
    with tarfile.open(bundle) as tar:
        try:
            manifest = json.load(tar.extractfile("SOURCES.json"))
        except (KeyError, ValueError, AttributeError):
            raise SourceError("the bundle has no readable SOURCES.json") from None
        if manifest.get("closure_sha256") != notices["closure_sha256"]:
            raise SourceError("the bundle was made for another closure")
        listed = {item.get("file"): item for item in manifest.get("sources", [])}
        for entry in plan(notices):
            item = listed.get(entry["file"])
            if item is None:
                raise SourceError(f"the bundle lacks {entry['file']}")
            for key in ("sha256", "commit", "package_sha256"):
                if key in entry and not (key == "sha256" and entry["kind"] in ("git", "conda-recipe")):
                    if item.get(key) != entry[key]:
                        raise SourceError(f"{entry['file']}: {key} is not the pinned one")
            try:
                stream = tar.extractfile(f"sources/{entry['file']}")
            except KeyError:
                raise SourceError(f"the bundle lacks the bytes of {entry['file']}") from None
            if _sha256_stream(stream) != item.get("sha256"):
                raise SourceError(f"{entry['file']}: not the bytes its manifest names")


def _get_release(repo: str, tag: str, token: str | None) -> dict | None:
    request = urllib.request.Request(
        f"{API}/repos/{repo}/releases/tags/{tag}",
        headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"},
    )
    if token:
        request.add_unredirected_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None  # not created yet
        raise


def verify_release(
    notices: dict,
    repo: str,
    tag: str,
    *,
    wait: float,
    poll: float = 20.0,
    token: str | None = None,
    get_release=_get_release,
    download=_fetch,
    clock=time.monotonic,
    sleep=time.sleep,
) -> str:
    """Wait for this closure's bundle on the tag's published release, then verify it; returns its SHA-256."""
    name = bundle_name(notices)
    deadline = clock() + wait
    while True:
        found = published_bundle(get_release(repo, tag, token), name)
        if found:
            break
        if clock() >= deadline:
            raise SourceError(f"{tag} has no published, uploaded {name} with its .sha256 after {wait:.0f} s")
        sleep(poll)
    bundle_asset, digest_asset = found
    with tempfile.TemporaryDirectory() as tmp:
        bundle, digest = Path(tmp) / name, Path(tmp) / f"{name}.sha256"
        download(bundle_asset["browser_download_url"], bundle)
        download(digest_asset["browser_download_url"], digest)
        verify_bundle(notices, bundle, digest.read_text(encoding="ascii"), bundle_asset.get("digest"))
        return _sha256(bundle)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="step_preview_sources.py")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("plan")
    collecting = commands.add_parser("collect")
    collecting.add_argument("--out", type=Path, required=True)
    verifying = commands.add_parser("verify-release")
    verifying.add_argument("--repo", required=True)
    verifying.add_argument("--tag", required=True)
    verifying.add_argument("--wait", type=float, required=True)
    args = parser.parse_args(argv)
    notices = load_notices()
    try:
        if args.command == "plan":
            print(json.dumps({"bundle": bundle_name(notices), "sources": plan(notices)}, indent=1, sort_keys=True))
            return 0
        if args.command == "verify-release":
            token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
            digest = verify_release(notices, args.repo, args.tag, wait=args.wait, token=token)
            print(f"sources: {bundle_name(notices)} on {args.tag} verified ({digest})")
            return 0
        bundle = collect(notices, args.out)
    except SourceError as exc:
        print(f"sources: FAILED: {exc}", file=sys.stderr)
        return 1
    print(f"sources: {bundle.name}, {bundle.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
