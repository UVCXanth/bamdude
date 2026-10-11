"""Model catalog, compatible routing and additive migration invariants."""

import pytest
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from backend.app.migrations.m199_order_print_options import upgrade
from backend.app.schemas.order_print_options import OrderPrintOptions, capabilities
from backend.app.services.order_print_options import override_options


def options(**updates):
    return {
        "bed_levelling": "on",
        "flow_cali": "off",
        "layer_inspect": False,
        "timelapse": False,
        "mesh_mode_fast_check": True,
        "gcode_injection": False,
        "nozzle_offset_cali": "off",
        **updates,
    }


def test_known_function_and_auto_mode_are_independent():
    mini, p1, h2, p2 = map(capabilities, ["A1 Mini", "C12", "H2D", "P2S"])
    assert mini["supported"]["flow_cali"] and not mini["auto"]["flow_cali"]
    assert not p1["supported"]["flow_cali"]
    assert h2["supported"]["nozzle_offset_cali"] and h2["auto"]["nozzle_offset_cali"]
    assert p2["auto"]["bed_levelling"] and p2["auto"]["flow_cali"]
    assert not capabilities("Unknown")["known"]


def test_compatible_target_does_not_replace_source_choices():
    snapshot = {"P1S": options(bed_levelling="off"), "P2S": options(bed_levelling="auto")}
    assert override_options(snapshot, "C12", "P2S")["bed_levelling"] == "off"
    # A real file/model change by rebalance now selects the P2S entry.
    assert override_options(snapshot, "P2S", "P2S")["bed_levelling"] == "auto"
    assert override_options(snapshot, "A1 Mini") == {}
    with pytest.raises(ValidationError):
        override_options(snapshot, "P2S", "P1S")  # No silently downgraded auto.


def test_missing_snapshot_is_the_unchanged_profile_path():
    assert override_options(None, "P1S") == {}
    assert override_options({}, "P1S") == {}
    with pytest.raises(ValidationError):
        OrderPrintOptions(overrides={"P1S": options(flow_cali="on")})


@pytest.mark.asyncio
async def test_migration_on_existing_rows_is_idempotent_and_does_not_backfill():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as conn:
            for table in ("projects", "auto_queue_items"):
                await conn.execute(text(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY)"))
                await conn.execute(text(f"INSERT INTO {table} (id) VALUES (1)"))
            await upgrade(conn)
            await upgrade(conn)
            for table in ("projects", "auto_queue_items"):
                assert (
                    await conn.execute(text(f"SELECT order_print_options FROM {table} WHERE id=1"))
                ).scalar() is None
    finally:
        await engine.dispose()
