"""WS-13 E9 acceptance evidence (spec §I1/I2) — a sidecar, loopback only, stdlib only.

    python scripts/workshop_stand/e09_evidence.py pairs [boundary|menus]
    python scripts/workshop_stand/e09_evidence.py serve [name] [scenario-prefix,...]

E4's sidecar (``e04_evidence.py``) is reused as it is — its record guard, its completeness
verdict and its job server — and the universal E0 runner (``capture_serve.py`` +
``capture.js``) is never extended:

``pairs``  mockup beside app for the owner's checkpoint (spec F6), given to the runner as a
           COPY of the E0 plan (the plan file itself is never edited). The E0 plan's five
           product-detail surfaces had no tabs to open in the app (``missing``); the copy opens
           each through the page's address (``?tab=``) — the mockup clicks its tab as before.
           ``pairs`` — the five tabs at 1920 / 1440 / 1024 / 390 (``e09-product-page-pairs``);
           ``pairs boundary`` — the composition either side of the layout's breakpoints, 1101 /
           1100 and 761 / 760 (``…-pairs-boundary``); ``pairs menus`` — the open «⋮» of the
           header at 1440 / 390 (``…-pairs-menus``, the recipe of ``e09_pairs.json``).
``serve``  the job for ``e09_detail.js`` on 127.0.0.1:8197: the stand's app token, a media token,
           the dev-server and backend bases, the mapped ids of the products the scenarios name,
           and the picture fixture. It collects one record per scenario and writes
           ``temp/ws13/evidence/e09-product-page/<name>.json`` — app HEAD and dirty paths, the
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
STAGE = "e09-product-page"
# The mockup products the scenarios stand on (stand baseline, T0): 1 — variants, bought parts, 52
# linked files through one folder, two positions, documents, eight orders; 8 — no variants, one
# position; 900 — the one-off.
PRODUCTS = ("1", "8", "900")
# The E0 plan's product-detail surfaces, and the tab each one is.
TABS = {
    "product-detail-composition": "composition",
    "product-detail-plates": "plates",
    "product-detail-stock": "stock",
    "product-detail-docs": "docs",
    "product-detail-orders": "orders",
}
HEIGHTS = {"1920": 1080, "1024": 768}
RUNS = {
    "": {"stage": "pairs", "only": list(TABS), "widths": {"wide": [1920, 1440, 1024], "narrow": [390]}},
    "boundary": {
        "stage": "pairs-boundary",
        "only": ["product-detail-composition"],
        "widths": {"wide": [1101, 1100, 761, 760], "narrow": []},
    },
    "menus": {"stage": "pairs-menus", "only": ["e09-product-menu"], "widths": {"wide": [1440], "narrow": [390]}},
}
BOUNDARY_HEIGHT = 800
# Every scenario of the detail runner (e09_detail.js), in its order. A full run is complete only
# when each of them has exactly one record; the runner reports what it declares, and a unit test
# holds the two together.
DETAIL_SCENARIOS = (
    "header@1440",
    "header-reader@1440",
    "header-adhoc@1440",
    "reread@1440",
    "reread-states@1440",
    "layout@2560",
    "layout@1440",
    "layout@1101",
    "layout@1100",
    "layout@761",
    "layout@760",
    "layout@390",
    "scroll@1440",
    "scroll@390",
    "route@1440",
    "states@1440",
    "facts@1440",
    "estimate@1440",
    "stock-fact@1440",
    "visual@1440",
    "tabs@1440",
    "tabs-independent@1440",
    "composition@1440",
    "composition-sources@1440",
    "composition-edit@1440",
    "composition-dialogs@1440",
    "plates@1440",
    "plates-unlink@1440",
    "plates-library@1440",
    "stock@1440",
    "stock-assemble@1440",
    "journal@1440",
    "docs@1440",
    "docs-view@1440",
    "orders@1440",
    "orders-pages@1440",
    "hits@390",
    "theme-light@1440",
    "theme-oled@1440",
)


def job_entities(mapping: dict) -> dict:
    """The stand's ids of the mockup products the runner opens, by mockup number."""
    return {"products": {number: mapping[f"product:{number}"]["id"] for number in PRODUCTS}}


def e09_recipes() -> list[dict]:
    """The E9 pair recipes (spec §I1), in the E0 plan's own surface format — see
    ``capture_plan.json`` — kept in ``e09_pairs.json`` beside this sidecar."""
    return json.loads((HERE / "e09_pairs.json").read_text(encoding="utf-8"))


def detail_surface(surface: dict) -> dict:
    """An E0 product-detail surface with the app side the page now has: its tab, by address."""
    tab = TABS[surface["id"]]
    route = "/products/{product:1}" + ("" if tab == "composition" else f"?tab={tab}")
    return {**surface, "widths": "all", "app": {"route": route}}


def pairs_plan(plan: dict, *, run: str = "") -> tuple[dict, list[str], str]:
    """The plan copy the E0 runner is given, the recipes it shoots, and the stage it writes."""
    spec = RUNS[run]
    widths = spec["widths"]
    every = [*widths["wide"], *widths["narrow"]]
    heights = {**plan["heights"], **HEIGHTS}
    if run == "boundary":
        heights |= {str(w): BOUNDARY_HEIGHT for w in every}
    surfaces = [detail_surface(s) if s["id"] in TABS else s for s in plan["surfaces"]]
    copy = {**plan, "widths": widths, "heights": heights, "surfaces": [*surfaces, *e09_recipes()]}
    return copy, list(spec["only"]), f"{STAGE}-{spec['stage']}"


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
        # A real picture (E8's fixture): the cover, a gallery picture and a document picture.
        "cover_png": str(e08_evidence.fixture_png(out_dir / "fixture-cover.png")).replace("\\", "/"),
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
