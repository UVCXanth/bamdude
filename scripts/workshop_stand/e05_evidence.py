"""WS-13 E5 acceptance evidence (spec §I1/I2) — a sidecar, loopback only, stdlib only.

    python scripts/workshop_stand/e05_evidence.py pairs [boundary]
    python scripts/workshop_stand/e05_evidence.py serve [name] [scenario-prefix,...]

E4's sidecar (``e04_evidence.py``) is reused as it is — its record guard, its completeness
verdict and its job server — and the universal E0 runner (``capture_serve.py`` +
``capture.js``) is never extended:

``pairs``  mockup beside app for the owner's checkpoint (spec F6): the E5 recipes of
           ``e05_pairs.json``, given to the runner as a COPY of the E0 plan with them added
           (the plan file itself is never edited). Stage ``e05-add-to-order-config-pairs``.
           ``pairs boundary`` shoots the plate tab at the two widths either side of its
           breakpoint (1101 / 1100) — widths the E0 plan does not have, so the copy carries
           them — into ``…-pairs-boundary``. A recipe whose app side names ``stand_rows``
           has the library list answered with exactly those rows of the stand, tagged as
           the tag writer tags them (the stand's seeded rows carry no ``file_tags``).
``serve``  the job for ``e05_detail.js`` on 127.0.0.1:8197: the stand's app token, the
           dev-server and backend bases, the mapped ids of the orders, the product and the
           files the scenarios name; it collects one record per scenario and writes
           ``temp/ws13/evidence/e05-add-to-order-config/<name>.json`` — app HEAD and dirty
           paths, the mockup HTML hash, the stand instance, and per record the spec IDs,
           the recipe and its fixtures, viewport / DPR / actual theme classes, the
           measurements and interaction results, pass / fail / pending and the SHA-256
           of every picture.
The token reaches the browser only; nothing here prints it.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import capture_serve  # noqa: E402
import e02_evidence  # noqa: E402
import e04_evidence  # noqa: E402
import stand  # noqa: E402

PORT = e04_evidence.PORT
STAGE = "e05-add-to-order-config"
# The mockup entities the scenarios stand on (spec §I1): orders 241 (one configured product
# line), 244 (a parts line) and 245 (completed); CLM-01 (product 2); the library files whose
# rows and plates the plate tab is judged by.
ORDERS = ("241", "244", "245")
PRODUCTS = ("2",)
FILES = (
    "cable_clip_set.gcode.3mf",
    "price_holder_v2.gcode.3mf",
    "hook_small_v2.gcode.3mf",
    "calibration_cube.gcode.3mf",
    "sign_holder.3mf",
    "rem06_buttons.stl",
)
# The plate tab's breakpoint is the WINDOW's 1100 px; the E0 plan's widths do not straddle it.
BOUNDARY_WIDTHS = (1101, 1100)
BOUNDARY_HEIGHT = 800
BOUNDARY_RECIPES = ("e05-add-plate",)
# Every scenario of the detail runner (e05_detail.js), in its order. A full run is complete only
# when each of them has exactly one record; the runner reports what it declares, and a unit test
# holds the two together.
DETAIL_SCENARIOS = (
    "add-geometry@2560",
    "add-geometry@1920",
    "add-geometry@1440",
    "add-geometry@1280",
    "add-geometry@1101",
    "add-geometry@1100",
    "add-geometry@1024",
    "add-geometry@768",
    "add-geometry@390",
    "add-short@390x600",
    "add-short@1024x600",
    "add-draft@1440",
    "add-scroll@390",
    "add-submit@1440",
    "add-refused@1440",
    "add-products@1440",
    "add-stock-states@1440",
    "add-inactive@1440",
    "add-parts@1440",
    "add-parts@390",
    "add-parts-hidden@1440",
    "add-plate@1440",
    "add-plate-thumbnail@1440",
    "add-plate-states@1440",
    "add-plate-list@1440",
    "add-plate-noaccess@1440",
    "config-241@1440",
    "config-241@390",
    "config-states@1440",
    "config-244-parts@1440",
    "f12-catalog@1440",
    "f12-menu-gates@1440",
    "f12-states@1440",
    "f12-navigate@1440",
    "hits@390",
    "theme-light@1440",
    "theme-oled@1440",
)


def job_entities(mapping: dict) -> dict:
    """The stand's ids of the mockup entities the runner opens, by mockup number or file name."""
    return {
        "orders": {number: mapping[f"order:{number}"]["id"] for number in ORDERS},
        "products": {number: mapping[f"product:{number}"]["id"] for number in PRODUCTS},
        "files": {name: mapping[f"file:{name}"]["id"] for name in FILES},
    }


def e05_recipes() -> list[dict]:
    """The E5 pair recipes (spec §I1), in the E0 plan's own surface format — see
    ``capture_plan.json`` — kept in ``e05_pairs.json`` beside this sidecar."""
    return json.loads((HERE / "e05_pairs.json").read_text(encoding="utf-8"))


def format_tags(filename: str, file_type: str) -> list[str]:
    """The format and readiness tags ``compute_file_tags`` writes for a row judged by its name
    and type alone — the stand's seeded rows carry none, and hold no content flag to judge by."""
    if file_type == "gcode":
        return ["gcode", "3mf"] if filename.lower().endswith(".3mf") else ["gcode"]
    return {"3mf": ["3mf", "project"], "stl": ["stl", "geometry"]}.get(file_type, [])


def with_stand_rows(recipe: dict, rows_for) -> dict:
    """A recipe whose app side names ``stand_rows`` gets the library list answered with exactly
    those rows of the stand, tagged as the tag writer would have tagged them — a ``merge``
    rewrite the E0 runner validates and records. The key itself never reaches the runner."""
    app = dict(recipe["app"])
    names = app.pop("stand_rows", None)
    if not names:
        return {**recipe, "app": app}
    rows = [
        {**row, "file_tags": row.get("file_tags") or format_tags(row["filename"], row["file_type"])}
        for row in rows_for(names)
    ]
    meta = {"total": len(rows), "current_page": 1, "per_page": 24, "last_page": 1}
    app["rewrites"] = [
        *app.get("rewrites", []),
        {"path": "/api/v1/library/files", "merge": {"items": rows, "meta": meta}},
    ]
    return {**recipe, "app": app}


def stand_rows_reader(client):
    """Reads each named file's list row from the stand, exactly as the list answers it."""

    def rows_for(names: list[str]) -> list[dict]:
        out = []
        for name in names:
            page = client.get(f"/api/v1/library/files?include_root=false&page=1&per_page=50&q={quote(name)}")
            page = page if isinstance(page, dict) else page.json()
            (row,) = [r for r in page["items"] if r["filename"] == name]
            out.append(row)
        return out

    return rows_for


def pairs_plan(plan: dict, *, boundary: bool, rows_for=None) -> tuple[dict, list[str], str]:
    """The plan copy the E0 runner is given, the recipes it shoots, and the stage it writes."""
    added = e05_recipes()
    if rows_for is not None:
        added = [with_stand_rows(r, rows_for) for r in added]
    if boundary:
        added = [r for r in added if r["id"] in BOUNDARY_RECIPES]
        plan = {
            **plan,
            "widths": {"wide": list(BOUNDARY_WIDTHS), "narrow": []},
            "heights": {**plan["heights"], **{str(w): BOUNDARY_HEIGHT for w in BOUNDARY_WIDTHS}},
        }
    plan = {**plan, "surfaces": [*plan["surfaces"], *added]}
    stage = f"{STAGE}-pairs-boundary" if boundary else f"{STAGE}-pairs"
    return plan, [r["id"] for r in added], stage


def pairs(mode: str = "") -> None:
    base = json.loads((HERE / "capture_plan.json").read_text(encoding="utf-8"))
    root = stand.check_root(stand.expected_root("baseline"), mode="baseline")
    client = stand.logged_in_client(root, stand.read_manifest(root))
    plan, only, stage = pairs_plan(base, boundary=mode == "boundary", rows_for=stand_rows_reader(client))
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "capture_plan.json").write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
        capture_serve.HERE = Path(tmp)  # build_job reads the plan from HERE at call time
        sys.argv = ["capture_serve.py", "--mode", "baseline", "--stage", stage, "--only", ",".join(only)]
        capture_serve.main()


def header(manifest: dict) -> dict:
    return {**e04_evidence.header(manifest), "stage": STAGE}


def media_token(client) -> str:
    """One media token for the stand's signed-in user (``POST /auth/media-token``)."""
    answer = client.post("/api/v1/auth/media-token")
    answer = answer if isinstance(answer, dict) else answer.json()
    return answer["token"]


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
        "media_token": media_token(client),
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
