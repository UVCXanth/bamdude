"""The product page's tab counts (WS-13 E9 A01): «Documents (N)» and «Orders (N)» are the
server's figures, not the length of a list the page happens to hold.

``documents_count`` — the attachments outside the gallery (``pictures`` belong to the
pictures dialog, not the Documents tab). ``orders_count`` — DISTINCT orders with a line
of this product, whatever their status: two lines of one order are one order, and a
cancelled order still names the product.
"""

from __future__ import annotations

import pytest

from backend.app.models.product import Product, ProductPart

pytestmark = pytest.mark.integration


def _attachment(category: str, name: str, source: str = "manual") -> dict:
    return {"category": category, "filename": name, "original_name": name, "sort_order": 0, "source": source}


@pytest.fixture
async def products(db_session):
    lamp = Product(
        name="Lamp",
        attachments=[
            _attachment("pictures", "a.png"),
            _attachment("pictures", "b.png"),
            _attachment("bom_docs", "bom.csv"),
            _attachment("assembly", "steps.pdf", "3mf"),
            _attachment("other", "notes.txt", "import"),
        ],
    )
    other = Product(name="Other")
    db_session.add_all([lamp, other])
    await db_session.flush()
    db_session.add_all(
        [
            ProductPart(product_id=lamp.id, kind="printed", name="shade", name_key="shade", qty_per_unit=1),
            ProductPart(product_id=other.id, kind="printed", name="x", name_key="x", qty_per_unit=1),
        ]
    )
    await db_session.commit()
    return {"lamp": lamp.id, "other": other.id, "part": None}


async def _order(client, name: str, lines: list[dict]) -> int:
    r = await client.post("/api/v1/projects/", json={"name": name, "lines": lines})
    assert r.status_code == 200, r.text
    return r.json()["id"]


@pytest.mark.asyncio
async def test_documents_count_leaves_the_gallery_out(committing_client, products):
    body = (await committing_client.get(f"/api/v1/products/{products['lamp']}")).json()
    assert body["documents_count"] == 3
    assert len(body["attachments"]) == 5
    empty = (await committing_client.get(f"/api/v1/products/{products['other']}")).json()
    assert empty["documents_count"] == 0


@pytest.mark.asyncio
async def test_orders_count_is_distinct_orders_of_any_status(committing_client, products):
    lamp, other = products["lamp"], products["other"]
    assert (await committing_client.get(f"/api/v1/products/{lamp}")).json()["orders_count"] == 0
    # Two lines of the lamp in one order — one order.
    await _order(
        committing_client,
        "Two lines",
        [{"product_id": lamp, "quantity": 2}, {"product_id": lamp, "quantity": 1}],
    )
    # A cancelled order still names the product.
    cancelled = await _order(committing_client, "Cancelled", [{"product_id": lamp, "quantity": 1}])
    r = await committing_client.patch(f"/api/v1/projects/{cancelled}", json={"status": "cancelled"})
    assert r.status_code == 200, r.text
    # Another product's order does not count.
    await _order(committing_client, "Other", [{"product_id": other, "quantity": 1}])
    body = (await committing_client.get(f"/api/v1/products/{lamp}")).json()
    assert body["orders_count"] == 2
    assert (await committing_client.get(f"/api/v1/products/{other}")).json()["orders_count"] == 1


@pytest.mark.asyncio
async def test_the_catalog_list_carries_no_tab_counts(committing_client, products):
    """The two figures are the detail's — the catalog row stays as it was."""
    page = (await committing_client.get("/api/v1/products/", params={"page": 1})).json()
    row = next(item for item in page["items"] if item["id"] == products["lamp"])
    assert "documents_count" not in row and "orders_count" not in row
