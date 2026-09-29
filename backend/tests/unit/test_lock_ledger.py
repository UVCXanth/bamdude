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


# ---------- (v) the product gate's own preconditions — mandatory in every process ----------


async def _two_products(db):
    from backend.app.models.product import Product

    first, second = Product(name="Gate A"), Product(name="Gate B")
    db.add_all([first, second])
    await db.commit()
    return first, second


def _gate_statements(db):
    from sqlalchemy import event

    seen: list[str] = []

    def on(_conn, _cursor, statement, *_rest):
        if "products" in statement and ("UPDATE" in statement or "FOR" in statement):
            seen.append(statement)

    event.listen(db.bind.sync_engine, "before_cursor_execute", on)
    return seen, lambda: event.remove(db.bind.sync_engine, "before_cursor_execute", on)


@pytest.mark.parametrize("strict", [True, False])
@pytest.mark.asyncio
async def test_a_gate_on_a_dirty_session_is_refused_before_any_sql(db_session, monkeypatch, strict):
    from backend.app.core import lock_ledger
    from backend.app.core.lock_ledger import GateOrderError
    from backend.app.services.product_gate import product_gate

    monkeypatch.setattr(lock_ledger, "STRICT", strict)
    first, _second = await _two_products(db_session)
    first.name = "renamed, not flushed"
    seen, stop = _gate_statements(db_session)
    try:
        with pytest.raises(GateOrderError):
            await product_gate(db_session, [first.id])
    finally:
        stop()
    assert seen == []


@pytest.mark.parametrize("strict", [True, False])
@pytest.mark.asyncio
async def test_a_gate_below_one_already_held_is_refused(db_session, monkeypatch, strict):
    from backend.app.core import lock_ledger
    from backend.app.core.lock_ledger import GateOrderError
    from backend.app.services.product_gate import product_gate

    monkeypatch.setattr(lock_ledger, "STRICT", strict)
    first, second = await _two_products(db_session)
    await product_gate(db_session, [second.id])
    with pytest.raises(GateOrderError):
        await product_gate(db_session, [first.id])


@pytest.mark.parametrize("strict", [True, False])
@pytest.mark.asyncio
async def test_a_gate_after_a_line_lock_is_refused(db_session, monkeypatch, strict):
    from backend.app.core import lock_ledger
    from backend.app.core.lock_ledger import GateOrderError
    from backend.app.services.product_gate import product_gate

    monkeypatch.setattr(lock_ledger, "STRICT", strict)
    first, _second = await _two_products(db_session)
    ledger(db_session).note("project_lines", 1, LINE)
    with pytest.raises(GateOrderError):
        await product_gate(db_session, [first.id])


@pytest.mark.asyncio
async def test_a_re_entry_sends_nothing_and_accepts_pending_changes(db_session):
    from backend.app.services.product_gate import product_gate

    first, _second = await _two_products(db_session)
    await product_gate(db_session, [first.id])
    ledger(db_session).note("project_lines", 1, LINE)
    first.name = "a legitimate pending change"
    seen, stop = _gate_statements(db_session)
    try:
        await product_gate(db_session, [first.id])
    finally:
        stop()
    assert seen == []


# ---------- (vi) the order monitor of the other helpers ----------


@pytest.mark.asyncio
async def test_the_monitor_raises_in_strict_mode(db_session, monkeypatch):
    from backend.app.core import lock_ledger
    from backend.app.core.lock_ledger import GateOrderError, before_lock

    monkeypatch.setattr(lock_ledger, "STRICT", True)
    ledger(db_session).note("project_lines", 1, LINE)
    with pytest.raises(GateOrderError):
        before_lock(db_session, "stock_items", 7, POSITION)


@pytest.mark.asyncio
async def test_the_monitor_logs_once_and_lets_a_working_process_go_on(db_session, monkeypatch, caplog):
    from backend.app.core import lock_ledger
    from backend.app.core.lock_ledger import before_lock

    monkeypatch.setattr(lock_ledger, "STRICT", False)
    monkeypatch.setattr(lock_ledger, "_reported", set())
    ledger(db_session).note("project_lines", 1, LINE)
    with caplog.at_level("ERROR", logger="backend.app.core.lock_ledger"):
        assert before_lock(db_session, "stock_items", 7, POSITION) is True
        assert before_lock(db_session, "stock_items", 8, POSITION) is True
    assert len([r for r in caplog.records if "lock order" in r.getMessage()]) == 1


@pytest.mark.asyncio
async def test_the_monitor_does_not_check_a_row_already_held(db_session, monkeypatch):
    from backend.app.core import lock_ledger
    from backend.app.core.lock_ledger import before_lock

    monkeypatch.setattr(lock_ledger, "STRICT", True)
    ledger(db_session).note("stock_items", 7, POSITION)
    ledger(db_session).note("project_lines", 1, LINE)
    assert before_lock(db_session, "stock_items", 7, POSITION) is False
