"""The colour map carries the names a flat hex lookup loses (upstream 39010432, #2875).

A hex is not one colour in Bambu's range: #FFFFFF is Jade White in PLA Basic and
Ivory White in PLA Matte. ``/colors/map`` keeps one name per hex, so an ivory Matte
slot read "Jade White". ``by_material`` ("<material>|<hex>") carries only the
names the same manufacturer's own range lost; the AMS slot looks it up with
its ``tray_sub_brands`` first.
"""

import pytest
from httpx import AsyncClient

from backend.app.models.color_catalog import ColorCatalogEntry


async def _seed(db_session, entries):
    for kwargs in entries:
        db_session.add(ColorCatalogEntry(**kwargs))
    await db_session.commit()


@pytest.mark.asyncio
@pytest.mark.integration
async def test_by_material_keeps_the_name_collapsing_loses(async_client: AsyncClient, db_session):
    """#2875: a hex is not one colour.

    #FFFFFF is Jade White in PLA Basic and Ivory White in PLA Matte. Both are
    Bambu Lab and both are seeded defaults, so the flat map's priority order
    cannot separate them and falls back to insertion order -- which is why an
    ivory spool showed as "Jade White" on the AMS slot popover. The material-
    qualified map carries the name the flat one has to drop.
    """
    await _seed(
        db_session,
        [
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Jade White",
                "hex_color": "#FFFFFF",
                "material": "PLA Basic",
                "is_default": True,
            },
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Ivory White",
                "hex_color": "#FFFFFF",
                "material": "PLA Matte",
                "is_default": True,
            },
        ],
    )
    body = (await async_client.get("/api/v1/inventory/colors/map")).json()

    assert body["colors"]["ffffff"] == "Jade White"
    assert body["by_material"]["pla matte|ffffff"] == "Ivory White"
    # The row the flat map already answers correctly is not repeated.
    assert "pla basic|ffffff" not in body["by_material"]


@pytest.mark.asyncio
@pytest.mark.integration
async def test_by_material_is_empty_when_nothing_is_ambiguous(async_client: AsyncClient, db_session):
    """The qualified map costs only what the ambiguity costs.

    It ships on every page load beside the full catalog, so an entry that says
    the same thing as the flat map is pure weight.
    """
    await _seed(
        db_session,
        [
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Scarlet Red",
                "hex_color": "#DE4343",
                "material": "PLA Matte",
                "is_default": True,
            },
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Cherry Pink",
                "hex_color": "#F5B6CD",
                "material": "PLA Translucent",
                "is_default": True,
            },
        ],
    )
    body = (await async_client.get("/api/v1/inventory/colors/map")).json()

    assert len(body["colors"]) == 2
    assert body["by_material"] == {}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_by_material_keys_are_normalized(async_client: AsyncClient, db_session):
    """Same normalization as the flat map: lowercase, no '#'.

    The frontend builds the lookup key from the printer's own
    ``tray_sub_brands`` ("PLA Matte"), so both halves have to be case-folded
    or the slot that needs this most never matches.
    """
    await _seed(
        db_session,
        [
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Black",
                "hex_color": "#000000",
                "material": "PLA Basic",
                "is_default": True,
            },
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Charcoal",
                "hex_color": "000000",
                "material": "PLA Matte",
                "is_default": True,
            },
        ],
    )
    body = (await async_client.get("/api/v1/inventory/colors/map")).json()

    assert body["by_material"] == {"pla matte|000000": "Charcoal"}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_by_material_respects_the_same_priority_as_the_flat_map(async_client: AsyncClient, db_session):
    """Two brands can share a hex *and* a material name. Bambu still wins.

    The PLA Basic row comes first so the flat map keeps Jade White -- otherwise
    the Matte answer would already be the flat one and the qualified entry
    would be dropped as a duplicate, which proves nothing about the tie-break.
    """
    await _seed(
        db_session,
        [
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Jade White",
                "hex_color": "#FFFFFF",
                "material": "PLA Basic",
                "is_default": True,
            },
            {
                "manufacturer": "Generic",
                "color_name": "Off White",
                "hex_color": "#FFFFFF",
                "material": "PLA Matte",
                "is_default": False,
            },
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Ivory White",
                "hex_color": "#FFFFFF",
                "material": "PLA Matte",
                "is_default": True,
            },
        ],
    )
    body = (await async_client.get("/api/v1/inventory/colors/map")).json()

    assert body["colors"]["ffffff"] == "Jade White"
    assert body["by_material"]["pla matte|ffffff"] == "Ivory White"


@pytest.mark.asyncio
@pytest.mark.integration
async def test_rows_without_a_material_stay_out_of_the_qualified_map(async_client: AsyncClient, db_session):
    """A row with no material cannot answer a material-qualified question."""
    await _seed(
        db_session,
        [
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Jade White",
                "hex_color": "#FFFFFF",
                "material": "PLA Basic",
                "is_default": True,
            },
            {
                "manufacturer": "Generic",
                "color_name": "Some White",
                "hex_color": "#FFFFFF",
                "material": None,
                "is_default": False,
            },
        ],
    )
    body = (await async_client.get("/api/v1/inventory/colors/map")).json()

    assert body["by_material"] == {}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_by_material_does_not_hand_one_brands_name_to_another(async_client: AsyncClient, db_session):
    """A qualified entry must recover a name, not substitute one.

    The shipped catalog has Prusament "Pristine White" under material "PLA" on
    the same #FFFFFF that Bambu's "Jade White" holds. A slot reporting plain
    "PLA" — any third-party spool — would otherwise stop saying Jade White and
    start saying Pristine White, trading one arbitrary answer for another for a
    case nobody asked about. Only same-manufacturer recoveries are emitted.
    """
    await _seed(
        db_session,
        [
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Jade White",
                "hex_color": "#FFFFFF",
                "material": "PLA Basic",
                "is_default": True,
            },
            {
                "manufacturer": "Prusament",
                "color_name": "Pristine White",
                "hex_color": "#FFFFFF",
                "material": "PLA",
                "is_default": True,
            },
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Ivory White",
                "hex_color": "#FFFFFF",
                "material": "PLA Matte",
                "is_default": True,
            },
        ],
    )
    body = (await async_client.get("/api/v1/inventory/colors/map")).json()

    assert body["colors"]["ffffff"] == "Jade White"
    # The Bambu variant is recovered; the other brand's name is not offered.
    assert body["by_material"] == {"pla matte|ffffff": "Ivory White"}


@pytest.mark.asyncio
@pytest.mark.integration
async def test_a_material_containing_the_separator_is_still_read_correctly(async_client: AsyncClient, db_session):
    """Material is free text — users edit the catalog — so it can contain '|'.

    The hex is everything after the LAST separator, never the first.
    """
    await _seed(
        db_session,
        [
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Jade White",
                "hex_color": "#FFFFFF",
                "material": "PLA Basic",
                "is_default": True,
            },
            {
                "manufacturer": "Bambu Lab",
                "color_name": "Ivory White",
                "hex_color": "#FFFFFF",
                "material": "PLA|Matte",
                "is_default": True,
            },
        ],
    )
    body = (await async_client.get("/api/v1/inventory/colors/map")).json()

    assert body["by_material"] == {"pla|matte|ffffff": "Ivory White"}
