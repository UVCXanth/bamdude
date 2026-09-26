import pytest

from backend.app.services.entity_codes import PREFIXES, code_for, id_from_query


def test_a_code_is_the_prefix_and_the_id_padded_to_four_digits():
    assert code_for("order", 42) == "OR-0042"
    assert code_for("customer", 7) == "CU-0007"
    assert code_for("contact", 12) == "CT-0012"
    assert code_for("product", 12345) == "PR-12345"


def test_every_prefix_is_two_latin_capitals_and_none_repeats():
    assert set(PREFIXES) == {"customer", "contact", "order", "product", "stock_item", "dispatch_note"}
    values = list(PREFIXES.values())
    assert len(values) == len(set(values))
    assert all(len(p) == 2 and p.isascii() and p.isalpha() and p.isupper() for p in values)


@pytest.mark.parametrize("text", ["OR-0042", "or42", "Or 42", "0042", "42", " OR-42 ", "or-00042"])
def test_a_search_reads_its_own_code_in_any_spelling(text):
    assert id_from_query("order", text) == 42


@pytest.mark.parametrize(
    "text", ["CU-42", "OR-", "OR-0", "0", "42a", "lamp 42", "", "   ", None, "99999999999999999999", "OR--42"]
)
def test_anything_else_names_nothing(text):
    assert id_from_query("order", text) is None


def test_a_required_prefix_refuses_the_bare_number():
    assert id_from_query("contact", "12", require_prefix=True) is None
    assert id_from_query("contact", "ct-12", require_prefix=True) == 12
    assert id_from_query("contact", "CU-12", require_prefix=True) is None
