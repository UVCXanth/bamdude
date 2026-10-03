"""WS-13 E10 acceptance evidence (spec §K.1) — a sidecar, loopback only, stdlib only.

    python scripts/workshop_stand/e10_evidence.py pairs
    python scripts/workshop_stand/e10_evidence.py serve [name] [scenario-prefix,...]

E4's sidecar (``e04_evidence.py``) is reused as it is — its record guard, its completeness
verdict and its job server — and the universal E0 runner (``capture_serve.py`` +
``capture.js``) is never extended:

``pairs``  mockup beside app for the owner's checkpoint (spec F6), given to the runner as a
           COPY of the E0 plan (the plan file itself is never edited) with the ten dialog
           recipes of ``e10_pairs.json`` added, at 1440 and 390 (``e10-product-editors-pairs``):
           a ``lg`` dialog is min(1000px, 94vw), so a wider frame changes nothing in it.
``serve``  the job for ``e10_editors.js`` on 127.0.0.1:8197: the stand's app token, a media
           token, the dev-server and backend bases and the mapped ids of the products the
           scenarios name. It collects one record per scenario and writes
           ``temp/ws13/evidence/e10-product-editors/<name>.json`` — app HEAD and dirty paths, the
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
import stand  # noqa: E402

PORT = e04_evidence.PORT
STAGE = "e10-product-editors"
# The mockup products the scenarios stand on (stand baseline, T0): 1 — six parts (four printed,
# two purchased), one variant group, a shelf; 8 — the product a creation lands on.
PRODUCTS = ("1", "8")
RUNS = {
    "": {
        "stage": "pairs",
        "widths": {"wide": [1440], "narrow": [390]},
    },
}
# Every scenario of the editors runner (e10_editors.js), in its order. A full run is complete only
# when each of them has exactly one record; the runner reports what it declares, and a unit test
# holds the two together.
DETAIL_SCENARIOS = (
    "form@1440",
    "form-refusal@1440",
    "form-create@1440",
    "part-create@1440",
    "part-edit@1440",
    "merge@1440",
    "delete@1440",
    "variants@1440",
    "variants-refusals@1440",
    "from-file@1440",
    "reread@1440",
    "import@1440",
    "categories@1440",
    "adjust@1440",
    "keyboard@1440",
    "short@390x600",
    "short@1024x600",
    "grid@761",
    "grid@760",
    "narrow@390",
    "theme-light@1440",
    "theme-oled@1440",
)


def job_entities(mapping: dict) -> dict:
    """The stand's ids of the mockup products the runner opens, by mockup number."""
    return {"products": {number: mapping[f"product:{number}"]["id"] for number in PRODUCTS}}


def e10_recipes() -> list[dict]:
    """The E10 pair recipes (spec §K.1), in the E0 plan's own surface format — see
    ``capture_plan.json`` — kept in ``e10_pairs.json`` beside this sidecar."""
    return json.loads((HERE / "e10_pairs.json").read_text(encoding="utf-8"))


def pairs_plan(plan: dict, *, run: str = "") -> tuple[dict, list[str], str]:
    """The plan copy the E0 runner is given, the recipes it shoots, and the stage it writes."""
    spec = RUNS[run]
    recipes = e10_recipes()
    copy = {**plan, "widths": spec["widths"], "surfaces": [*plan["surfaces"], *recipes]}
    return copy, [r["id"] for r in recipes], f"{STAGE}-{spec['stage']}"


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


def serve(name: str = "editors", only: str = "") -> None:
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
