"""A card's parts keep or gain «не рахувати» on import (spec workshop-order-issue-followups, rule 34)."""

from backend.app.services.product_card import imported_mark


def test_an_old_cards_printed_zero_is_marked():
    assert imported_mark({}, "printed", 0) is True


def test_a_card_that_says_so_is_believed_for_a_printed_zero():
    assert imported_mark({"ignored": False}, "printed", 0) is False
    assert imported_mark({"ignored": True}, "printed", 0) is True


def test_a_part_in_the_kit_is_never_marked():
    assert imported_mark({"ignored": True}, "printed", 2) is False


def test_a_bought_part_is_never_marked():
    # Final review I3: a bought part is never on a plate, so «not a part of it» never applies.
    assert imported_mark({}, "purchased", 0) is False
    assert imported_mark({"ignored": True}, "purchased", 0) is False
