"""WS-13 E3 acceptance evidence (spec §I1/I2) — a sidecar, loopback only, stdlib only.

    python scripts/workshop_stand/e03_evidence.py pairs
    python scripts/workshop_stand/e03_evidence.py serve [name]

The universal E0 runner (``capture_serve.py`` + ``capture.js``) is used as it is and
never extended, and the accepted E2 evidence is not re-shot:

``pairs``  the E0 recipes of the order detail — ``order-detail`` (all widths),
           ``order-detail-line-expanded`` (wide), ``orders-workspace`` (all widths) —
           mockup beside app, for the owner's checkpoint (spec F6). Stage
           ``e03-order-detail-pairs``; the E0 plan is read as it is.
``serve``  the job for ``e03_detail.js`` on 127.0.0.1:8197: the stand's app token, the
           dev-server and backend bases, the mapped ids of the orders and the customer
           the recipes name; it collects one record per scenario and writes
           ``temp/ws13/evidence/e03-order-detail/<name>.json`` — app HEAD and dirty paths,
           the mockup HTML hash, the stand instance, and per record the spec IDs, the
           recipe, viewport / DPR / actual theme classes, the measurements and
           interaction results, pass / fail / pending and the SHA-256 of every picture.
The token reaches the browser only; nothing here prints it.
"""

from __future__ import annotations

import hashlib
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import capture_serve  # noqa: E402
import e02_evidence  # noqa: E402
import stand  # noqa: E402

PORT = 8197
STAGE = "e03-order-detail"
PAIR_RECIPES = ("order-detail", "order-detail-line-expanded", "orders-workspace")
# The mockup orders the recipes stand on (spec §I1): the mixed active order, the close
# banner, a completed and a cancelled one, a manual stage, and the customerless one.
ORDERS = ("241", "244", "245", "247", "250", "251")


def job_entities(mapping: dict) -> dict:
    """The stand's ids of the mockup entities the runner opens, by mockup number."""
    return {
        "orders": {number: mapping[f"order:{number}"]["id"] for number in ORDERS},
        "customer": mapping["customer:1"]["id"],
    }


def pairs() -> None:
    sys.argv = ["capture_serve.py", "--mode", "baseline", "--stage", f"{STAGE}-pairs", "--only", ",".join(PAIR_RECIPES)]
    capture_serve.main()


def header(manifest: dict) -> dict:
    return {
        "stage": STAGE,
        "app_head": e02_evidence.git("rev-parse", "HEAD").strip(),
        "dirty_paths": [line[3:] for line in e02_evidence.git("status", "--porcelain").splitlines() if line.strip()],
        "mockup_sha256": hashlib.sha256(capture_serve.MOCKUP.read_bytes()).hexdigest(),
        "stand": {k: manifest.get(k) for k in ("instance_id", "mode", "anchor", "delta_days")},
    }


def serve(name: str = "detail") -> None:
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
        serve(*sys.argv[2:3])
    else:
        {"pairs": pairs}[sys.argv[1]]()
