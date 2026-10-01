"""WS-13 E7 acceptance evidence (spec §I1/I2) — a sidecar, loopback only, stdlib only.

    python scripts/workshop_stand/e07_evidence.py pairs [boundary]
    python scripts/workshop_stand/e07_evidence.py serve [name] [scenario-prefix,...]

E4's sidecar (``e04_evidence.py``) is reused as it is — its record guard, its completeness
verdict and its job server — and the universal E0 runner (``capture_serve.py`` +
``capture.js``) is never extended:

``pairs``  mockup beside app for the owner's checkpoint (spec F6): the E0 plan's five order
           list surfaces plus the E7 recipes of ``e07_pairs.json`` (the row and board menus),
           given to the runner as a COPY of the plan (the plan file itself is never edited)
           whose widths are the spec's (2560 / 1920 / 1440 / 1280 / 1024 / 768 / 390). Stage
           ``e07-order-lists-pairs``. ``pairs boundary`` shoots the table (its tiles) and the
           workspace at the widths either side of their breakpoints — 1101 / 1100, 761 / 760,
           561 / 560 — into ``…-pairs-boundary``.
``serve``  the job for ``e07_detail.js`` on 127.0.0.1:8197: the stand's app token, the
           dev-server and backend bases, and the mapped ids of the orders and the customer the
           scenarios name. It collects one record per scenario and writes
           ``temp/ws13/evidence/e07-order-lists/<name>.json`` — app HEAD and dirty paths, the
           mockup HTML hash, the stand instance, and per record the spec IDs, the recipe and its
           fixtures, viewport / DPR / actual theme classes, the measurements and interaction
           results, pass / fail / pending and the SHA-256 of every picture.
The token reaches the browser only; nothing here prints it.
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
STAGE = "e07-order-lists"
# The mockup entities the scenarios stand on (spec §I1): 241 active «printing», 243 «prep»,
# 244 «qc», 245 completed, 250 cancelled, 251 without a customer; customer 1 (the customer
# page's orders block shares the list).
ORDERS = ("241", "243", "244", "245", "250", "251")
CUSTOMERS = ("1",)
# The E0 plan's order list surfaces — shot again, at E7's widths, beside the E7 recipes.
E0_SURFACES = (
    "orders-table",
    "orders-table-grouped",
    "orders-cards",
    "orders-kanban",
    "orders-workspace",
    "orders-deadlines",
)
WIDTHS = {"wide": [2560, 1920, 1440, 1280, 1024, 768], "narrow": [390]}
HEIGHTS = {"2560": 1440, "1280": 800, "768": 1024}
# Breakpoints the E0 plan's widths do not straddle: the tile grid (1100 / 560) and the
# workspace split (760).
BOUNDARY_WIDTHS = (1101, 1100, 761, 760, 561, 560)
BOUNDARY_HEIGHT = 800
BOUNDARY_RECIPES = ("orders-table", "orders-workspace")
# Every scenario of the detail runner (e07_detail.js), in its order. A full run is complete only
# when each of them has exactly one record; the runner reports what it declares, and a unit test
# holds the two together.
DETAIL_SCENARIOS = (
    "tiles@1440",
    "tiles-grid@1101",
    "tiles-grid@1100",
    "tiles-grid@561",
    "tiles-grid@560",
    "tiles-error@1440",
    "filament@1440",
    "filament-states@1440",
    "toolbar@1440",
    "toolbar-reset@1440",
    "table@2560",
    "table@1920",
    "table@1440",
    "table@1280",
    "table@1024",
    "table@768",
    "table@390",
    "table-ready@1440",
    "table-sort@1440",
    "table-menu@1440",
    "table-grouped@1440",
    "table-grouped@390",
    "list-states@1440",
    "customer-states@1440",
    "cards@1920",
    "cards@1440",
    "cards@1024",
    "cards@390",
    "cards-thumbs@1440",
    "kanban@1920",
    "kanban@1440",
    "kanban@1024",
    "kanban@390",
    "kanban-more@1440",
    "kanban-stage@1440",
    "kanban-pending@1440",
    "kanban-done@1440",
    "kanban-reader@1440",
    "workspace@2560",
    "workspace@1920",
    "workspace@1440",
    "workspace@1024",
    "workspace@768",
    "workspace@761",
    "workspace@760",
    "workspace@390",
    "workspace-sticky@1440",
    "workspace-fallback@1440",
    "workspace-states@1440",
    "deadlines@1920",
    "deadlines@1440",
    "deadlines@1024",
    "deadlines@390",
    "deadlines-risk@1440",
    "deadlines-attention@1440",
    "deadlines-error@1440",
    "hits@390",
    "theme-light@1440",
    "theme-oled@1440",
    "layout-pages@1440",
    "layout-pages@1024",
    "layout-pages@390",
)


def job_entities(mapping: dict) -> dict:
    """The stand's ids of the mockup entities the runner opens, by mockup number."""
    return {
        "orders": {number: mapping[f"order:{number}"]["id"] for number in ORDERS},
        "customers": {number: mapping[f"customer:{number}"]["id"] for number in CUSTOMERS},
    }


def e07_recipes() -> list[dict]:
    """The E7 pair recipes (spec §I1), in the E0 plan's own surface format — see
    ``capture_plan.json`` — kept in ``e07_pairs.json`` beside this sidecar."""
    return json.loads((HERE / "e07_pairs.json").read_text(encoding="utf-8"))


def pairs_plan(plan: dict, *, boundary: bool) -> tuple[dict, list[str], str]:
    """The plan copy the E0 runner is given, the recipes it shoots, and the stage it writes."""
    added = e07_recipes()
    if boundary:
        only = list(BOUNDARY_RECIPES)
        plan = {
            **plan,
            "widths": {"wide": list(BOUNDARY_WIDTHS), "narrow": []},
            "heights": {**plan["heights"], **{str(w): BOUNDARY_HEIGHT for w in BOUNDARY_WIDTHS}},
        }
        stage = f"{STAGE}-pairs-boundary"
    else:
        only = [*E0_SURFACES, *(r["id"] for r in added)]
        plan = {**plan, "widths": WIDTHS, "heights": {**plan["heights"], **HEIGHTS}}
        stage = f"{STAGE}-pairs"
    plan = {**plan, "surfaces": [*plan["surfaces"], *added]}
    return plan, only, stage


def pairs(mode: str = "") -> None:
    base = json.loads((HERE / "capture_plan.json").read_text(encoding="utf-8"))
    plan, only, stage = pairs_plan(base, boundary=mode == "boundary")
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "capture_plan.json").write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
        capture_serve.HERE = Path(tmp)  # build_job reads the plan from HERE at call time
        sys.argv = ["capture_serve.py", "--mode", "baseline", "--stage", stage, "--only", ",".join(only)]
        capture_serve.main()


def header(manifest: dict) -> dict:
    return {**e04_evidence.header(manifest), "stage": STAGE}


def serve(name: str = "detail", only: str = "") -> None:
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
