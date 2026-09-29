"""The lock ledger follows the OUTER transaction, savepoints included (WS-13 E1, spec BL2 (1)–(4)).

SQLAlchemy fires ``after_commit`` / ``after_rollback`` for a SAVEPOINT as well, so a
ledger reset on those events would forget the outer transaction's locks the moment a
nested ``credit_if_unfiled`` released its savepoint (review round 5). Measured here on
a real ``Session`` over SQLite ``:memory:`` — no application data involved.
"""

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from backend.app.core.lock_ledger import LINE, POSITION, ledger


@pytest.fixture
def session():
    engine = create_engine("sqlite://")
    with Session(engine) as db:
        yield db
    engine.dispose()


def test_the_outer_commit_forgets_everything(session):
    session.execute(text("SELECT 1"))
    ledger(session).note("stock_items", 1, POSITION)
    session.commit()
    session.execute(text("SELECT 1"))
    assert not ledger(session).holds("stock_items", 1)
    assert ledger(session).lock_class == 0


def test_the_outer_rollback_forgets_everything(session):
    session.execute(text("SELECT 1"))
    ledger(session).note("project_lines", 7, LINE)
    session.rollback()
    assert not ledger(session).holds("project_lines", 7)


def test_a_released_savepoint_keeps_what_was_held_before_and_inside_it(session):
    session.execute(text("SELECT 1"))
    ledger(session).note("stock_items", 1, POSITION)
    with session.begin_nested():
        session.execute(text("SELECT 2"))
        ledger(session).note("project_lines", 2, LINE)
    held = ledger(session)
    assert held.holds("stock_items", 1)
    assert held.holds("project_lines", 2)
    assert held.lock_class == LINE


def test_a_rolled_back_savepoint_restores_the_ledger_to_its_start(session):
    session.execute(text("SELECT 1"))
    ledger(session).note("stock_items", 1, POSITION)
    with pytest.raises(RuntimeError), session.begin_nested():
        session.execute(text("SELECT 2"))
        ledger(session).note("stock_items", 5, POSITION)
        ledger(session).note("project_lines", 2, LINE)
        raise RuntimeError("the savepoint's work fails")
    held = ledger(session)
    assert held.holds("stock_items", 1), "a lock taken before the savepoint is still held"
    assert not held.holds("stock_items", 5), "a lock taken only inside it was released"
    assert not held.holds("project_lines", 2)
    assert held.lock_class == POSITION


def test_nested_savepoints_restore_each_to_its_own_start(session):
    session.execute(text("SELECT 1"))
    with session.begin_nested():
        ledger(session).note("stock_items", 1, POSITION)
        with pytest.raises(RuntimeError), session.begin_nested():
            ledger(session).note("stock_items", 2, POSITION)
            raise RuntimeError
        assert ledger(session).held("stock_items") == {1}
    assert ledger(session).held("stock_items") == {1}


def test_the_ledger_survives_the_savepoint_into_the_same_outer_transaction_then_ends(session):
    session.execute(text("SELECT 1"))
    ledger(session).note("stock_items", 1, POSITION)
    with session.begin_nested():
        pass
    assert ledger(session).holds("stock_items", 1)
    session.commit()
    assert not ledger(session).holds("stock_items", 1)


def test_a_row_this_transaction_created_does_not_count_toward_the_order(session):
    session.execute(text("SELECT 1"))
    ledger(session).note_created("project_lines", 9)
    ledger(session).note("project_lines", 9, LINE)
    held = ledger(session)
    assert held.holds("project_lines", 9)
    assert held.held_existing("project_lines") == set()
    assert held.lock_class == 0, "nobody can wait on a row only this transaction can see"
