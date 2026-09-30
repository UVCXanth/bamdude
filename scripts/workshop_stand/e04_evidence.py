"""WS-13 E4 acceptance evidence (spec §I1/I2) — a sidecar, loopback only, stdlib only.

    python scripts/workshop_stand/e04_evidence.py pairs
    python scripts/workshop_stand/e04_evidence.py serve [name] [scenario-prefix,...]

The universal E0 runner (``capture_serve.py`` + ``capture.js``) is used as it is and
never extended:

``pairs``  mockup beside app for the owner's checkpoint (spec F6): the E0 recipes the
           E4 table changed (``order-detail`` at every width, ``order-detail-line-expanded``
           wide) and the E4 recipes of this sidecar, given to the runner as a COPY of the
           E0 plan with them added (the plan file itself is never edited). Stage
           ``e04-lines-plan-tabs-pairs``.
``serve``  the job for ``e04_detail.js`` on 127.0.0.1:8197: the stand's app token, the
           dev-server and backend bases, the mapped ids of the orders the recipes name;
           it collects one record per scenario and writes
           ``temp/ws13/evidence/e04-lines-plan-tabs/<name>.json`` — app HEAD and dirty
           paths, the mockup HTML hash, the stand instance, and per record the spec IDs,
           the recipe and its fixtures, viewport / DPR / actual theme classes, the
           measurements and interaction results, pass / fail / pending and the SHA-256
           of every picture.
The token reaches the browser only; nothing here prints it.
"""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import capture_serve  # noqa: E402
import e02_evidence  # noqa: E402
import stand  # noqa: E402

PORT = 8197
STAGE = "e04-lines-plan-tabs"
# The mockup orders the scenarios stand on (spec §I1): 241 (one configured line, 38 prints,
# purchased parts), 244 (two configurations of one product and a parts line), 245
# (completed), 248 (defects), 250 (cancelled).
ORDERS = ("241", "244", "245", "248", "250")
BASE_RECIPES = ("order-detail", "order-detail-line-expanded")


def job_entities(mapping: dict) -> dict:
    """The stand's ids of the mockup entities the runner opens, by mockup number."""
    return {"orders": {number: mapping[f"order:{number}"]["id"] for number in ORDERS}}


def e04_recipes() -> list[dict]:
    """The E4 pair recipes (spec §I1), in the E0 plan's own surface format — see
    ``capture_plan.json`` — kept in ``e04_pairs.json`` beside this sidecar."""
    return json.loads((HERE / "e04_pairs.json").read_text(encoding="utf-8"))


def pairs() -> None:
    plan = json.loads((HERE / "capture_plan.json").read_text(encoding="utf-8"))
    added = e04_recipes()
    plan = {**plan, "surfaces": [*plan["surfaces"], *added]}
    only = [*BASE_RECIPES, *(r["id"] for r in added)]
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "capture_plan.json").write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
        capture_serve.HERE = Path(tmp)  # build_job reads the plan from HERE at call time
        sys.argv = ["capture_serve.py", "--mode", "baseline", "--stage", f"{STAGE}-pairs", "--only", ",".join(only)]
        capture_serve.main()


def header(manifest: dict) -> dict:
    return {
        "stage": STAGE,
        "app_head": e02_evidence.git("rev-parse", "HEAD").strip(),
        "dirty_paths": [line[3:] for line in e02_evidence.git("status", "--porcelain").splitlines() if line.strip()],
        "mockup_sha256": hashlib.sha256(capture_serve.MOCKUP.read_bytes()).hexdigest(),
        "stand": {k: manifest.get(k) for k in ("instance_id", "mode", "anchor", "delta_days")},
    }


def serve(name: str = "detail", only: str = "") -> None:
    root = stand.check_root(stand.expected_root("baseline"), mode="baseline")
    manifest = stand.read_manifest(root)
    mapping = json.loads((root / "mapping.json").read_text(encoding="utf-8"))
    client = stand.logged_in_client(root, manifest)
    out_dir = stand.REPO / "temp" / "ws13" / "evidence" / STAGE
    (out_dir / "shots").mkdir(parents=True, exist_ok=True)
    job = {
        "token": client.token,
        "ui": f"http://127.0.0.1:{manifest['ports']['vite']}",
        "api": f"http://127.0.0.1:{manifest['ports']['backend']}",
        "out": str(out_dir / "shots").replace("\\", "/"),
        # A comma list of scenario-id prefixes: a partial run records only those.
        "only": only,
        **job_entities(mapping),
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
    out = out_dir / f"{name}.json"
    rows = [e02_evidence.with_hashes(r) for r in records]
    out.write_text(json.dumps({**head, "records": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    not_passed = [r["id"] for r in rows if r.get("pass") is not True]
    print(
        json.dumps({"manifest": str(out), "records": len(rows), "not_passed": not_passed}, ensure_ascii=False),
        flush=True,
    )


if __name__ == "__main__":
    if sys.argv[1] == "serve":
        serve(*sys.argv[2:4])
    else:
        {"pairs": pairs}[sys.argv[1]]()
