"""Where each part of a product can be printed from, and the product's files (WS-13 E1 PS, K3, K5, K7, LV4).

A part's sources are the plates that make it: sliced ones in the plan's own order
(``plan_engine.rank_key``) with the first recommended, unsliced ones after. A file
the caller may not see in the library keeps its numbers — model, plate, yield, time,
grams (Z7) — and loses its name and folder (``hidden``).
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from backend.app.core.auth import create_access_token
from backend.app.core.permissions import Permission
from backend.app.models.group import Group
from backend.app.models.library import LibraryFile, LibraryFolder
from backend.app.models.product import Product, ProductPart
from backend.app.models.user import User
from backend.app.services.product_sync import sync_product_for_file

pytestmark = pytest.mark.integration

_READ = Permission.PROJECTS_READ.value


async def _user(db, username: str, permissions: list[str]) -> User:
    group = Group(name=f"grp-{username}", description="test", permissions=permissions)
    db.add(group)
    await db.flush()
    user = User(username=username, email=f"{username}@example.com", password_hash="x", role="user", is_active=True)
    user.groups.append(group)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


def _sliced(model: str, objects: dict[str, str], seconds: int, grams: float) -> dict:
    return {
        "sliced_for_model": model,
        "plates": [
            {
                "index": 1,
                "printable_objects": objects,
                "print_time_seconds": seconds,
                "filament_used_grams": grams,
                "filaments": [{"type": "PETG", "color": "#000000"}],
            }
        ],
    }


@pytest.fixture
async def hanger(db_session):
    """«Hanger»: parts hook and bar.
    - p1s — sliced for P1S, 2 hooks + 1 bar per hour, in folder «Shelf A», somebody else's;
    - x1c — sliced for X1C, 4 hooks per hour, the reader-own user's;
    - raw — an unsliced 3MF project with one hook, ownerless;
    - stl — a bare STL, the reader-own user's, no plates at all;
    - gone — sliced, trashed: never listed."""
    reader_all = await _user(db_session, "ps_all", [_READ, Permission.LIBRARY_READ_ALL.value])
    reader_own = await _user(db_session, "ps_own", [_READ, Permission.LIBRARY_READ_OWN.value])
    await _user(db_session, "ps_none", [_READ])
    folder = LibraryFolder(name="Shelf A")
    product = Product(name="Hanger")
    db_session.add_all([folder, product])
    await db_session.flush()
    specs = {
        "p1s": (
            "hanger-p1s.gcode.3mf",
            "gcode",
            _sliced("P1S", {"1": "hook.stl", "2": "hook.stl_2", "3": "bar.stl"}, 3600, 20.0),
            reader_all.id,
            folder.id,
        ),
        "x1c": (
            "hanger-x1c.gcode.3mf",
            "gcode",
            _sliced("X1C", {str(i): "hook.stl" if i == 1 else f"hook.stl_{i}" for i in range(1, 5)}, 3600, 30.0),
            reader_own.id,
            None,
        ),
        "raw": (
            "hanger-raw.3mf",
            "3mf",
            {"has_sliced_gcode": False, "plates": [{"index": 1, "printable_objects": {"1": "hook.stl"}}]},
            None,
            None,
        ),
        "stl": ("hanger.stl", "stl", {}, reader_own.id, None),
        "gone": ("hanger-gone.gcode.3mf", "gcode", _sliced("A1", {"1": "hook.stl"}, 60, 1.0), reader_own.id, None),
    }
    files = {}
    for label, (filename, file_type, meta, owner, folder_id) in specs.items():
        f = LibraryFile(
            filename=filename,
            file_path=filename,
            file_size=1,
            file_type=file_type,
            file_metadata=meta,
            created_by_id=owner,
            folder_id=folder_id,
        )
        db_session.add(f)
        await db_session.flush()
        await sync_product_for_file(db_session, library_file_id=f.id, product_ids=[product.id])
        files[label] = f.id
    (await db_session.get(LibraryFile, files["gone"])).deleted_at = datetime.now(UTC)
    await db_session.commit()
    parts = {
        p.name_key.removesuffix(".stl"): p.id
        for p in (await db_session.execute(ProductPart.__table__.select().where(ProductPart.product_id == product.id)))
    }
    return {"product": product.id, "files": files, "parts": parts, "folder": folder.id}


def _as(name: str) -> dict:
    return {"Authorization": f"Bearer {create_access_token(data={'sub': name})}"}


async def _sources(client, hanger, who="test_admin") -> dict[int, dict]:
    r = await client.get(f"/api/v1/products/{hanger['product']}/sources", headers=_as(who))
    assert r.status_code == 200, r.text
    return {row["part_id"]: row for row in r.json()["parts"]}


@pytest.mark.asyncio
async def test_a_parts_sources_follow_the_plans_order_and_recommend_the_first(async_client, hanger):
    """PS1 / PS2: the X1C plate makes 4 hooks an hour, the P1S plate 2 — the plan's key
    puts X1C first and recommends it; the unsliced project comes after, shown but
    outside ``yield_*``; K3 models are the sliced sources' models."""
    hook = (await _sources(async_client, hanger))[hanger["parts"]["hook"]]
    files = hanger["files"]
    assert [(s["library_file_id"], s["sliced"], s["yield"], s["recommended"]) for s in hook["sources"]] == [
        (files["x1c"], True, 4, True),
        (files["p1s"], True, 2, False),
        (files["raw"], False, 1, False),
    ]
    p1s = hook["sources"][1]
    assert (p1s["filename"], p1s["folder_id"], p1s["folder_name"], p1s["hidden"]) == (
        "hanger-p1s.gcode.3mf",
        hanger["folder"],
        "Shelf A",
        False,
    )
    assert (p1s["printer_model"], p1s["print_time_seconds"], p1s["filament_used_grams"]) == ("P1S", 3600, 20.0)
    assert (hook["has_sliced_source"], hook["yield_min"], hook["yield_max"], hook["hidden_sources"]) == (True, 2, 4, 0)


@pytest.mark.asyncio
async def test_a_hidden_source_keeps_its_numbers_and_loses_its_name(async_client, hanger):
    """LV4 for a read-own caller: somebody else's P1S file and the ownerless project
    are hidden — no name, no folder — while plate, model, yield, time and grams stay."""
    hook = (await _sources(async_client, hanger, "ps_own"))[hanger["parts"]["hook"]]
    by_file = {s["library_file_id"]: s for s in hook["sources"]}
    hidden = by_file[hanger["files"]["p1s"]]
    assert (hidden["filename"], hidden["folder_id"], hidden["folder_name"], hidden["hidden"]) == (
        None,
        None,
        None,
        True,
    )
    assert (hidden["printer_model"], hidden["yield"], hidden["print_time_seconds"]) == ("P1S", 2, 3600)
    assert by_file[hanger["files"]["x1c"]]["filename"] == "hanger-x1c.gcode.3mf"
    assert (hook["hidden_sources"], hook["yield_min"], hook["yield_max"]) == (2, 2, 4)
    nobody = (await _sources(async_client, hanger, "ps_none"))[hanger["parts"]["hook"]]
    assert all(s["filename"] is None and s["hidden"] for s in nobody["sources"])
    assert nobody["hidden_sources"] == 3


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("who", "named", "hidden_count"),
    [
        ("test_admin", {"p1s", "x1c", "raw", "stl"}, 0),
        ("ps_all", {"p1s", "x1c", "raw", "stl"}, 0),
        ("ps_own", {"x1c", "stl"}, 2),
        ("ps_none", set(), 4),
    ],
)
async def test_the_files_tab_lists_every_linked_file_and_names_what_the_library_shows(
    async_client, hanger, who, named, hidden_count
):
    """PS7: every linked file outside the trash — the STL without plates too — with its
    plates; a hidden one is listed without its name."""
    r = await async_client.get(f"/api/v1/products/{hanger['product']}/files", headers=_as(who))
    assert r.status_code == 200, r.text
    body = r.json()
    files = hanger["files"]
    label = {fid: name for name, fid in files.items()}
    listed = {label[f["library_file_id"]]: f for f in body["files"]}
    assert set(listed) == {"p1s", "x1c", "raw", "stl"}
    assert {name for name, f in listed.items() if f["filename"] is not None} == named
    assert body["hidden_files"] == hidden_count
    stl, raw, p1s = listed["stl"], listed["raw"], listed["p1s"]
    assert (stl["plan_eligible"], stl["sliced_any"], stl["plates"]) == (False, False, [])
    assert (raw["plan_eligible"], raw["sliced_any"], len(raw["plates"])) == (True, False, 1)
    assert (p1s["printer_model"], p1s["sliced_any"], p1s["plates"][0]["print_time_seconds"]) == ("P1S", True, 3600)
    assert p1s["plates"][0]["filename"] == p1s["filename"]
    assert p1s["plates"][0]["hidden"] is p1s["hidden"]


@pytest.mark.asyncio
async def test_the_plates_list_hides_a_files_name_and_keeps_the_plate(async_client, hanger):
    """K5: ``filename`` is ``null`` + ``hidden`` for a file the library would not show."""
    r = await async_client.get(f"/api/v1/products/{hanger['product']}/plates", headers=_as("ps_own"))
    assert r.status_code == 200, r.text
    by_file = {p["library_file_id"]: p for p in r.json()}
    assert (by_file[hanger["files"]["p1s"]]["filename"], by_file[hanger["files"]["p1s"]]["hidden"]) == (None, True)
    assert by_file[hanger["files"]["p1s"]]["printer_model"] == "P1S"
    assert (by_file[hanger["files"]["x1c"]]["filename"], by_file[hanger["files"]["x1c"]]["hidden"]) == (
        "hanger-x1c.gcode.3mf",
        False,
    )


async def _parts(client, who="test_admin", **params):
    r = await client.get("/api/v1/products/parts", params={"page": 1, **params}, headers=_as(who))
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.asyncio
async def test_the_parts_picker_carries_sources_and_searches_visible_file_names(async_client, hanger):
    """PS2 / PS3: a row carries its sources; ``q`` finds a part by a file name the caller
    may see, and never by one it may not."""
    rows = {r["part_id"]: r for r in (await _parts(async_client))["items"]}
    hook = rows[hanger["parts"]["hook"]]
    assert (hook["has_sliced_source"], hook["yield_min"], hook["yield_max"], hook["models"]) == (
        True,
        2,
        4,
        ["P1S", "X1C"],
    )
    assert rows[hanger["parts"]["bar"]]["models"] == ["P1S"]
    assert len((await _parts(async_client, q="hanger-x1c"))["items"]) == 2
    assert len((await _parts(async_client, "ps_own", q="hanger-x1c"))["items"]) == 2
    assert (await _parts(async_client, "ps_own", q="hanger-p1s"))["items"] == []
    assert (await _parts(async_client, "ps_none", q="hanger-x1c"))["items"] == []
    own_row = next(
        r for r in (await _parts(async_client, "ps_own"))["items"] if r["part_id"] == hanger["parts"]["hook"]
    )
    assert own_row["hidden_sources"] == 2


@pytest.mark.asyncio
async def test_model_none_keeps_the_products_nothing_is_sliced_for(async_client, db_session, hanger):
    """PS4: the model filter is the product's; ``none`` — no printable file at all."""
    bare = Product(name="Bare")
    db_session.add(bare)
    await db_session.flush()
    db_session.add(ProductPart(product_id=bare.id, kind="printed", name="leg", name_key="leg", qty_per_unit=1))
    await db_session.commit()
    names = {r["name"] for r in (await _parts(async_client, model="none"))["items"]}
    assert names == {"leg"}
    assert {r["name"] for r in (await _parts(async_client, model="X1C"))["items"]} == {"hook.stl", "bar.stl"}


@pytest.mark.asyncio
async def test_the_picker_has_no_whole_list(async_client, hanger):
    """K7."""
    r = await async_client.get("/api/v1/products/parts", params={"page": 1, "all": "true"})
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
async def test_a_page_reads_the_library_once(async_client, hanger, test_engine):
    from backend.tests.unit.services.test_product_composition import counting_statements

    await _parts(async_client)
    with counting_statements(test_engine, match="FROM library_files") as seen:
        await _parts(async_client)
    assert len(seen) == 1, seen
