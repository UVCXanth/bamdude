"""Acceptance of an INSTALLED instance (spec part-thumbnails §15, plan E7 D3): the service renders KNOWN files
through its own API -- in its own process, environment, rights and hardening, which a probe run as a user is not.

What it accepts is stated before it runs (consilium E7-R1): an expectations file names, for every input file, the
printed parts its product must have and the render methods allowed (Node's ``toolpath`` unless a fallback is the
point). A file, a part or a picture short of that fails: every picture is decoded as a PNG of its method's size with
visible pixels, and every instance's method is read off the part's candidates. Every plate a part is on is waited
for -- not only the one its picture comes from -- and an answer that cannot change is not waited for (E7.2-R1).

With ``--install-root`` it first proves WHAT is accepted (E7-R2): the installation's Git revision is the intended
one, its pinned Node is the one under that installation's own ``runtime/`` (never one on PATH) at the pin's version,
its render bundle matches the bundle manifest, and this driver runs from that installation. The Node version there
is the one its ``VERSION`` file states; ``--measure`` runs THAT binary with THAT bundle and refuses a measurement
whose Node named itself otherwise, which is what proves the binary.

The admin made on the fresh instance gets a password that meets the setup policy (E7-R3) and lives in memory only;
neither it nor the token reaches the report or stdout.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import secrets
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

import httpx
from PIL import Image

from backend.app.services import render_runtime
from backend.app.services.part_render_protocol import MASTER_SIZE, RENDERER_VERSION

API = "/api/v1"
ATTEMPT = re.compile(r"Part render attempt=(?P<attempt>\S+) outcome=(?P<outcome>\S+) .*?elapsed_ms=(?P<elapsed>\d+)")
# The methods a part's picture comes from before any top_mask (part_images._PREFERRED; a test keeps them equal).
# Their master is MASTER_SIZE square, which part_renders checks at publish.
PREFERRED = ("toolpath", "model")
# The one plate status that changes by itself: ready / failed / unavailable are final (part_renders.mark_terminal),
# and "none" -- no render -- is final too once from-file has answered, the sync having queued its plates.
PENDING = "pending"


def make_client(base_url: str) -> httpx.Client:
    return httpx.Client(base_url=base_url, timeout=120)


def load_expectations(path: Path) -> list[dict]:
    """``{"files": [{"path", "parts": [names], "methods": [...]}]}`` -- nothing accepted that is not named."""
    entries = json.loads(path.read_text(encoding="utf-8")).get("files") or []
    if not entries:
        raise SystemExit("the expectations name no file: nothing would be accepted")
    out = []
    for entry in entries:
        parts = list(entry.get("parts") or [])
        if not parts:
            raise SystemExit(f"{entry.get('path')}: the expectations name no printed part")
        file = Path(entry["path"])
        out.append(
            {
                "path": file if file.is_absolute() else path.parent / file,
                "parts": parts,
                "methods": list(entry.get("methods") or ["toolpath"]),
            }
        )
    return out


def password() -> str:
    """The setup policy: 8+ characters, an upper- and a lowercase letter and a digit. The fixed head only
    guarantees the classes; the random tail carries the entropy (consilium E7-R3)."""
    return "Aa1" + secrets.token_urlsafe(24)


def wait_up(client: httpx.Client, *, timeout: float, sleep: Callable[[float], None], now: Callable[[], float]) -> None:
    deadline = now() + timeout
    while now() < deadline:
        try:
            if client.get(f"{API}/system/health").status_code < 500:
                return
        except httpx.TransportError:
            pass
        sleep(2.0)
    raise SystemExit("the instance never answered")


def sign_in(client: httpx.Client) -> dict[str, str]:
    """A fresh instance only: the admin is made here, and the password never leaves this function."""
    if not client.get(f"{API}/auth/status").json().get("requires_setup"):  # routes/auth.py::get_auth_status
        raise SystemExit("the instance is set up already: run the acceptance against a fresh one")
    secret = password()
    client.post(f"{API}/auth/setup", json={"admin_username": "acceptance", "admin_password": secret}).raise_for_status()
    r = client.post(f"{API}/auth/login", json={"username": "acceptance", "password": secret})
    r.raise_for_status()
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def worker(client: httpx.Client, auth: dict[str, str]) -> dict:
    return client.get(f"{API}/system/info", headers=auth).json().get("part_render_worker") or {}


def attempts(log: Path | None) -> list[dict]:
    if log is None or not log.exists():
        return []
    found = []
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        m = ATTEMPT.search(line)
        if m:
            found.append({"attempt": m["attempt"], "outcome": m["outcome"], "elapsed_ms": int(m["elapsed"])})
    return found


def picture_problem(content: bytes, drawn: set[str]) -> str | None:
    """None for a decoded PNG with a visible pixel at the size its method publishes; else why not.

    ``drawn`` is the methods of the part's finished instances. A toolpath / model master is MASTER_SIZE square, and
    the picture is one of those whenever an instance has one. A top_mask is cut from the plate's top image at that
    image's own resolution and never upscaled (E3), so any size up to a master is a real one (consilium E7.2-R2)."""
    try:
        with Image.open(io.BytesIO(content)) as img:
            img.load()
            if img.format != "PNG":
                return f"not a PNG ({img.format})"
            width, height = img.size
            if set(PREFERRED) & drawn or not drawn:
                if (width, height) != (MASTER_SIZE, MASTER_SIZE):
                    return f"{width}x{height}, not a {MASTER_SIZE}x{MASTER_SIZE} master"
            elif max(width, height) > MASTER_SIZE:
                return f"{width}x{height}, larger than a master"
            if img.convert("RGBA").getchannel("A").getbbox() is None:
                return "no visible pixel"
    except Exception as exc:  # noqa: BLE001 -- whatever it is, it is not a picture
        return f"not a picture ({type(exc).__name__})"
    return None


def instances(client: httpx.Client, auth: dict[str, str], part_id: int, file_id: int) -> list[dict]:
    """The part's instances on THIS file: every plate it is on, not only the one its picture comes from."""
    got = client.get(f"{API}/product-parts/{part_id}/image-candidates", headers=auth)
    got.raise_for_status()
    return [c for c in got.json() if c.get("library_file_id") == file_id]


def inventory(names: list[str], expected: list[str]) -> list[str]:
    problems = []
    if missing := sorted(set(expected) - set(names)):
        problems.append(f"missing parts: {missing}")
    if extra := sorted(set(names) - set(expected)):
        problems.append(f"unexpected parts: {extra}")
    if twice := sorted({n for n in names if names.count(n) > 1}):
        problems.append(f"parts twice: {twice}")
    return problems


def final_refusal(c: dict, allowed: list[str]) -> bool:
    """A finished instance that cannot pass: waiting longer changes nothing."""
    status = c.get("plate_status")
    return status != PENDING and (status != "ready" or c.get("method") not in allowed)


def one_file(client, auth, expectation: dict, *, timeout: float, poll: float, sleep, now) -> dict:
    path: Path = expectation["path"]
    allowed = expectation["methods"]
    started = now()
    with path.open("rb") as fh:
        up = client.post(
            f"{API}/library/files", headers=auth, files={"file": (path.name, fh, "application/octet-stream")}
        )
    up.raise_for_status()
    file_id = up.json()["id"]
    made = client.post(f"{API}/products/from-file/{file_id}", headers=auth)
    made.raise_for_status()
    body = made.json()
    product_id = body.get("product", body)["id"]
    deadline = started + timeout
    while True:
        parts = client.get(f"{API}/products/{product_id}", headers=auth).json()["parts"]
        printed = [p for p in parts if p.get("kind") == "printed"]
        here = {p["id"]: instances(client, auth, p["id"], file_id) for p in printed}
        every = [c for cs in here.values() for c in cs]
        # the part set and a finished instance are final; an empty product is "missing parts", not a wait
        refused = bool(inventory([p["name"] for p in printed], expectation["parts"])) or any(
            final_refusal(c, allowed) for c in every
        )
        # every plate of every part, never only the one the picture comes from (consilium E7.2-R1)
        waiting = any(c.get("plate_status") == PENDING for c in every) or any(
            (p.get("image") or {}).get("status") == PENDING for p in printed
        )
        if refused or not waiting or now() >= deadline:
            break
        sleep(poll)
    problems = inventory([p["name"] for p in printed], expectation["parts"])
    rows = []
    for p in printed:
        image, mine = p.get("image") or {}, here[p["id"]]
        drawn = {c.get("method") for c in mine if c.get("plate_status") == "ready"}
        row = {
            "name": p["name"],
            "status": image.get("status"),
            "image_kind": image.get("kind"),
            "methods": sorted(map(str, drawn)),
        }
        if image.get("status") != "ready":
            problems.append(f"{p['name']}: picture {image.get('status') or 'absent'}")
        else:
            r = client.get(
                f"{API}/product-parts/{p['id']}/image", params={"v": image.get("v"), "size": "lg"}, headers=auth
            )
            r.raise_for_status()
            row.update(bytes=len(r.content), sha256=hashlib.sha256(r.content).hexdigest())
            if bad := picture_problem(r.content, drawn):
                problems.append(f"{p['name']}: {bad}")
        if not mine:
            problems.append(f"{p['name']}: no instance on the file")
        for plate, status in sorted({(c.get("plate_index"), c.get("plate_status")) for c in mine}):
            if status != "ready":  # pending at the deadline, or a plate no picture will come from
                problems.append(f"{p['name']}: plate {plate}: {'no render queued' if status == 'none' else status}")
        if any(m not in allowed for m in drawn):
            problems.append(f"{p['name']}: methods {row['methods']}, expected {allowed}")
        rows.append(row)
    return {
        "file": path.name,
        "product_id": product_id,
        "seconds": round(now() - started, 1),
        "parts": rows,
        "problems": problems,
    }


def run(
    client: httpx.Client,
    expectations: list[dict],
    *,
    log: Path | None = None,
    timeout: float = 900.0,
    poll: float = 5.0,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
) -> dict:
    if not expectations:
        raise SystemExit("no file to accept")
    wait_up(client, timeout=timeout, sleep=sleep, now=now)
    auth = sign_in(client)
    results = [one_file(client, auth, e, timeout=timeout, poll=poll, sleep=sleep, now=now) for e in expectations]
    health = worker(client, auth)
    ok = health.get("state") == "ready" and all(not r["problems"] for r in results)
    return {"ok": ok, "worker": health, "files": results, "attempts": attempts(log)}


def provenance(install_root: Path, expected_sha: str, *, own_root: Path | None = None) -> dict:
    """The installation accepted is the revision intended, with ITS pinned Node and ITS bundle (consilium E7-R2)."""
    root = install_root.resolve()
    if (own_root or Path(__file__).resolve().parents[2]).resolve() != root:
        raise SystemExit("run the driver from the installation it accepts (its own source and venv)")
    head = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()
    if head != expected_sha:
        raise SystemExit(f"installed revision {head[:12]} is not the intended {expected_sha[:12]}")
    node = render_runtime.locate(root)  # <root>/runtime only -- a Node on PATH is never this installation's
    if node is None:
        raise SystemExit("the installation has no provisioned Node runtime")
    pin = render_runtime.load_manifest(root / "backend" / "app" / "data" / "render_runtime.json")["version"]
    if node.version != pin:
        raise SystemExit(f"installed Node {node.version} is not the pin {pin}")
    bundle_dir = root / "backend" / "app" / "data" / "part_render"
    manifest = json.loads((bundle_dir / "manifest.json").read_text(encoding="utf-8"))
    digest = hashlib.sha256((bundle_dir / manifest["file"]).read_bytes()).hexdigest()
    if digest != manifest["sha256"]:
        raise SystemExit("the installed render bundle does not match its manifest")
    return {
        "install_root": str(root),
        "sha": head,
        "node": {"executable": str(node.executable), "version": node.version, "platform": node.platform},
        "bundle_sha256": digest,
        "renderer": RENDERER_VERSION,
    }


def measure(install_root: Path, node: str, files: list[Path], out: Path, pin: str) -> dict:
    """Peak memory with the installation's own Node, run from its own source (the probe's ``measure``). The probe
    reports the version the binary itself names (``node --version``) -- the proof of the binary, which the
    ``VERSION`` file ``provenance`` reads is not."""
    subprocess.run(
        [
            sys.executable,
            "-m",
            "backend.app.part_render_probe",
            "measure",
            "--node",
            node,
            *(str(f) for f in files),
            "--report",
            str(out),
        ],
        cwd=install_root,
        check=True,
    )
    report = json.loads(out.read_text(encoding="utf-8"))
    nodes = {m.get("node") for m in report.get("measure", [])}
    if nodes != {pin}:
        raise SystemExit(f"measured on {sorted(map(str, nodes))}, not the pin {pin}")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--expect", type=Path, required=True)
    parser.add_argument("--install-root", type=Path)
    parser.add_argument("--expected-sha")
    parser.add_argument("--measure", action="append", type=Path, default=[])
    parser.add_argument("--log", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=900.0)
    parser.add_argument("--poll", type=float, default=5.0)
    args = parser.parse_args(argv)
    if args.install_root and not args.expected_sha:
        parser.error("--install-root needs --expected-sha")
    if args.measure and not args.install_root:
        parser.error("--measure needs --install-root: it measures that installation's own Node")
    expectations = load_expectations(args.expect)
    origin = provenance(args.install_root, args.expected_sha) if args.install_root else None
    with make_client(args.base_url) as client:
        report = run(client, expectations, log=args.log, timeout=args.timeout, poll=args.poll, sleep=time.sleep)
    if origin:
        report["provenance"] = origin
        if args.measure:
            out = args.report.with_name(args.report.stem + ".measure.json")
            report["measure"] = measure(
                args.install_root, origin["node"]["executable"], args.measure, out, origin["node"]["version"]
            )
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    ready = sum(1 for r in report["files"] for row in r["parts"] if row["status"] == "ready")
    print(
        f"acceptance: {'ok' if report['ok'] else 'FAILED'} -- {ready} pictures, worker {report['worker'].get('state')}"
    )
    for r in report["files"]:
        for problem in r["problems"]:
            print(f"  {r['file']}: {problem}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
