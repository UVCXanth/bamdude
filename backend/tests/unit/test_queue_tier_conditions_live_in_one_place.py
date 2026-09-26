"""«Waiting in the queue» is written once (spec workshop-order-queue, rule 5).

An auto-queue row the distributor has not handed out is ``pending`` with no
``assigned_to_item_id``; the order figures, the order's queue section, the
timeline, the plan, the filament needs, the forecast and the rebalancer all ask
that question. Each used to spell it out by hand — they agreed, but only by
care. ``services/order_queue.py`` is where it lives now, and this test fails on
a copy anywhere else.
"""

from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"
HOME = APP / "services" / "order_queue.py"
NEEDLE = "assigned_to_item_id.is_(None)"


def test_the_undistributed_condition_is_written_only_in_order_queue():
    copies = [
        f"{path.relative_to(APP)}:{number}"
        for path in APP.rglob("*.py")
        if path != HOME
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if NEEDLE in line
    ]
    assert copies == [], f"use order_queue.awaiting_auto_row_conditions() instead: {copies}"
    assert NEEDLE in HOME.read_text(encoding="utf-8")
