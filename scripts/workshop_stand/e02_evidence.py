"""WS-13 E2 acceptance evidence (spec §H) — a sidecar, loopback only, stdlib only.

    python scripts/workshop_stand/e02_evidence.py pairs
    python scripts/workshop_stand/e02_evidence.py serve

The universal E0 runner (``capture_serve.py`` + ``capture.js``) is used as it is and
never extended:

``pairs``  the E0 recipes whose plan says ``widths: wide`` but whose surface E2 changed
           (``products-table``, ``customer-detail``) shot at the narrow width only — the
           same recipes, the same mapping, the unmodified runner, fed a copy of the plan
           in a temporary folder. Stage ``e02-primitives-390``; E0 evidence is untouched.
``serve``  the job for ``e02_primitives.js`` on 127.0.0.1:8197: the stand's app token,
           the dev-server base, the mapped entity ids; it collects one record per checked
           scenario and writes ``temp/ws13/evidence/e02-primitives/primitives.json`` —
           app HEAD and dirty paths, the mockup HTML hash, the stand instance, and per
           record the primitive IDs, source (``test-fixture`` / ``app``), recipe,
           viewport / DPR / actual theme classes, rects and computed styles, the
           interaction results, pass / fail and the SHA-256 of every picture.
The token reaches the browser only; nothing here prints it.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import capture_serve  # noqa: E402
import stand  # noqa: E402

PORT = 8197
STAGE = "e02-primitives"
NARROW_ONLY = ("products-table", "customer-detail")


def narrow_plan(plan: dict, recipes: tuple[str, ...] = NARROW_ONLY) -> dict:
    """The plan with no wide width and the named recipes widened to «all» — so the
    unmodified runner shoots exactly those recipes at the narrow width(s)."""
    out = json.loads(json.dumps(plan))
    out["widths"] = {"wide": [], "narrow": plan["widths"]["narrow"]}
    for surface in out["surfaces"]:
        if surface["id"] in recipes:
            surface["widths"] = "all"
    return out


def pairs() -> None:
    plan = json.loads((HERE / "capture_plan.json").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "capture_plan.json").write_text(json.dumps(narrow_plan(plan)), encoding="utf-8")
        capture_serve.HERE = Path(tmp)  # build_job reads the plan from HERE at call time
        sys.argv = [
            "capture_serve.py",
            "--mode",
            "baseline",
            "--stage",
            f"{STAGE}-390",
            "--only",
            ",".join(NARROW_ONLY),
        ]
        capture_serve.main()


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=stand.REPO, capture_output=True, text=True, check=True).stdout


def header(manifest: dict) -> dict:
    return {
        "stage": STAGE,
        "app_head": git("rev-parse", "HEAD").strip(),
        "dirty_paths": [line[3:] for line in git("status", "--porcelain").splitlines() if line.strip()],
        "mockup_sha256": hashlib.sha256(capture_serve.MOCKUP.read_bytes()).hexdigest(),
        "stand": {k: manifest.get(k) for k in ("instance_id", "mode", "anchor", "delta_days")},
    }


def with_hashes(record: dict) -> dict:
    """Every picture a record names gets its path relative to the repo and its SHA-256;
    a named picture that is not on disk is marked missing, never silently dropped."""
    shots = []
    for name in record.get("screenshots") or []:
        path = Path(name)
        shots.append(
            {
                "file": str(path.relative_to(stand.REPO)).replace("\\", "/") if path.exists() else name,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None,
            }
        )
    return {**record, "screenshots": shots}


def serve() -> None:
    root = stand.check_root(stand.expected_root("baseline"), mode="baseline")
    manifest = stand.read_manifest(root)
    mapping = json.loads((root / "mapping.json").read_text(encoding="utf-8"))
    client = stand.logged_in_client(root, manifest)
    out_dir = stand.REPO / "temp" / "ws13" / "evidence" / STAGE
    (out_dir / "primitives").mkdir(parents=True, exist_ok=True)
    job = {
        "token": client.token,
        "ui": f"http://127.0.0.1:{manifest['ports']['vite']}",
        "api": f"http://127.0.0.1:{manifest['ports']['backend']}",
        "out": str(out_dir / "primitives").replace("\\", "/"),
        "customer": mapping["customer:1"]["id"],
    }
    head = header(manifest)
    records: list[dict] = []
    finished = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, body: bytes) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path == "/job.json":
                self._send(json.dumps(job).encode())
            else:
                self.send_error(404)

        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/record":
                records.append(body)
                self._send(b"{}")
            elif self.path == "/done":
                self._send(b"{}")
                finished.set()
            else:
                self.send_error(404)

        def log_message(self, *args):
            pass

    stand.require_free_port(PORT)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(json.dumps({"serving": f"http://127.0.0.1:{PORT}"}), flush=True)
    finished.wait(timeout=2 * 3600)
    httpd.shutdown()
    out = out_dir / "primitives.json"
    rows = [with_hashes(r) for r in records]
    out.write_text(json.dumps({**head, "records": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    failed = [r["id"] for r in rows if r.get("pass") is not True]
    print(
        json.dumps({"manifest": str(out), "records": len(rows), "not_passed": failed}, ensure_ascii=False), flush=True
    )


if __name__ == "__main__":
    {"pairs": pairs, "serve": serve}[sys.argv[1]]()
