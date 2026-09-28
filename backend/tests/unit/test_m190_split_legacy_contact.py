import pytest

from backend.app.migrations.m190_customer_contacts import split_legacy_contact


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


@pytest.mark.parametrize(
    "raw",
    [
        "t.me/ivan_shop",
        "Іван, instagram.com/shop_ua",
        "Склад 12/3, Київ",
        "Іван; оплата 50/50",
        "Олена | склад · Бровари",
    ],
)
def test_separators_inside_the_text_stay_as_they_were(raw):
    # Only the phone and e-mail come out; nothing else is rewritten.
    assert split_legacy_contact(raw) == {"name": raw, "phone": None, "email": None, "note": None}


def test_a_date_is_not_a_phone():
    assert split_legacy_contact("Іван, договір від 12.05.2024") == {
        "name": "Іван, договір від 12.05.2024",
        "phone": None,
        "email": None,
        "note": None,
    }


def test_a_phone_never_swallows_the_next_line():
    fields = split_legacy_contact("050 111 22 33\n067 222 33 44")
    assert fields["phone"] == "050 111 22 33"
    assert "\n" not in fields["phone"]
    # The rest is still somewhere: the second number is the name.
    assert fields["name"] == "067 222 33 44"


def test_whatever_is_not_kept_verbatim_goes_whole_into_the_note():
    raw = "Іван , , +380 67 123 45 67 , склад"
    fields = split_legacy_contact(raw)
    assert fields["phone"] == "+380 67 123 45 67"
    # The name was pieced together around the phone, so it is not a slice of the
    # original any more: the original travels in the note, untouched.
    assert fields["note"] == raw


def test_an_over_long_phone_or_email_never_reaches_a_255_column():
    long_email = "a" * 260 + "@x.ua"
    fields = split_legacy_contact(f"Ira {long_email}")
    assert fields["email"] is None and fields["note"] == f"Ira {long_email}"
    long_phone = "1" * 300
    fields = split_legacy_contact(long_phone)
    assert fields["phone"] is None and fields["note"] == long_phone


@pytest.mark.parametrize("raw", [None, "", "   \n  "])
def test_an_empty_old_contact_makes_no_contact(raw):
    assert split_legacy_contact(raw) is None
