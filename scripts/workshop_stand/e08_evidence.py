"""WS-13 E8 acceptance evidence (spec §I1/I2) — a sidecar, loopback only, stdlib only.

    python scripts/workshop_stand/e08_evidence.py pairs [cards|menus|boundary]
    python scripts/workshop_stand/e08_evidence.py serve [name] [scenario-prefix,...]

E4's sidecar (``e04_evidence.py``) is reused as it is — its record guard, its completeness
verdict and its job server — and the universal E0 runner (``capture_serve.py`` +
``capture.js``) is never extended:

``pairs``  mockup beside app for the owner's checkpoint (spec F6), given to the runner as a
           COPY of the E0 plan (the plan file itself is never edited). The runner's widths are
           one set per run, so each set of the spec is its own run and stage:
           ``pairs`` — the table at 2560 / 1920 / 1440 / 1280 / 1024 / 768 / 390
           (``e08-product-catalog-pairs``); ``pairs cards`` — the cards at 1920 / 1440 / 1024 /
           390 (``…-pairs-cards``); ``pairs menus`` — the open row menu at 1440 / 390 and the
           open card menu at 1440 (``…-pairs-menus``, the recipes of ``e08_pairs.json``);
           ``pairs boundary`` — the table and the cards either side of the category column's
           breakpoints, 1101 / 1100 and 761 / 760 (``…-pairs-boundary``).
``serve``  the job for ``e08_detail.js`` on 127.0.0.1:8197: the stand's app token, a media token,
           the dev-server and backend bases, and the mapped ids of the products the scenarios
           name. It collects one record per scenario and writes
           ``temp/ws13/evidence/e08-product-catalog/<name>.json`` — app HEAD and dirty paths, the
           mockup HTML hash, the stand instance, and per record the spec IDs, the recipe and its
           fixtures, viewport / DPR / actual theme classes, the measurements and interaction
           results, pass / fail / pending and the SHA-256 of every picture.
The tokens reach the browser only; nothing here prints them.
"""

from __future__ import annotations

import json
import struct
import sys
import tempfile
import threading
import zlib
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
STAGE = "e08-product-catalog"
# The mockup products the scenarios stand on (stand baseline, T0): 1 — variants, bought parts, an
# active order, two configurations, below its minimum; 5 — two configurations; 8 — two active
# orders; 11 — hidden from the catalog; 104 — a draft below its minimum; 900 — the one-off.
PRODUCTS = ("1", "5", "8", "11", "104", "900")
# The E0 plan's catalog surfaces, shot again at E8's widths.
E0_TABLE = "products-table"
E0_CARDS = "products-cards"
HEIGHTS = {"2560": 1440, "1280": 800, "768": 1024}
# One width set per run (the E0 runner's widths are the run's, not a surface's).
RUNS = {
    "": {
        "stage": "pairs",
        "only": [E0_TABLE],
        "widths": {"wide": [2560, 1920, 1440, 1280, 1024, 768], "narrow": [390]},
    },
    "cards": {"stage": "pairs-cards", "only": [E0_CARDS], "widths": {"wide": [1920, 1440, 1024], "narrow": [390]}},
    "menus": {
        "stage": "pairs-menus",
        "only": ["e08-products-row-menu", "e08-products-card-menu"],
        "widths": {"wide": [1440], "narrow": [390]},
    },
    "boundary": {
        "stage": "pairs-boundary",
        "only": [E0_TABLE, E0_CARDS],
        "widths": {"wide": [1101, 1100, 761, 760], "narrow": []},
    },
}
BOUNDARY_HEIGHT = 800
# Every scenario of the detail runner (e08_detail.js), in its order. A full run is complete only
# when each of them has exactly one record; the runner reports what it declares, and a unit test
# holds the two together.
DETAIL_SCENARIOS = (
    "header@1440",
    "header@390",
    "header-reader@1440",
    "search@1440",
    "filters@1440",
    "filters-links@1440",
    "filters-reset@1440",
    "filters-history@1440",
    "filters-facets-fail@1440",
    "categories@2560",
    "categories@1440",
    "categories@1101",
    "categories@1100",
    "categories@761",
    "categories@760",
    "categories@390",
    "categories-sticky@1440",
    "categories-sticky@1024",
    "categories-numbers@1440",
    "categories-directory@1440",
    "categories-list-states@1440",
    "states@1440",
    "states-page@1440",
    "table@2560",
    "table@1920",
    "table@1440",
    "table@1280",
    "table@1024",
    "table@768",
    "table@390",
    "table-cells@1440",
    "table-sort@1440",
    "table-sort-keys@1440",
    "covers@1440",
    "cards@1920",
    "cards@1440",
    "cards@1024",
    "cards@390",
    "cards-overlay@1440",
    "cards-long@390",
    "menu-items@1440",
    "menu-duplicate@1440",
    "menu-duplicate-long@1440",
    "menu-export@1440",
    "menu-hide@1440",
    "menu-hide-last@1440",
    "menu-promote@1440",
    "menu-delete@1440",
    "menu-delete-ghost@1440",
    "menu-to-order@1440",
    "menu-survives@1440",
    "detail-actions@1440",
    "detail-promote@1440",
    "pages@1440",
    "hits@390",
    "theme-light@1440",
    "theme-oled@1440",
)


COVER_SIZE = (96, 64)


def fixture_png(path: Path, size: tuple[int, int] = COVER_SIZE) -> Path:
    """A real picture for the cover fixture (spec K11): the baseline holds no product cover and the
    runner never writes one, so the cover-image GET is answered with this file — a valid PNG, two
    colour bands, so a decoded picture can be told from a blank one."""
    w, h = size
    rows = b"".join(b"\x00" + bytes([198, 40, 40]) * (w // 2) + bytes([40, 110, 198]) * (w - w // 2) for _ in range(h))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    return path


def job_entities(mapping: dict) -> dict:
    """The stand's ids of the mockup products the runner opens, by mockup number."""
    return {"products": {number: mapping[f"product:{number}"]["id"] for number in PRODUCTS}}


def e08_recipes() -> list[dict]:
    """The E8 pair recipes (spec §I1), in the E0 plan's own surface format — see
    ``capture_plan.json`` — kept in ``e08_pairs.json`` beside this sidecar."""
    return json.loads((HERE / "e08_pairs.json").read_text(encoding="utf-8"))


def pairs_plan(plan: dict, *, run: str = "") -> tuple[dict, list[str], str]:
    """The plan copy the E0 runner is given, the recipes it shoots, and the stage it writes."""
    spec = RUNS[run]
    widths = spec["widths"]
    every = [*widths["wide"], *widths["narrow"]]
    heights = {**plan["heights"], **HEIGHTS}
    if run == "boundary":
        heights |= {str(w): BOUNDARY_HEIGHT for w in every}
    # The catalog surfaces take the run's narrow width too (the E0 plan shot the table wide only).
    surfaces = [{**s, "widths": "all"} if s["id"] in (E0_TABLE, E0_CARDS) else s for s in plan["surfaces"]]
    copy = {**plan, "widths": widths, "heights": heights, "surfaces": [*surfaces, *e08_recipes()]}
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
        # The cover fixture (K11) — a real PNG the runner answers the cover-image GET with.
        "cover_png": str(fixture_png(out_dir / "fixture-cover.png")).replace("\\", "/"),
        "cover_size": list(COVER_SIZE),
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
