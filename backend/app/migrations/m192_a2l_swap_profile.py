"""Seed the built-in macros of the SwapMod A2L STL swap profile (``a2l_stl``).

The A2L plate swapper comes from the author of the A1 Mini STL edition
(swap-systems.com, "SwapMod A2L STL"). Its sequences were extracted from a
sliced plate the author's tool processed: the tool puts one block in front of
the printer's start G-code and another after every copy of the print, so they
map onto our two swap events — ``swap_mode_start`` fires before
``start_print``, ``swap_mode_change_table`` after a completed print. The text
is the mod's own (tag ``v 01-00 20260725``) with blank lines and trailing
whitespace dropped; it carries no ``M1002 gcode_claim_action`` because
``macro_executor.wrap_macro_gcode`` adds the markers completion is read from.

The profile itself is a catalog entry (``core/swap_profiles.py``); this seed
gives existing installs and fresh ones the two macros it needs. Same shape as
m005's: raw SQL with an explicit column list, idempotent on
``(swap_profile, event)`` — ``DEBUG=true`` re-runs the latest migration, and a
second run must neither duplicate the macros nor overwrite an operator's edit.

No printer is moved onto the profile: swap mode could not be switched on for
an A2L before the catalog listed one, and the operator picks the profile in
the printer form, as m005 left the full-size A1 to do.
"""

from __future__ import annotations

import json
import logging

from sqlalchemy import text

logger = logging.getLogger(__name__)

version = 192
name = "a2l_swap_profile"

PROFILE_ID = "a2l_stl"
_MODELS = ["A2L"]
_TAG = "swapmod-stl A2L / v 01-00 20260725"

_START_GCODE = "\n".join(
    [
        ";ini swapmod-stl A2L start / v 01-00 20260725",
        "G0 Z30",
        "G28 X Y",
        "G0 X-40 F8000",
        "G0 Y-1 F3000",
        "G0 Y50 F1000",
        "G0 Y290 F5000",
        "G0 Y265 F1000",
        "G0 Y334 F3000",
        "G0 Y-1 F3000",
        "G0 Y25 F5000",
        "G0 Y-1 F5000",
        "G0 Y20 F300",
        "G0 Y-1 F1000",
        "G0 Y20 F1000",
        "G0 Y160 F8000",
        "G28",
        ";===== detection start =====",
        ";===== build_plate_detect_flag start =====",
        "M1002 judge_flag build_plate_detect_flag",
        "M622 S1",
        "  G91",
        "  G1 Z5 F1200",
        "  G90",
        "  G0 X15 F30000",
        "  G0 Y319 F3000",
        "  G91",
        "  G1 Z-5 F1200",
        "  G28 Z P0 T140",
        "  G1 F1200",
        "  G39.4",
        "  G90",
        "  G1 Z5 F1200",
        "M623",
        ";===== build_plate_detect_flag end =====",
        ";===== detection end =====",
        ";ini end",
    ]
)

_CHANGE_TABLE_GCODE = "\n".join(
    [
        "G4 S0",
        "; swap swapmod-stl A2L start / v 01-00 20260725",
        "G0 X-40 F8000",
        "G0 Y305 F8000",
        "G0 Y333 F1500",
        "G0 Z20 F10000",
        "G0 Z-20 F10000",
        "G0 Y300 F500",
        "G0 Z320 F10000",
        "G0 Y-1 F500",
        "G0 Y50 F1000",
        "G0 Y290 F5000",
        "G0 Y265 F1000",
        "G0 Y170 F5000",
        "G0 Y10 Z20 F1000",
        "G0 Y334 F3000",
        "G0 Y-1 F3000",
        "G0 Y25 F5000",
        "G0 Y-1 F5000",
        "G0 Y20 F300",
        "G0 Y-1 F1000",
        "G0 Y20 F1000",
        "G0 Y305 F8000",
        "G0 Y333 F500",
        "G0 Y120 F8000",
        "G28 X Y",
        ";===== detection start =====",
        ";===== build_plate_detect_flag start =====",
        "M1002 judge_flag build_plate_detect_flag",
        "M622 S1",
        "  G91",
        "  G1 Z5 F1200",
        "  G90",
        "  G0 X15 F30000",
        "  G0 Y319 F3000",
        "  G91",
        "  G1 Z-5 F1200",
        "  G28 Z P0 T140",
        "  G1 F1200",
        "  G39.4",
        "  G90",
        "  G1 Z5 F1200",
        "M623",
        ";===== build_plate_detect_flag end =====",
        ";===== detection end =====",
        ";swap end",
    ]
)

_SEEDS: list[dict] = [
    {
        "name": "A2L. STL Edition. Start Sequence",
        "description": f"{_TAG} - initial plate seating before the first print.",
        "event": "swap_mode_start",
        "gcode": _START_GCODE,
    },
    {
        "name": "A2L. STL Edition. Change Table",
        "description": f"{_TAG} - swaps the finished plate out for a fresh one between prints.",
        "event": "swap_mode_change_table",
        "gcode": _CHANGE_TABLE_GCODE,
    },
]


async def seed(session_factory):
    """Insert each built-in macro unless its ``(swap_profile, event)`` is already there."""
    async with session_factory() as db:
        seeded = 0
        for spec in _SEEDS:
            existing = (
                await db.execute(
                    text("SELECT id FROM macros WHERE swap_profile = :sp AND event = :ev LIMIT 1"),
                    {"sp": PROFILE_ID, "ev": spec["event"]},
                )
            ).scalar_one_or_none()
            if existing is not None:
                continue
            await db.execute(
                text(
                    "INSERT INTO macros "
                    "(name, description, printer_models, swap_mode_only, swap_profile, "
                    "event, gcode, is_custom, enabled) "
                    "VALUES (:name, :description, :printer_models, TRUE, :swap_profile, "
                    ":event, :gcode, FALSE, TRUE)"
                ),
                {
                    "name": spec["name"],
                    "description": spec["description"],
                    "printer_models": json.dumps(_MODELS),
                    "swap_profile": PROFILE_ID,
                    "event": spec["event"],
                    "gcode": spec["gcode"],
                },
            )
            seeded += 1

        if seeded:
            logger.info("m192: seeded %d built-in macro(s) for swap profile %s", seeded, PROFILE_ID)

        await db.commit()
