"""Weight-split math for a slot that more than one reel fed during one print.

The boundaries come from two places — the tray chronology (``state.tray_change_log``,
projected by ``usage_attribution.feed_intervals``) and the runout journal of one tray
(``usage_tracker.journal_boundaries_for_tray``) — and both inventory writers
(``usage_tracker.py`` and ``spoolman_tracking.py``) divide a slot's weight across them here,
so the two cannot drift: #1793 came from ``spoolman_tracking`` never carrying the split at
all. Each caller wraps its own "resolve the reel → charge N grams" side effect.

What is divided is a weight the CALLER has already determined — for a print that did not
finish, already the partial weight. This module never shortens it again: it only says which
share of it each boundary's stretch printed, up to the layer the print reached (spec
partial-print-layer-split r2). Where that cannot be said from what the printer reported, the
answer is ``None`` — never an equal share and never a remainder handed to the last reel.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Mapping
from dataclasses import dataclass

# Qualified-name access (``threemf_tools.get_cumulative_usage_at_layer(...)`` rather than
# ``from … import …``) so ``unittest.mock.patch`` on the threemf_tools module lands in the
# helper too.
from backend.app.utils import threemf_tools

logger = logging.getLogger(__name__)

#: The printer's own figures at the terminal frame, copied into the completion event by
#: ``bambu_mqtt`` (O5, owner 2026-10-26). The writers run after a file analysis and a
#: deferred terminal can be replayed later still; by then the live state may describe the
#: NEXT print, so the event carries the finished print's figures and nothing re-reads them.
TERMINAL_LAYER_NUM = "terminal_layer_num"
TERMINAL_TOTAL_LAYERS = "terminal_total_layers"
TERMINAL_PROGRESS = "terminal_progress"


def terminal_snapshot_fields(*, layer_num, total_layers, progress) -> dict[str, object]:
    """The completion event's copy of the printer's figures — scalars, never the live state."""
    return {TERMINAL_LAYER_NUM: layer_num, TERMINAL_TOTAL_LAYERS: total_layers, TERMINAL_PROGRESS: progress}


def _observed_layer(value) -> int | None:
    """A positive layer number the printer reported, or None.

    A coercion is not evidence: ``True`` is not layer 1 and ``"50"`` is not layer 50. Zero is
    a reset or a field never filled, not "nothing was printed".
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not (math.isfinite(value) and value.is_integer()):
        return None
    layer = int(value)
    return layer if layer > 0 else None


def _observed_progress(value) -> float | None:
    """A positive progress percentage the printer reported, or None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    progress = float(value)
    return progress if math.isfinite(progress) and progress > 0 else None


@dataclass(frozen=True)
class CompletionSnapshot:
    """What the completion event says about how far the finished print got.

    ``layer_num`` / ``total_layers`` / ``progress`` are the terminal frame's figures;
    ``captured_*`` are the last positive values the MQTT client kept before the firmware
    reset them (``last_layer_num`` / ``last_progress``). Every field is None when the event
    does not carry it — a missing figure stays unknown, it is never read off the printer now.
    """

    layer_num: int | None = None
    total_layers: int | None = None
    progress: float | None = None
    captured_layer: int | None = None
    captured_progress: float | None = None

    @classmethod
    def from_event(cls, data: Mapping | None) -> CompletionSnapshot:
        data = data or {}
        return cls(
            layer_num=_observed_layer(data.get(TERMINAL_LAYER_NUM)),
            total_layers=_observed_layer(data.get(TERMINAL_TOTAL_LAYERS)),
            progress=_observed_progress(data.get(TERMINAL_PROGRESS)),
            captured_layer=_observed_layer(data.get("last_layer_num")),
            captured_progress=_observed_progress(data.get("last_progress")),
        )

    @property
    def progress_percent(self) -> float | None:
        """The terminal frame's progress, else the captured one."""
        return self.progress or self.captured_progress


@dataclass(frozen=True)
class PrintedBound:
    """The layer a print's weight may be divided up to (H), and where it came from.

    ``layer`` None means no observed boundary. ``total_layers`` is the plate's layer count
    (L) when the event knew it — for a print that did not finish it bounds H, it never is H.
    """

    completed: bool
    layer: int | None
    source: str
    total_layers: int | None = None


def printed_bound(*, completed: bool, snapshot: CompletionSnapshot) -> PrintedBound:
    """Choose H once per completion, from the event alone (spec r2 R2).

    Completed: the plate's layer count, else the terminal layer, else the captured one. A
    captured layer that lags the finish (L−1) never shortens a known L.
    Partial: the terminal layer, else — when the firmware zeroed it — the captured one. L,
    the largest journal boundary and a full G-code timeline say nothing about where a
    stopped print stopped; neither does a layer estimated from the progress percentage. A
    layer beyond a known L is not evidence of anything, so it is no boundary at all.
    """
    total = snapshot.total_layers
    if completed:
        if total:
            return PrintedBound(True, total, "total_layers", total)
        for source, layer in (("current", snapshot.layer_num), ("captured", snapshot.captured_layer)):
            if layer:
                return PrintedBound(True, layer, source)
        return PrintedBound(True, None, "none")
    for source, layer in (("current", snapshot.layer_num), ("captured", snapshot.captured_layer)):
        if layer:
            if total and layer > total:
                logger.info(
                    "[TraySplit] %s layer %d is past the plate's %d layers — no printed boundary", source, layer, total
                )
                return PrintedBound(False, None, f"{source}_past_total", total)
            return PrintedBound(False, layer, source, total)
    return PrintedBound(False, None, "none", total)


@dataclass(frozen=True)
class WeightSplit:
    """A slot's weight divided between its boundaries.

    ``grams[i]`` belongs to the stretch that starts at the i-th boundary. ``unknown_start``
    is the share printed before the first boundary — a stretch no boundary names, so it is
    nobody's. Together they add up to the weight that was divided.
    """

    grams: list[float]
    unknown_start: float = 0.0


def _boundaries_are_usable(boundary_layers: list) -> bool:
    previous = 0
    for layer in boundary_layers:
        if isinstance(layer, bool) or not isinstance(layer, int) or layer < previous:
            return False
        previous = layer
    return True


def _gcode_scale(layer_usage, filament_id: int, bound: PrintedBound):
    """The slot's own G-code timeline as a fraction function of the layer, or None.

    Completed: the whole timeline of the slot (it printed to the end; no H is needed).
    Partial: the timeline up to H, so the fractions describe what was actually printed.
    Usable only with this slot's positive cumulative extrusion; another slot's data is no
    scale for this one.
    """
    if not layer_usage:
        return None
    final = layer_usage.get(max(layer_usage), {}).get(filament_id, 0)
    if not final or final <= 0:
        return None

    def cumulative(layer: int) -> float:
        return threemf_tools.get_cumulative_usage_at_layer(layer_usage, layer).get(filament_id, 0)

    if bound.completed:
        return lambda layer: 0.0 if layer <= 0 else min(cumulative(layer) / final, 1.0)
    if bound.layer is None:
        return None
    horizon = bound.layer
    printed = cumulative(horizon)
    if printed <= 0:
        return None
    return lambda layer: 0.0 if layer <= 0 else min(cumulative(min(layer, horizon)) / printed, 1.0)


def split_weight(
    boundary_layers: list[int],
    total_weight: float,
    slot_id: int,
    layer_usage: dict[int, dict[int, float]] | None,
    bound: PrintedBound,
) -> WeightSplit | None:
    """Divide ``total_weight`` between the stretches starting at ``boundary_layers``.

    The slot's own G-code timeline measures each stretch when it is usable (``_gcode_scale``);
    otherwise the layer ratio within ``[0, H]``: ``total_weight × clipped length / H``. A
    stretch that starts at H or later printed nothing of this weight. A boundary list that
    is not a non-decreasing run of layer numbers is no geometry to divide by.

    Returns None when nothing reported tells how to divide — the caller then charges a
    single proven owner or reports the weight not recorded (R6). A single stretch from
    layer 0 is the whole weight without any H.
    """
    if not boundary_layers:
        return WeightSplit([])
    if not _boundaries_are_usable(boundary_layers):
        return None
    weight = float(total_weight)
    if len(boundary_layers) == 1 and boundary_layers[0] == 0:
        return WeightSplit([weight])

    fraction = _gcode_scale(layer_usage, slot_id - 1, bound)
    points = [fraction(layer) for layer in boundary_layers] if fraction is not None else None
    if points is not None and any(later < earlier for earlier, later in zip(points, points[1:], strict=False)):
        points = None  # a timeline that runs backwards measures nothing
    if points is None:
        if bound.layer is None:
            return None
        horizon = bound.layer
        points = [min(layer, horizon) / horizon for layer in boundary_layers]

    edges = [*points, 1.0]
    shares = [edges[i + 1] - edges[i] for i in range(len(boundary_layers))]
    unknown_share = points[0]
    grams = [weight * share for share in shares]
    unknown = weight * unknown_share

    # Float drift goes to the last stretch that really printed something — never to a
    # stretch past the boundary, which would take another reel's grams.
    positive = [i for i, share in enumerate(shares) if share > 0]
    if positive:
        last = positive[-1]
        grams[last] = weight - unknown - sum(g for i, g in enumerate(grams) if i != last)
    elif unknown_share > 0:
        unknown = weight
    return WeightSplit(grams, unknown)


def sole_owner(stretches: list[tuple[int, object]]) -> object | None:
    """The one reel that provably fed the whole print, or None (R6).

    ``stretches`` is ``[(start_layer, proven identity)]`` in order; None is an identity
    nobody proved. Several stretches of the same reel are one owner — but only when they
    cover the print from layer 0: what came before the first one is nobody's to give it.
    """
    if not stretches or stretches[0][0] != 0 or any(owner is None for _, owner in stretches):
        return None
    first = stretches[0][1]
    return first if all(owner == first for _, owner in stretches) else None
