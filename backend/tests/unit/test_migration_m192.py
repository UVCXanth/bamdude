"""m192 seeds the two built-in macros of the SwapMod A2L STL (``a2l_stl``).

A swap profile is only usable once its two macros exist: the catalog entry
makes the swap toggle appear on an A2L, and without the seed the printer would
then fire nothing at print start and nothing between plates. Existing installs
get the macros from this seed, fresh ones too — and because ``DEBUG=true``
re-runs the latest migration on every startup, a second run must neither
duplicate them nor put back a sequence the operator has since edited.
"""

import json

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.core.swap_profiles import SWAP_PROFILES
from backend.app.migrations import m192_a2l_swap_profile as m192
from backend.app.models.macro import Macro
from backend.app.models.printer import Printer
from backend.app.services.macro_matcher import find_macros_for_event

_EVENTS = ("swap_mode_start", "swap_mode_change_table")


class _Factory:
    """Async-session factory shim: the migration takes one, not an engine."""

    def __init__(self, session):
        self._session = session

    def __call__(self):
        return self._session


class _Session:
    """Just enough AsyncSession for m192: execute + commit, no ORM."""

    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    async def execute(self, *args, **kwargs):
        return await self._conn.execute(*args, **kwargs)

    async def commit(self):
        pass  # the caller's engine.begin() owns the transaction


async def _engine(path):
    """A database whose ``macros`` table is today's model — what create_all builds."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    async with engine.begin() as conn:
        await conn.run_sync(Macro.__table__.create)
    return engine


async def _seed(engine):
    async with engine.begin() as conn:
        await m192.seed(_Factory(_Session(conn)))


async def _rows(engine) -> list[dict]:
    async with engine.connect() as conn:
        result = await conn.execute(
            text(
                "SELECT name, description, printer_models, swap_mode_only, swap_profile, event, "
                "action_type, delay_seconds, gcode, is_custom, enabled FROM macros ORDER BY id"
            )
        )
        return [dict(row._mapping) for row in result]


@pytest.mark.asyncio
async def test_the_profile_the_seed_serves_is_in_the_catalog():
    # The seed and the catalog name the same profile, for the same model: a
    # seeded macro whose profile no printer can pick would never fire.
    assert m192.PROFILE_ID in SWAP_PROFILES
    assert SWAP_PROFILES[m192.PROFILE_ID]["models"] == ["A2L"]


@pytest.mark.asyncio
async def test_seeds_both_built_in_macros(tmp_path):
    engine = await _engine(tmp_path / "db.sqlite")
    try:
        await _seed(engine)
        rows = await _rows(engine)
    finally:
        await engine.dispose()

    assert [r["event"] for r in rows] == list(_EVENTS)
    for row in rows:
        assert row["swap_profile"] == "a2l_stl"
        assert json.loads(row["printer_models"]) == ["A2L"]
        assert row["swap_mode_only"]
        assert not row["is_custom"]  # built-in: the editor cannot delete it
        assert row["enabled"]
        assert row["action_type"] == "gcode"
        assert row["delay_seconds"] == 0
    assert [r["name"] for r in rows] == ["A2L. STL Edition. Start Sequence", "A2L. STL Edition. Change Table"]


@pytest.mark.asyncio
async def test_the_gcode_is_the_mods_own_without_blank_lines(tmp_path):
    engine = await _engine(tmp_path / "db.sqlite")
    try:
        await _seed(engine)
        start, change = (r["gcode"] for r in await _rows(engine))
    finally:
        await engine.dispose()

    for gcode in (start, change):
        lines = gcode.split("\n")
        assert all(line.strip() for line in lines), "a blank line survived"
        assert all(line == line.rstrip() for line in lines), "trailing whitespace survived"
        # The wrapper adds the claim markers the completion detection keys on;
        # a marker inside the body would end the macro before the plate moved.
        assert "gcode_claim_action" not in gcode

    start_lines = start.split("\n")
    assert start_lines[0] == ";ini swapmod-stl A2L start / v 01-00 20260725"
    assert start_lines[-1] == ";ini end"
    assert len(start_lines) == 37

    change_lines = change.split("\n")
    assert change_lines[0] == "G4 S0"
    assert change_lines[1] == "; swap swapmod-stl A2L start / v 01-00 20260725"
    assert change_lines[-1] == ";swap end"
    assert len(change_lines) == 46

    # Both end on the stock build-plate check, indentation kept as the mod wrote it.
    for lines in (start_lines, change_lines):
        assert "M1002 judge_flag build_plate_detect_flag" in lines
        assert "  G39.4" in lines


@pytest.mark.asyncio
async def test_a_second_run_changes_nothing(tmp_path):
    engine = await _engine(tmp_path / "db.sqlite")
    try:
        await _seed(engine)
        async with engine.begin() as conn:
            await conn.execute(
                text("UPDATE macros SET gcode = 'G28' WHERE swap_profile = 'a2l_stl' AND event = 'swap_mode_start'")
            )
        await _seed(engine)
        rows = await _rows(engine)
    finally:
        await engine.dispose()

    assert len(rows) == 2
    assert rows[0]["gcode"] == "G28"  # the operator's edit stands


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["A2L", "N9", "Bambu Lab A2L"])
async def test_an_a2l_on_the_profile_fires_the_seeded_macros(tmp_path, model):
    engine = await _engine(tmp_path / "db.sqlite")
    try:
        await _seed(engine)
        rows = await _rows(engine)
    finally:
        await engine.dispose()
    macros = [Macro(**row) for row in rows]

    printer = Printer(name="A2L", model=model, swap_mode_enabled=True, swap_profile="a2l_stl")
    for event in _EVENTS:
        assert [m.event for m in find_macros_for_event(event, printer, macros)] == [event]

    # Not on another profile of the same model, and not with swap off.
    other = Printer(name="A2L", model=model, swap_mode_enabled=True, swap_profile="another")
    off = Printer(name="A2L", model=model, swap_mode_enabled=False, swap_profile="a2l_stl")
    for event in _EVENTS:
        assert find_macros_for_event(event, other, macros) == []
        assert find_macros_for_event(event, off, macros) == []
