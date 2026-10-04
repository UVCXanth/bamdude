"""A product's files stay what they are (WS-13 E13 E03).

Pictures and documents read out of a library 3MF are COPIES in the product's own
directory: deleting one never touches the library file it came from. Reordering
the gallery and choosing another cover rewrite an order and a pointer — never an
attachment: every stored name stays, and so does the cover that was chosen.
"""

from __future__ import annotations

import pytest

from backend.app.models.library import LibraryFile
from backend.app.services.product_files import product_attachments_dir
from backend.tests.integration.test_library_card_api import make_card_file

pytestmark = pytest.mark.integration


async def _card_product(client, db, tmp_path):
    file = await make_card_file(db, tmp_path)
    body = (await client.post(f"/api/v1/products/from-file/{file.id}")).json()["product"]
    return file, body


def _names(attachments: list[dict]) -> dict[str, str]:
    """stored name → original name, over every category."""
    return {a["filename"]: a["original_name"] for a in attachments}


@pytest.mark.asyncio
async def test_deleting_an_attachment_read_out_of_a_3mf_leaves_the_library_file(
    committing_client, db_session, tmp_path
):
    file, product = await _card_product(committing_client, db_session, tmp_path)
    from_3mf = [a for a in product["attachments"] if a["source"] == "3mf" and a["source_file_id"] == file.id]
    assert from_3mf, "the card file brings its designer's files"
    gone = from_3mf[0]

    r = await committing_client.delete(f"/api/v1/products/{product['id']}/attachments/{gone['filename']}")
    assert r.status_code == 200, r.text

    assert not (product_attachments_dir(product["id"]) / gone["filename"]).exists(), "the copy goes"
    row = await db_session.get(LibraryFile, file.id, populate_existing=True)
    assert row is not None and row.deleted_at is None, "the library row stays"
    assert (tmp_path / row.file_path).exists(), "and so do its bytes"


@pytest.mark.asyncio
async def test_reordering_the_gallery_keeps_every_attachment_and_the_chosen_cover(
    committing_client, db_session, tmp_path
):
    _file, product = await _card_product(committing_client, db_session, tmp_path)
    pid = product["id"]
    pictures = sorted((a for a in product["attachments"] if a["category"] == "pictures"), key=lambda a: a["sort_order"])
    assert len(pictures) >= 2
    chosen = pictures[1]["filename"]
    assert (
        await committing_client.put(f"/api/v1/products/{pid}/cover-image", json={"filename": chosen})
    ).status_code == 200

    before = _names(product["attachments"])
    reversed_order = [p["filename"] for p in reversed(pictures)]
    r = await committing_client.patch(
        f"/api/v1/products/{pid}/attachments/order", json={"category": "pictures", "filenames": reversed_order}
    )
    assert r.status_code == 200, r.text

    after = (await committing_client.get(f"/api/v1/products/{pid}")).json()
    assert _names(after["attachments"]) == before, "no attachment is renamed, added or lost"
    assert [
        a["filename"]
        for a in sorted((a for a in after["attachments"] if a["category"] == "pictures"), key=lambda a: a["sort_order"])
    ] == reversed_order
    assert after["cover_image_filename"] == chosen, "the chosen cover stays chosen"
    for name in before:
        assert (product_attachments_dir(pid) / name).exists()


@pytest.mark.asyncio
async def test_choosing_another_cover_keeps_every_attachment_in_its_place(committing_client, db_session, tmp_path):
    _file, product = await _card_product(committing_client, db_session, tmp_path)
    pid = product["id"]
    pictures = sorted((a for a in product["attachments"] if a["category"] == "pictures"), key=lambda a: a["sort_order"])
    order_before = [(a["filename"], a["sort_order"]) for a in pictures]

    for picture in reversed(pictures):
        r = await committing_client.put(f"/api/v1/products/{pid}/cover-image", json={"filename": picture["filename"]})
        assert r.status_code == 200, r.text
        after = (await committing_client.get(f"/api/v1/products/{pid}")).json()
        assert after["cover_image_filename"] == picture["filename"]
        assert _names(after["attachments"]) == _names(product["attachments"])
        assert [
            (a["filename"], a["sort_order"])
            for a in sorted(
                (a for a in after["attachments"] if a["category"] == "pictures"), key=lambda a: a["sort_order"]
            )
        ] == order_before
