"""Every router that masks by ``workshop_view`` binds the request's credentials (WS-13 E13 O12).

``workshop_view()`` answers from the credentials ``bind_workshop_credentials`` puts in the request's
context; with none bound it is the server's own caller (a task, a broadcast) and sees everything.
A route module that reads the view must therefore bind them on its router — or its masks are
silently off for every caller. The final review asked for the binding to be asserted; this is it.
"""

import re
from pathlib import Path

ROUTES = Path(__file__).resolve().parents[2] / "app" / "api" / "routes"
BOUND = re.compile(r"router\s*=\s*APIRouter\([^)]*dependencies=\[[^\]]*Depends\(bind_workshop_credentials\)", re.S)


def test_every_router_that_reads_the_view_binds_the_credentials():
    readers = [
        p for p in ROUTES.glob("*.py") if p.name != "_workshop_rights.py" and "workshop_view()" in p.read_text("utf-8")
    ]
    assert readers, "no route reads the view — the scan is looking in the wrong place"
    unbound = [p.name for p in readers if not BOUND.search(p.read_text("utf-8"))]
    assert unbound == []


def test_the_scan_sees_a_binding():
    assert BOUND.search('router = APIRouter(prefix="/x", dependencies=[Depends(bind_workshop_credentials)])')
    assert not BOUND.search('router = APIRouter(prefix="/x", tags=["x"])')
