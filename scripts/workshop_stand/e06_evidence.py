"""WS-13 E6 acceptance evidence (spec §I1/I2) — a sidecar, loopback only, stdlib only.

    python scripts/workshop_stand/e06_evidence.py pairs [boundary]
    python scripts/workshop_stand/e06_evidence.py serve [name] [scenario-prefix,...]

E4's sidecar (``e04_evidence.py``) is reused as it is — its record guard, its completeness
verdict and its job server — and the universal E0 runner (``capture_serve.py`` +
``capture.js``) is never extended:

``pairs``  mockup beside app for the owner's checkpoint (spec F6): the E6 recipes of
           ``e06_pairs.json``, given to the runner as a COPY of the E0 plan with them added
           (the plan file itself is never edited). Stage ``e06-order-forms-actions-issue-pairs``.
           ``pairs boundary`` shoots the order form at the two widths either side of its
           breakpoint (761 / 760) — widths the E0 plan does not have, so the copy carries
           them — into ``…-pairs-boundary``.
``serve``  the job for ``e06_detail.js`` on 127.0.0.1:8197: the stand's app token, the
           dev-server and backend bases, the mapped ids of the orders and the dispatch note
           the scenarios name, and the mockup's file URI with its preferences (the F26 pair is
           shot by the runner itself: the mockup's ``docCreated`` window beside the app's
           window after an answered POST — the E0 runner cannot reach either). It collects one
           record per scenario and writes ``temp/ws13/evidence/e06-order-forms-actions-issue/
           <name>.json`` — app HEAD and dirty paths, the mockup HTML hash, the stand instance,
           and per record the spec IDs, the recipe and its fixtures, viewport / DPR / actual
           theme classes, the measurements and interaction results, pass / fail / pending and
           the SHA-256 of every picture — plus, for the records that carry a pair, a pairs
           manifest in the E0 shape (``…-f26/manifest.json``) the composites are built from.
The token reaches the browser only; nothing here prints it.
"""

from __future__ import annotations

import hashlib
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
STAGE = "e06-order-forms-actions-issue"
# The mockup entities the scenarios stand on (spec §I1): 241 active with one product line,
# 244 two lines of one product + a parts line and a bankable surplus, 245 completed, 246 a
# colour outside the palette, 247 five units held, 250 cancelled, 251 without a customer;
# dispatch note 90000 (the F26 window names it).
ORDERS = ("241", "244", "245", "246", "247", "250", "251")
DOCS = ("90000",)
# The order form's pairs break at the WINDOW's 760 px; the E0 plan's widths do not straddle it.
BOUNDARY_WIDTHS = (761, 760)
BOUNDARY_HEIGHT = 800
BOUNDARY_RECIPES = ("e06-order-new",)
# The pair the detail runner shoots itself (spec R08), under this recipe name in its manifest.
F26_RECIPE = "e06-dispatch-note-window"
# Every scenario of the detail runner (e06_detail.js), in its order. A full run is complete only
# when each of them has exactly one record; the runner reports what it declares, and a unit test
# holds the two together.
DETAIL_SCENARIOS = (
    "form-geometry@1920",
    "form-geometry@1440",
    "form-geometry@1024",
    "form-geometry@768",
    "form-geometry@761",
    "form-geometry@760",
    "form-geometry@390",
    "form-edit@1440",
    "form-edit@390",
    "form-palette@1440",
    "form-responsible-inactive@1440",
    "form-refusals@1440",
    "form-pending@1440",
    "form-create@1440",
    "form-list-read@1440",
    "form-status@1440",
    "form-session@1440",
    "dup@1440",
    "dup@390",
    "dup-flow@1440",
    "dup-long-past@1440",
    "dup-refusal@1440",
    "menu-detail@1440",
    "menu-detail@390",
    "menu-states@1440",
    "menu-reader@1440",
    "menu-workspace@1440",
    "menu-lifetime@1440",
    "menu-focus-return@1440",
    "menu-confirms@1440",
    "board-drop@1440",
    "f06-geometry@1920",
    "f06-geometry@1440",
    "f06-geometry@1024",
    "f06-geometry@390",
    "f06-244@1440",
    "f06-251@1440",
    "f06-writeoff@1440",
    "f06-close-mark@1440",
    "f06-read-error@1440",
    "f06-refusal@1440",
    "f06-trim@1440",
    "f06-pending@1440",
    "f26-pair@1440",
    "f26-pair@390",
    "bank-244@1440",
    "bank-refusal@1440",
    "take-241@1440",
    "hits@390",
    "theme-light@1440",
    "theme-oled@1440",
)


def job_entities(mapping: dict) -> dict:
    """The stand's ids of the mockup entities the runner opens, by mockup number."""
    return {
        "orders": {number: mapping[f"order:{number}"]["id"] for number in ORDERS},
        "docs": {number: mapping[f"doc:{number}"]["id"] for number in DOCS},
    }


def mockup_job(plan: dict) -> dict:
    """The mockup the runner opens itself for the F26 pair — the E0 runner's own file and
    preferences, so both sides of every pair of this stage see the same mockup."""
    return {
        "mockup": capture_serve.MOCKUP.as_uri(),
        "mockup_pref_key": capture_serve.MOCKUP_PREF_KEY,
        "mockup_pref": json.dumps({"theme": plan["theme"]["mockup"]}),
    }


def e06_recipes() -> list[dict]:
    """The E6 pair recipes (spec §I1), in the E0 plan's own surface format — see
    ``capture_plan.json`` — kept in ``e06_pairs.json`` beside this sidecar."""
    return json.loads((HERE / "e06_pairs.json").read_text(encoding="utf-8"))


def pairs_plan(plan: dict, *, boundary: bool) -> tuple[dict, list[str], str]:
    """The plan copy the E0 runner is given, the recipes it shoots, and the stage it writes."""
    added = e06_recipes()
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
    plan, only, stage = pairs_plan(base, boundary=mode == "boundary")
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "capture_plan.json").write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
        capture_serve.HERE = Path(tmp)  # build_job reads the plan from HERE at call time
        sys.argv = ["capture_serve.py", "--mode", "baseline", "--stage", stage, "--only", ",".join(only)]
        capture_serve.main()


def header(manifest: dict) -> dict:
    return {**e04_evidence.header(manifest), "stage": STAGE}


def _frame(name: str) -> dict:
    path = Path(name)
    return {
        "file": str(path.relative_to(stand.REPO)).replace("\\", "/") if path.exists() else name,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None,
    }


def pair_rows(records: list[dict]) -> list[dict]:
    """The records that carry a pair (``pair: {mockup: [...], app: [...]}``), as the E0
    manifest's rows — one per side and width — so one composite builder serves every pair.
    The width is the scenario's (``…@<width>``); a pair that is not on disk is kept, named."""
    rows = []
    for record in records:
        pair = record.get("pair")
        if not isinstance(pair, dict):
            continue
        width = int(str(record["id"]).rsplit("@", 1)[1])
        for side in ("mockup", "app"):
            frames = [_frame(name) for name in pair.get(side) or []]
            rows.append(
                {
                    "recipe": F26_RECIPE,
                    "side": side,
                    "width": width,
                    "file": frames[0]["file"] if frames else None,
                    "frames": frames,
                    "ok": record.get("pass") is True,
                    "scenario": record["id"],
                }
            )
    return rows


def serve(name: str = "detail", only: str = "") -> None:
    root = stand.check_root(stand.expected_root("baseline"), mode="baseline")
    manifest = stand.read_manifest(root)
    mapping = json.loads((root / "mapping.json").read_text(encoding="utf-8"))
    client = stand.logged_in_client(root, manifest)
    plan = json.loads((HERE / "capture_plan.json").read_text(encoding="utf-8"))
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
        **mockup_job(plan),
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
    pairs_out = None
    paired = pair_rows(records)
    if paired:
        pairs_dir = stand.REPO / "temp" / "ws13" / "evidence" / f"{STAGE}-f26"
        pairs_dir.mkdir(parents=True, exist_ok=True)
        pairs_out = pairs_dir / "manifest.json"
        pairs_out.write_text(
            json.dumps({**head, "stage": f"{STAGE}-f26", "results": paired}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
    not_passed = [r["id"] for r in rows if r.get("pass") is not True]
    print(
        json.dumps(
            {
                "manifest": str(out),
                "pairs": str(pairs_out) if pairs_out else None,
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
