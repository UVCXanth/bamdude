"""Field lengths and the two alias refusals of the product editors (WS-13 E10 A03–A04).

A03 — a value longer than its column used to reach the database: SQLite stores it,
PostgreSQL refuses it with an unhandled error, i.e. a 500. The schemas now bound every
editor field by its column, and a part's FINAL key — ``purchased:`` plus the collapsed
lower-cased name for a purchased part, the canonical lower-cased name for a printed one —
is checked against ``name_key``'s 512 before anything is flushed: lower-casing can grow
a name (``"İ".lower()`` is two characters), and a purchased key carries a 10-character
prefix. On a rename only a purchased part derives a new key; a printed part's key is the
file object's identity and survives the rename, its own alias with it (R12).

A04 — the two alias refusals were ``str(ValueError)`` and so never reached the Ukrainian
catalog; they are the route's own sentences now.
"""

from __future__ import annotations

import pytest

from backend.app.i18n import set_language_cache
from backend.app.models.product import Product, ProductPart

pytestmark = pytest.mark.integration

TOO_LONG = "The part name is too long"


@pytest.fixture
async def product(db_session):
    p = Product(name="Lamp")
    db_session.add(p)
    await db_session.flush()
    shade = ProductPart(
        product_id=p.id, kind="printed", name="shade", name_key="shade.stl", aliases=["shade.stl"], qty_per_unit=1
    )
    screw = ProductPart(product_id=p.id, kind="purchased", name="Screw", name_key="purchased:screw", qty_per_unit=2)
    db_session.add_all([shade, screw])
    await db_session.commit()
    return {"id": p.id, "shade": shade.id, "screw": screw.id}


def _url(product, tail=""):
    return f"/api/v1/products/{product['id']}{tail}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("designer", "d" * 256),
        ("license", "l" * 256),
        ("design_id", "x" * 65),
        ("source_url", "https://example.com/" + "a" * 2030),
    ],
)
async def test_a_card_field_longer_than_its_column_is_a_422_not_a_500(committing_client, product, field, value):
    created = await committing_client.post("/api/v1/products/", json={"name": "Probe", field: value})
    assert created.status_code == 422, created.text
    updated = await committing_client.patch(_url(product), json={field: value})
    assert updated.status_code == 422, updated.text


@pytest.mark.asyncio
async def test_a_card_field_at_its_column_length_is_kept(committing_client, product):
    r = await committing_client.patch(
        _url(product),
        json={
            "designer": "d" * 255,
            "license": "l" * 255,
            "design_id": "x" * 64,
            "source_url": "https://example.com/" + "a" * 2028,
        },
    )
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_a_purchase_link_and_a_duplicate_name_are_bounded_by_their_columns(committing_client, product):
    url = "https://example.com/" + "u" * 493  # 513 characters
    r = await committing_client.post(
        _url(product, "/parts"), json={"kind": "purchased", "name": "Nut", "sourcing_url": url}
    )
    assert r.status_code == 422, r.text
    r = await committing_client.patch(_url(product, f"/parts/{product['screw']}"), json={"sourcing_url": url})
    assert r.status_code == 422, r.text
    r = await committing_client.post(_url(product, "/duplicate"), json={"name": "n" * 256})
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_a_purchased_part_name_is_bounded_by_its_prefixed_key(committing_client, product):
    ok = await committing_client.post(_url(product, "/parts"), json={"kind": "purchased", "name": "b" * 502})
    assert ok.status_code == 200, ok.text
    assert len(ok.json()["name_key"]) == 512
    over = await committing_client.post(_url(product, "/parts"), json={"kind": "purchased", "name": "c" * 503})
    assert over.status_code == 422, over.text
    assert over.json()["detail"] == TOO_LONG
    # A rename re-derives the purchased key — under the same bound.
    renamed = await committing_client.patch(_url(product, f"/parts/{product['screw']}"), json={"name": "d" * 503})
    assert renamed.status_code == 422, renamed.text
    assert renamed.json()["detail"] == TOO_LONG


@pytest.mark.asyncio
async def test_a_printed_part_key_is_checked_after_lower_casing(committing_client, product):
    ok = await committing_client.post(_url(product, "/parts"), json={"kind": "printed", "name": "p" * 512})
    assert ok.status_code == 200, ok.text
    # 300 characters, but lower-cased «İ» is two: a 600-character key.
    grown = await committing_client.post(_url(product, "/parts"), json={"kind": "printed", "name": "İ" * 300})
    assert grown.status_code == 422, grown.text
    assert grown.json()["detail"] == TOO_LONG


@pytest.mark.asyncio
async def test_a_printed_part_keeps_its_key_and_own_alias_on_a_rename(committing_client, product):
    r = await committing_client.patch(_url(product, f"/parts/{product['shade']}"), json={"name": "İ" * 300})
    # The key is not re-derived from the display name, so the long name is fine.
    assert r.status_code == 200, r.text
    assert r.json()["name_key"] == "shade.stl"
    r = await committing_client.patch(
        _url(product, f"/parts/{product['shade']}"), json={"name": "Shade Mk II", "aliases": []}
    )
    assert r.status_code == 200, r.text
    assert (r.json()["name_key"], r.json()["aliases"]) == ("shade.stl", ["shade.stl"])


@pytest.mark.asyncio
async def test_the_two_alias_refusals_are_translated(committing_client, db_session, product):
    other = ProductPart(product_id=product["id"], kind="printed", name="cap", name_key="cap.stl", aliases=["cap.stl"])
    db_session.add(other)
    await db_session.commit()
    taken = await committing_client.post(
        _url(product, f"/parts/{product['shade']}/aliases"), json={"name_key": "cap.stl"}
    )
    assert taken.status_code == 409, taken.text
    assert taken.json()["detail"] == "'cap.stl' already belongs to part 'cap'"
    own = await committing_client.delete(
        _url(product, f"/parts/{product['shade']}/aliases"), params={"name_key": "shade.stl"}
    )
    assert own.status_code == 400, own.text
    english = own.json()["detail"]
    set_language_cache("uk")
    try:
        taken_uk = await committing_client.post(
            _url(product, f"/parts/{product['shade']}/aliases"), json={"name_key": "cap.stl"}
        )
        own_uk = await committing_client.delete(
            _url(product, f"/parts/{product['shade']}/aliases"), params={"name_key": "shade.stl"}
        )
    finally:
        set_language_cache("en")
    assert taken_uk.json()["detail"] != taken.json()["detail"]
    assert "cap.stl" in taken_uk.json()["detail"] and "cap" in taken_uk.json()["detail"]
    assert own_uk.json()["detail"] != english
