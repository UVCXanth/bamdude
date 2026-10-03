"""WS-13 E11 A01–A03 (spec workshop-ui-parity-e11-customers).

A01 — a customer whose name another customer already has is a WARNING, not a ban (the
owner, 2026-10-03; names stay non-unique, WS-03): the server answers 409 ``name_taken``
with the namesake's id, writes nothing, and takes the same request with
``allow_duplicate_name: true``. Only a request that CHANGES the name is asked.

A02 — the customers search takes ``%``, ``_`` and ``\\`` literally (``like_contains``).

A03 — a delivery method whose case-folded key would outgrow its 255-character column is
refused before the write, instead of failing on PostgreSQL.
"""

import pytest
from sqlalchemy import func, select

from backend.app.i18n import set_language_cache
from backend.app.models.customer import Customer, CustomerContact

pytestmark = pytest.mark.integration


async def _create(client, name: str, **extra):
    r = await client.post("/api/v1/customers", json={"name": name, **extra})
    assert r.status_code == 200, r.text
    return r.json()


# ── A01: the namesake warning ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_namesake_is_refused_with_its_id_and_nothing_is_written(committing_client, db_session):
    first = await _create(committing_client, "ТехноЛаб")
    await _create(committing_client, "Інший")
    before = await db_session.scalar(select(func.count(Customer.id)))

    r = await committing_client.post(
        "/api/v1/customers",
        json={"name": "  технолаб ", "contacts": [{"name": "Олена", "phone": "+380 67 000 00 00"}]},
    )

    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "name_taken"
    assert detail["customer"] == first["id"]
    assert first["code"] in detail["message"]
    assert await db_session.scalar(select(func.count(Customer.id))) == before
    assert await db_session.scalar(select(func.count(CustomerContact.id)).where(CustomerContact.name == "Олена")) == 0


@pytest.mark.asyncio
async def test_the_oldest_namesake_is_named(committing_client):
    oldest = await _create(committing_client, "Acme")
    await _create(committing_client, "ACME", allow_duplicate_name=True)
    r = await committing_client.post("/api/v1/customers", json={"name": "acme"})
    assert r.status_code == 409 and r.json()["detail"]["customer"] == oldest["id"]


@pytest.mark.asyncio
async def test_a_namesake_made_knowingly_is_created(committing_client):
    await _create(committing_client, "Світло Про")
    r = await committing_client.post(
        "/api/v1/customers", json={"name": "світло про", "allow_duplicate_name": True, "contacts": [{"name": "Ірина"}]}
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "світло про" and [c["name"] for c in r.json()["contacts"]] == ["Ірина"]


@pytest.mark.asyncio
async def test_renaming_onto_a_namesake_asks_and_the_flag_lets_it(committing_client):
    taken = await _create(committing_client, "Кав’ярня «Зерно»")
    other = await _create(committing_client, "Інша кав’ярня")

    r = await committing_client.patch(f"/api/v1/customers/{other['id']}", json={"name": "кав’ярня «зерно»"})
    assert r.status_code == 409 and r.json()["detail"]["customer"] == taken["id"]
    assert (await committing_client.get(f"/api/v1/customers/{other['id']}")).json()["name"] == "Інша кав’ярня"

    r = await committing_client.patch(
        f"/api/v1/customers/{other['id']}", json={"name": "кав’ярня «зерно»", "allow_duplicate_name": True}
    )
    assert r.status_code == 200 and r.json()["name"] == "кав’ярня «зерно»"


@pytest.mark.asyncio
async def test_a_patch_that_does_not_change_the_name_is_never_asked(committing_client):
    a = await _create(committing_client, "Двійник")
    b = await _create(committing_client, "двійник", allow_duplicate_name=True)

    # The same name again, only its case, or no name at all: no warning, even with a namesake.
    for body in ({"name": "двійник"}, {"name": "ДВІЙНИК"}, {"notes": "n"}, {"kind": "regular"}):
        r = await committing_client.patch(f"/api/v1/customers/{b['id']}", json=body)
        assert r.status_code == 200, (body, r.text)
    r = await committing_client.patch(f"/api/v1/customers/{a['id']}", json={"name": "Двійник", "notes": "x"})
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_a_refused_contact_and_a_namesake_in_one_request_write_nothing(committing_client, db_session):
    first = await _create(committing_client, "Наука дітям", contacts=[{"name": "Павло"}])
    other = await _create(committing_client, "Освіта Хаб")
    foreign_contact = first["contacts"][0]["id"]
    before = await db_session.scalar(select(func.count(CustomerContact.id)))

    r = await committing_client.patch(
        f"/api/v1/customers/{other['id']}",
        json={"name": "наука дітям", "contacts": [{"id": foreign_contact, "name": "Павло"}]},
    )
    assert r.status_code in (409, 422)
    db_session.expire_all()
    assert (await committing_client.get(f"/api/v1/customers/{other['id']}")).json()["name"] == "Освіта Хаб"
    assert await db_session.scalar(select(func.count(CustomerContact.id))) == before


@pytest.mark.asyncio
async def test_the_namesake_refusal_is_translated(committing_client):
    await _create(committing_client, "Крамниця №7")
    english = (await committing_client.post("/api/v1/customers", json={"name": "крамниця №7"})).json()["detail"]
    set_language_cache("uk")
    try:
        ukrainian = (await committing_client.post("/api/v1/customers", json={"name": "крамниця №7"})).json()["detail"]
    finally:
        set_language_cache("en")
    assert ukrainian["error"] == english["error"] == "name_taken"
    assert ukrainian["message"] != english["message"]
    assert ukrainian["customer"] == english["customer"]


# ── A02: the search takes its own wildcards literally ─────────────────────────────────


@pytest.mark.asyncio
async def test_the_customers_search_takes_percent_underscore_and_backslash_literally(committing_client):
    await _create(committing_client, "Знижка 50% назавжди")
    await _create(committing_client, "plain_name")
    await _create(committing_client, "C:\\shop")
    await _create(committing_client, "Звичайний замовник", contacts=[{"name": "Олег", "phone": "+380 93 700 18 18"}])

    async def names(q: str) -> list[str]:
        r = await committing_client.get("/api/v1/customers", params={"page": 1, "q": q})
        assert r.status_code == 200, r.text
        return sorted(item["name"] for item in r.json()["items"])

    assert await names("%") == ["Знижка 50% назавжди"]
    assert await names("_") == ["plain_name"]
    assert await names("\\") == ["C:\\shop"]
    # The ordinary search is unchanged: a name, a contact's phone.
    assert await names("звичайний") == ["Звичайний замовник"]
    assert await names("700 18") == ["Звичайний замовник"]


# ── A03: a delivery method key that would outgrow its column ──────────────────────────


@pytest.mark.asyncio
async def test_a_delivery_method_whose_folded_key_is_too_long_is_refused(committing_client):
    long_name = "ß" * 200  # casefold() turns it into 400 characters
    r = await committing_client.post("/api/v1/delivery-methods", json={"name": long_name})
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "The name is too long"

    made = await committing_client.post("/api/v1/delivery-methods", json={"name": "x" * 255})
    assert made.status_code == 200, made.text
    r = await committing_client.patch(f"/api/v1/delivery-methods/{made.json()['id']}", json={"name": long_name})
    assert r.status_code == 422 and r.json()["detail"] == "The name is too long"
    listed = (await committing_client.get("/api/v1/delivery-methods")).json()
    assert [m["name"] for m in listed if m["id"] == made.json()["id"]] == ["x" * 255]
