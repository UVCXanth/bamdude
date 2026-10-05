"""WS-13 E13 acceptance evidence (spec §L.1) — a sidecar, loopback only, stdlib only.

    python scripts/workshop_stand/e13_evidence.py pairs
    python scripts/workshop_stand/e13_evidence.py serve [name] [scenario-prefix,...]

E4's sidecar (``e04_evidence.py``) is reused as it is — its record guard, its completeness
verdict and its job server — and the universal E0 runner (``capture_serve.py`` +
``capture.js``) is never extended:

``pairs``  mockup beside app for the owner's checkpoint (spec F6, J07), given to the runner as
           a COPY of the E0 plan (the plan file itself is never edited) with the recipes of
           ``e13_pairs.json`` added (``e13-acceptance-pairs``): only the surfaces E13 and the
           stages after their own acceptance actually changed.
``serve``  the job for ``e13_acceptance.js`` on 127.0.0.1:8197: the stand's app token, a media
           token, the dev-server and backend bases, the mapped ids of the orders, products,
           customer, position, dispatch note, library file and archives the scenarios name. It
           collects one record per scenario and writes
           ``temp/ws13/evidence/e13-acceptance/<name>.json`` — app HEAD and dirty paths, the
           mockup HTML hash, the stand instance, and per record the spec IDs, the recipe and its
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
import e08_evidence  # noqa: E402
import stand  # noqa: E402

PORT = e04_evidence.PORT
STAGE = "e13-acceptance"
# The mockup entities the scenarios stand on (stand baseline, Task 0): order 244 — OR-0034
# «Дифузори для кав’ярні», three lines of one product, one of them «кутовий», 27 prints; order
# 245 — OR-0035, a COMPLETED order with issues; order 241 — OR-0031, an active order with prints
# and a configured line; order 229 — OR-0030, a COMPLETED order two prints are filed under; order
# 251 — OR-0041, an active order without a customer. Product 1 — «Дифузор «Колба»». Customer 1.
# Position 1 and note 90000 — the stock
# pages. File «clm01_lbl_p1s.gcode.3mf» — four plates; «dif01_p1s.gcode.3mf» — the plate every
# line of OR-0034 takes (the print dialog's order question). Archive 3593 — the mockup's last
# print, filed under OR-0030.
ORDERS = ("244", "245", "241", "229", "251")
PRODUCTS = ("1",)
CUSTOMERS = ("1",)
POSITIONS = ("1",)
NOTES = ("90000",)
FILES = ("clm01_lbl_p1s.gcode.3mf", "dif01_p1s.gcode.3mf")
ARCHIVES = ("3593",)
RUNS = {
    "": {
        "stage": "pairs",
        "widths": {"wide": [1440, 1024], "narrow": [390]},
    },
}
# Every scenario of the acceptance runner (e13_acceptance.js), in its order. A full run is
# complete only when each of them has exactly one record; the runner reports what it declares,
# and a unit test holds the two together.
DETAIL_SCENARIOS = (
    # B / D — archives → order, rights, the library's links
    "archives-assign@1440",
    "archives-assign-rights",
    "archives-assign-leave-refused",
    "archive-edit-order@1440",
    "archive-edit-lines-states",
    "order-prints-unlink-rights",
    "clerk-archives",
    "clerk-order-prints",
    "reprint-inherits-order",
    "link-products-rights",
    "file-move-links",
    # C — «Add to order…» from the file manager
    "fm-add-to-order-file@1440",
    "fm-add-to-order-plate@1440",
    "fm-add-to-order-back",
    "fm-add-to-order-gone",
    "fm-add-to-order-reader",
    # E — confirmations and files
    "confirm-cover-order",
    "confirm-cover-product",
    "confirm-gallery-delete",
    "confirm-order-surfaces",
    "attachments-download",
    "gallery-order-keeps-ids",
    "hits-cards@390",
    # F — caches
    "cache-order-delete",
    "cache-stock-move",
    "cache-delivery-method",
    # G — rights, errors
    "rights-matrix",
    "customer-create-gate",
    "errors-sample",
    # O19 — roles by their own rights
    "storekeeper",
    "orders-reader-customer-filter",
    "dispatch-note-readers",
    "catalog-editor",
    "order-manager",
    # H — the outer doors
    "print-modal-library",
    "print-modal-printer",
    "print-modal-queue",
    "plan-from-files-create",
    "queue-refresh-after-enqueue",
    "filament-vs-inventory",
    "deep-links",
    # J — the sweeps
    "sweep-widths@2560",
    "sweep-widths@1920",
    "sweep-widths@1440",
    "sweep-widths@1280",
    "sweep-widths@1024",
    "sweep-widths@768",
    "sweep-widths@390",
    "sweep-sidebar",
    "sweep-themes",
    "sweep-en",
    "sweep-reader",
    "nav-active-detail",
    "nav-badges-server",
    "order-stats-row",
    "order-activity",
    # K03 — the built UI, from the stand's own server
    "built-smoke",
)


def job_entities(mapping: dict) -> dict:
    """The stand's ids of the mockup entities the runner opens."""
    return {
        "orders": {number: mapping[f"order:{number}"]["id"] for number in ORDERS},
        "products": {number: mapping[f"product:{number}"]["id"] for number in PRODUCTS},
        "customers": {number: mapping[f"customer:{number}"]["id"] for number in CUSTOMERS},
        "positions": {number: mapping[f"fin:{number}"]["id"] for number in POSITIONS},
        "notes": {number: mapping[f"doc:{number}"]["id"] for number in NOTES},
        "files": {name: mapping[f"file:{name}"]["id"] for name in FILES},
        "archives": {number: mapping[f"archive:{number}"]["id"] for number in ARCHIVES},
    }


def e13_recipes() -> list[dict]:
    """The E13 pair recipes (spec J07), in the E0 plan's own surface format — see
    ``capture_plan.json`` — kept in ``e13_pairs.json`` beside this sidecar."""
    return json.loads((HERE / "e13_pairs.json").read_text(encoding="utf-8"))


def pairs_plan(plan: dict, *, run: str = "") -> tuple[dict, list[str], str]:
    """The plan copy the E0 runner is given, the recipes it shoots, and the stage it writes."""
    spec = RUNS[run]
    recipes = e13_recipes()
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


def serve(name: str = "acceptance", only: str = "") -> None:
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
        # A real PNG the runner serves for a picture the stand does not hold (gallery, cover):
        # E8's two-band fixture, written beside the shots.
        "picture": str(e08_evidence.fixture_png(out_dir / "fixture-picture.png")).replace("\\", "/"),
        # «План з файлів»'s first step is a read-only POST (parts-preview), which a page of the
        # runner never sends: read here once for the print dialog's file, like the media token.
        "parts_preview": client.post(
            "/api/v1/library/files/parts-preview",
            {"file_ids": [mapping["file:dif01_p1s.gcode.3mf"]["id"]]},
        ),
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
    finished.wait(timeout=3 * 3600)
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
