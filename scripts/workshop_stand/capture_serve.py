"""The capture job server (spec F1, F4, F7) — loopback only, stdlib only.

    python scripts/workshop_stand/capture_serve.py [--mode baseline] [--stage e00-before] [--only ID,ID]

Expands ``capture_plan.json`` into shots (surface × side × width), resolves entity
refs through the stand's ``mapping.json``, signs in to the stand, and serves the job
to ``capture.js`` on 127.0.0.1:8199 — so the token never appears in anyone's
transcript. Collects each shot's result and, when the runner says it is done,
writes ``temp/ws13/evidence/<stage>/manifest.json`` (path, SHA-256, recipe id,
side, width, mode, Δ, entity pair, DPR, measures, steps) and exits.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import stand  # noqa: E402

PORT = 8199
# A frame overlaps the previous one by this much, so no strip falls between two pictures.
FRAME_OVERLAP = 80
# A safety net, not a sample size: reaching it makes the recipe incomplete (review V02).
FRAME_LIMIT = 40


def plan_offsets(height: int, view: int, *, overlap: int = FRAME_OVERLAP, limit: int = FRAME_LIMIT):
    """Scroll offsets that cover a scroll container of ``height`` seen through ``view``.

    Returns ``(offsets, complete)``: the frames start at 0, overlap each other, and the
    last one ends exactly at the bottom. When the page needs more than ``limit`` frames
    the plan stops there and says so — an incomplete recipe, never a quiet ok."""
    bottom = max(0, height - view)
    if bottom <= 4:
        return [0], True
    step = max(200, view - overlap)
    offsets = list(range(0, bottom, step))
    if offsets[-1] != bottom:
        offsets.append(bottom)
    if len(offsets) > limit:
        return offsets[:limit], False
    return offsets, True


MOCKUP = stand.REPO / "temp" / "proj-ui-work" / "02-mockup-v2.html"
MOCKUP_PREF_KEY = "bamdude-mockup-v2-ui"


def build_job(mode: str, stage: str, only: set[str] | None) -> tuple[dict, dict]:
    plan = json.loads((HERE / "capture_plan.json").read_text(encoding="utf-8"))
    root = stand.check_root(stand.expected_root(mode), mode=mode)
    manifest = stand.read_manifest(root)
    mapping = json.loads((root / "mapping.json").read_text(encoding="utf-8"))
    client = stand.logged_in_client(root, manifest)
    out_dir = stand.REPO / "temp" / "ws13" / "evidence" / stage
    ui = f"http://127.0.0.1:{manifest['ports']['vite']}"

    def resolve(route: str) -> str:
        return re.sub(r"\{([a-z]+:\d+)\}", lambda m: str(mapping[m.group(1)]["id"]), route)

    shots = []
    for surface in plan["surfaces"]:
        if only and surface["id"] not in only:
            continue
        if surface.get("mode", "baseline") != mode:
            continue
        widths = plan["widths"]["wide"] + (plan["widths"]["narrow"] if surface["widths"] == "all" else [])
        for width in widths:
            for side in surface.get("sides", ("mockup", "app")):
                spec = surface[side]
                if side == "app" and spec.get("reuse"):
                    continue  # the same analogue as another surface — referenced, not re-shot
                file = out_dir / side / f"{surface['id']}@{width}.png"
                file.parent.mkdir(parents=True, exist_ok=True)
                if side == "mockup":
                    url = MOCKUP.as_uri() + spec["route"]
                    storage = {MOCKUP_PREF_KEY: json.dumps({"theme": plan["theme"]["mockup"], **spec.get("prefs", {})})}
                else:
                    url = ui + resolve(spec["route"])
                    storage = dict(spec.get("storage", {}))
                shots.append(
                    {
                        "id": surface["id"],
                        "side": side,
                        "width": width,
                        "height": plan["heights"][str(width)],
                        "url": url,
                        "storage": storage,
                        "actions": spec.get("actions", []),
                        "measure": surface["measure"],
                        "file": str(file).replace("\\", "/"),
                    }
                )
    context = {
        "plan": plan,
        "manifest": manifest,
        "mapping": mapping,
        "out_dir": out_dir,
        "stage": stage,
        "mode": mode,
        "only": only,
    }
    return {"token": client.token, "shots": shots}, context


def write_manifest(context: dict, results: list[dict]) -> Path:
    plan, manifest, mapping = context["plan"], context["manifest"], context["mapping"]
    surfaces = {s["id"]: s for s in plan["surfaces"]}
    rows = []
    for r in results:
        surface = surfaces[r["id"]]
        path = Path(r["file"])
        pair = surface.get("pair")
        rows.append(
            {
                "recipe": r["id"],
                "side": r["side"],
                "width": r["width"],
                "file": str(path.relative_to(stand.REPO)).replace("\\", "/") if path.exists() else None,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None,
                "mode": context["mode"],
                "delta_days": manifest.get("delta_days"),
                "pair": {"mockup": pair, "app": mapping.get(pair, {}).get("code") if pair else None},
                "missing": surface["app"].get("missing") if r["side"] == "app" else None,
                "dpr": r.get("dpr"),
                "ok": r.get("ok"),
                "error": r.get("error"),
                "steps": r.get("steps"),
                # Fixed-viewport frames (V02): the first is `file`; each one's layout key was
                # the same before and after the picture as when the measures were taken.
                "stable": r.get("stable"),
                "scroll": r.get("scroll"),
                "frames": [
                    {
                        **frame,
                        "file": str(Path(frame["file"]).relative_to(stand.REPO)).replace("\\", "/"),
                        "sha256": hashlib.sha256(Path(frame["file"]).read_bytes()).hexdigest(),
                    }
                    for frame in r.get("frames") or []
                    if Path(frame["file"]).exists()
                ],
                "measures": r.get("measures"),
            }
        )
    for surface in plan["surfaces"]:
        if surface.get("mode", "baseline") != context["mode"]:
            continue
        if context["only"] and surface["id"] not in context["only"]:
            continue  # a partial job reports only the recipes it was asked for
        if surface["app"].get("reuse"):
            rows.append(
                {
                    "recipe": surface["id"],
                    "side": "app",
                    "missing": surface["app"]["missing"],
                    "same_as": surface["app"]["reuse"],
                }
            )
    caps = context["out_dir"] / "capabilities.json"
    out = context["out_dir"] / "manifest.json"
    out.write_text(
        json.dumps(
            {
                "stage": context["stage"],
                "mode": context["mode"],
                "anchor": manifest.get("anchor"),
                "delta_days": manifest.get("delta_days"),
                "instance_id": manifest.get("instance_id"),
                "mockup": manifest.get("mockup"),
                "capabilities": json.loads(caps.read_text(encoding="utf-8")) if caps.exists() else None,
                "shots": rows,
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", default="baseline")
    parser.add_argument("--stage", default="e00-before")
    parser.add_argument("--only")
    args = parser.parse_args()
    only = set(args.only.split(",")) if args.only else None
    job, context = build_job(args.mode, args.stage, only)
    results: list[dict] = []
    finished = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def _send(self, body: bytes, kind: str = "application/json") -> None:
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path == "/job.json":
                self._send(json.dumps(job).encode())
            else:
                self.send_error(404)

        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            if self.path == "/plan":
                offsets, complete = plan_offsets(int(body["height"]), int(body["view"]))
                self._send(json.dumps({"offsets": offsets, "complete": complete}).encode())
            elif self.path == "/result":
                results.append(body)
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
    print(json.dumps({"serving": f"http://127.0.0.1:{PORT}", "shots": len(job["shots"])}), flush=True)
    finished.wait(timeout=4 * 3600)
    httpd.shutdown()
    out = write_manifest(context, results)
    failed = [r for r in results if not r.get("ok")]
    print(json.dumps({"manifest": str(out), "shots": len(results), "failed": len(failed)}), flush=True)


if __name__ == "__main__":
    main()
