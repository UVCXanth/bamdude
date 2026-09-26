import pytest

from backend.app.migrations.m185_customer_contacts import split_legacy_contact


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            "Іван Петренко, +380 67 123 45 67, ivan@x.ua",
            {"name": "Іван Петренко", "phone": "+380 67 123 45 67", "email": "ivan@x.ua", "note": None},
        ),
        ("Склад ТОВ Ромашка", {"name": "Склад ТОВ Ромашка", "phone": None, "email": None, "note": None}),
        ("050 111 22 33", {"name": None, "phone": "050 111 22 33", "email": None, "note": None}),
        ("кв. 12, під'їзд 3", {"name": "кв. 12, під'їзд 3", "phone": None, "email": None, "note": None}),
        (
            "Олена\nбухгалтерія: buh@x.ua\nтел 050 111 22 33",
            {
                "name": None,
                "phone": "050 111 22 33",
                "email": "buh@x.ua",
                "note": "Олена\nбухгалтерія: buh@x.ua\nтел 050 111 22 33",
            },
        ),
        ("a" * 300, {"name": None, "phone": None, "email": None, "note": "a" * 300}),
    ],
)
def test_the_old_contact_splits_into_fields_and_loses_nothing(raw, expected):
    assert split_legacy_contact(raw) == expected


@pytest.mark.parametrize("raw", [None, "", "   \n  "])
def test_an_empty_old_contact_makes_no_contact(raw):
    assert split_legacy_contact(raw) is None
