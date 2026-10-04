"""WS-13 E12 acceptance evidence (spec §L.1) — a sidecar, loopback only, stdlib only.

    python scripts/workshop_stand/e12_evidence.py pairs
    python scripts/workshop_stand/e12_evidence.py serve [name] [scenario-prefix,...]

E4's sidecar (``e04_evidence.py``) is reused as it is — its record guard, its completeness
verdict and its job server — and the universal E0 runner (``capture_serve.py`` +
``capture.js``) is never extended:

``pairs``  mockup beside app for the owner's checkpoint (spec F6), given to the runner as a
           COPY of the E0 plan (the plan file itself is never edited) with the eleven stock
           recipes of ``e12_pairs.json`` added (``e12-stock-pairs``): the four tabs, the
           position and the dispatch note, and the five dialogs.
``serve``  the job for ``e12_stock.js`` on 127.0.0.1:8197: the stand's app token, a media
           token, the dev-server and backend bases, the mapped ids of the positions, the
           products, the dispatch notes and the customer the scenarios name, and the path the
           R09 PDF is written to. It collects one record per scenario and writes
           ``temp/ws13/evidence/e12-stock/<name>.json`` — app HEAD and dirty paths, the mockup
           HTML hash, the stand instance, and per record the spec IDs, the recipe and its
           fixtures, viewport / DPR / actual theme classes, the measurements and interaction
           results, pass / fail / pending and the SHA-256 of every picture.
The tokens reach the browser only; nothing here prints them.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import capture_serve  # noqa: E402
import e02_evidence  # noqa: E402
import e04_evidence  # noqa: E402
import e05_evidence  # noqa: E402
import stand  # noqa: E402

PORT = e04_evidence.PORT
STAGE = "e12-stock"
# The mockup entities the scenarios stand on (stand baseline, T0): position 1 — SK-0005 «Дифузор
# «Колба»», 6 on hand, 4 held by hand, 2 available, minimum 10, two kits on the shelf, a sibling
# configuration; position 2 — the next one, for a position switch. Product 1 — the position's own;
# product 16 — a product with a variant group (the kits by option). Note 90000 — DN-0001. Customer
# 1 — the issue's.
POSITIONS = ("1", "2")
PRODUCTS = ("1", "16")
NOTES = ("90000",)
CUSTOMERS = ("1",)
RUNS = {
    "": {
        "stage": "pairs",
        "widths": {"wide": [1440, 1024], "narrow": [390]},
    },
}
# Every scenario of the stock runner (e12_stock.js), in its order. A full run is complete only when
# each of them has exactly one record; the runner reports what it declares, and a unit test holds the
# two together.
DETAIL_SCENARIOS = (
    "page@1440",
    "finished-states@1440",
    "finished@1440",
    "parts@1440",
    "parts-states@1440",
    "parts-assemble-other-option",
    "parts-out-of-kit",
    "journal@1440",
    "journal-states@1440",
    "journal-page-fail",
    "journal-back",
    "journal-st2-pending",
    "journal-st2-cached",
    "position@1440",
    "position-panel-states@1440",
    "position-states@1440",
    "position-journal-filters",
    "move-receipt@1440",
    "move-stocktake@1440",
    "move-issue@1440",
    "issue-manual-reserve",
    "dialog-config-switch",
    "dialog-refusal-reread",
    "move-sync@1440",
    "params@1440",
    "assemble@1440",
    "notes@1440",
    "notes-states@1440",
    "notes-count-failed",
    "waybill-cycle",
    "waybill-note-switch",
    "note-page@1440",
    "note-40-lines",
    "note-print-pdf",
    "print-emulation@1440",
    "supplier-general@1440",
    "keyboard@1440",
    "stats-1101",
    "stats-1100",
    "stats-561",
    "stats-560",
    "position-1101",
    "position-1100",
    "position-761",
    "position-760",
    "finished-long",
    "notes-long",
    "issue-short@390x600",
    "issue-short@1024x600",
    "narrow@390",
    "theme-light@1440",
    "theme-oled@1440",
)


def job_entities(mapping: dict) -> dict:
    """The stand's ids of the mockup positions, products, notes and customer the runner opens."""
    return {
        "positions": {number: mapping[f"fin:{number}"]["id"] for number in POSITIONS},
        "products": {number: mapping[f"product:{number}"]["id"] for number in PRODUCTS},
        "notes": {number: mapping[f"doc:{number}"]["id"] for number in NOTES},
        "customers": {number: mapping[f"customer:{number}"]["id"] for number in CUSTOMERS},
    }


def e12_recipes() -> list[dict]:
    """The E12 pair recipes (spec §L.1), in the E0 plan's own surface format — see
    ``capture_plan.json`` — kept in ``e12_pairs.json`` beside this sidecar."""
    return json.loads((HERE / "e12_pairs.json").read_text(encoding="utf-8"))


def pairs_plan(plan: dict, *, run: str = "") -> tuple[dict, list[str], str]:
    """The plan copy the E0 runner is given, the recipes it shoots, and the stage it writes."""
    spec = RUNS[run]
    recipes = e12_recipes()
    copy = {**plan, "widths": spec["widths"], "surfaces": [*plan["surfaces"], *recipes]}
    only = spec.get("only") or [r["id"] for r in recipes]
    return copy, list(only), f"{STAGE}-{spec['stage']}"


def pairs(mode: str = "") -> None:
    base = json.loads((HERE / "capture_plan.json").read_text(encoding="utf-8"))
    plan, only, stage = pairs_plan(base, run=mode)
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "capture_plan.json").write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
        capture_serve.HERE = Path(tmp)  # build_job reads the plan from HERE at call time
        sys.argv = ["capture_serve.py", "--mode", "baseline", "--stage", stage, "--only", ",".join(only)]
        capture_serve.main()


def header(manifest: dict) -> dict:
    return {**e04_evidence.header(manifest), "stage": STAGE}


def serve(name: str = "stock", only: str = "") -> None:
    root = stand.check_root(stand.expected_root("baseline"), mode="baseline")
    manifest = stand.read_manifest(root)
    mapping = json.loads((root / "mapping.json").read_text(encoding="utf-8"))
    client = stand.logged_in_client(root, manifest)
    out_dir = stand.REPO / "temp" / "ws13" / "evidence" / STAGE
    (out_dir / "shots").mkdir(parents=True, exist_ok=True)
    job = {
        "token": client.token,
        # The media token is minted by a POST that writes a row, which the runner never lets a
        # page send: minted here once, like the app token, and answered by the runner in its place.
        "media_token": e05_evidence.media_token(client),
        "ui": f"http://127.0.0.1:{manifest['ports']['vite']}",
        "api": f"http://127.0.0.1:{manifest['ports']['backend']}",
        "out": str(out_dir / "shots").replace("\\", "/"),
        # R09: the A4 PDF of a long dispatch note, beside the shots.
        "pdf": str(out_dir / "note-40-lines.pdf").replace("\\", "/"),
        # A comma list of scenario-id prefixes: a partial run records only those.
        "only": only,
        "mode": "baseline",
        **job_entities(mapping),
    }
    head = header(manifest)
    records: list[dict] = []
    done: dict = {}
    finished = threading.Event()

    stand.require_free_port(PORT)
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), e04_evidence.job_handler(job, records, done, finished))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(json.dumps({"serving": f"http://127.0.0.1:{PORT}"}), flush=True)
    finished.wait(timeout=2 * 3600)
    httpd.shutdown()
    # The job server guards the app token; the media token gets the same last guard here.
    records[:] = [e04_evidence.keep_record(r, job["media_token"]) for r in records]
    out = out_dir / f"{name}.json"
    rows = [e02_evidence.with_hashes(r) for r in records]
    verdict = e04_evidence.run_completeness(
        finished=finished.is_set(), done=done, records=records, only=only, expected=DETAIL_SCENARIOS
    )
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
        {"pairs": pairs}[sys.argv[1]](*sys.argv[2:3])
