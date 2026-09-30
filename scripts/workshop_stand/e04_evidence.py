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
# Every scenario of the detail runner (e04_detail.js), in its order. A full run is complete only
# when each of them has exactly one record; the runner reports what it declares, and a unit test
# holds the two together.
DETAIL_SCENARIOS = (
    "geometry@2560",
    "geometry@1920",
    "geometry@1440",
    "geometry@1280",
    "geometry@1024",
    "geometry@768",
    "geometry@390",
    "lines-menu@1440",
    "lines-reader@1440",
    "lines-delete-confirm@1440",
    "parts-241@1440",
    "parts-241@390",
    "parts-244@1440",
    "parts-244@390",
    "edit-product@1440",
    "edit-product@390",
    "edit-moved-inactive@1440",
    "edit-refusal@1440",
    "edit-sources-cold@1440",
    "edit-sources-failed@1440",
    "edit-to-config@1440",
    "config-gate@1440",
    "plan-stepper-split@1440",
    "plan-proposal-editor@1440",
    "plan-proposal-reader@1440",
    "plan-printer@1440",
    "plan-printer-loading@1440",
    "plan-printer-failed@1440",
    "plan-printer-gone@1440",
    "plan-unsatisfiable@1440",
    "prints-page@1440",
    "prints-failed@1440",
    "prints-partial@1440",
    "prints-rights@1440",
    "prints-printers-500@1440",
    "prints-clamp@1440",
    "prints-move@1440",
    "prints-assign-dialog@1440",
    "prints-defects-dialog@1440",
    "prints-unlink-confirm@1440",
    "prints-390",
    "prints-pane-1024",
    "procurement@1440",
    "issues-empty@1440",
    "notes@1440",
    "notes-empty@1440",
    "attachments@1440",
    "attachments-late@1440",
    "hits@390",
    "theme-light@1440",
    "theme-oled@1440",
    "E12-plan-dialog@1440",
    "E12-plan-dialog@390",
)


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


def keep_record(record: dict, token: str) -> dict:
    """What the manifest keeps of a runner record: a record that carries the stand's token is
    replaced by a failure saying so — the runner scrubs its own, this is the last guard."""
    if token and token in json.dumps(record, ensure_ascii=False):
        return {
            "id": record.get("id"),
            "ids": record.get("ids", []),
            "pass": False,
            "error": {"code": "secret_in_record", "stage": "serve"},
        }
    return record


def run_completeness(
    *, finished: bool, done: dict, records: list[dict], only: str, expected: tuple[str, ...] = DETAIL_SCENARIOS
) -> dict:
    """Whether the manifest holds the WHOLE run — a set, apart from whether its scenarios passed.

    The runner says how many records the server accepted and which scenarios it has; a lost or
    doubled record, a filtered run and a runner that stopped early are each named."""
    problems: list[str] = []
    ids = [r.get("id") for r in records]
    if not finished:
        problems.append("no_done")
    if done.get("incomplete") is not False:
        problems.append("runner_incomplete")
    if done.get("count") != len(records):
        problems.append("count_mismatch")
    if len(set(ids)) != len(ids):
        problems.append("duplicate_ids")
    if only:
        problems.append("partial_filter")
    if list(done.get("declared") or []) != list(expected):
        problems.append("declared_mismatch")
    missing = sorted(set(expected) - set(ids))
    unexpected = sorted({str(i) for i in ids} - set(expected))
    if missing:
        problems.append("missing_ids")
    if unexpected:
        problems.append("unexpected_ids")
    return {"complete": not problems, "problems": problems, "missing": missing, "unexpected": unexpected}


def job_handler(job: dict, records: list[dict], done: dict, finished: threading.Event) -> type:
    """The runner's job server: `/job.json` out, `/record` and `/done` in. A record that is not a
    JSON object with an id is refused (400) — the runner counts only what was accepted — and
    `/done` ends the wait whatever it carried, so the verdict judges what it said."""

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
            if self.path not in ("/record", "/done"):
                self.send_error(404)
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            except ValueError:
                body = None
            if self.path == "/record":
                if not isinstance(body, dict) or not isinstance(body.get("id"), str):
                    self.send_error(400)
                    return
                records.append(keep_record(body, job["token"]))
                self._send(b"{}")
                return
            try:
                if isinstance(body, dict):
                    done.update(body)
                    self._send(b"{}")
                else:
                    self.send_error(400)
            finally:
                finished.set()

        def log_message(self, *args):
            pass

    return Handler


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
    done: dict = {}
    finished = threading.Event()

    stand.require_free_port(PORT)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), job_handler(job, records, done, finished))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(json.dumps({"serving": f"http://127.0.0.1:{PORT}"}), flush=True)
    finished.wait(timeout=2 * 3600)
    httpd.shutdown()
    out = out_dir / f"{name}.json"
    rows = [e02_evidence.with_hashes(r) for r in records]
    verdict = run_completeness(finished=finished.is_set(), done=done, records=records, only=only)
    out.write_text(
        json.dumps(
            {**head, "complete": verdict["complete"], "completeness": verdict, "records": rows},
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    not_passed = [r["id"] for r in rows if r.get("pass") is not True]
    print(
        json.dumps(
            {
                "manifest": str(out),
                "complete": verdict["complete"],
                "problems": verdict["problems"],
                "records": len(rows),
                "not_passed": not_passed,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


if __name__ == "__main__":
    if sys.argv[1] == "serve":
        serve(*sys.argv[2:4])
    else:
        {"pairs": pairs}[sys.argv[1]]()
