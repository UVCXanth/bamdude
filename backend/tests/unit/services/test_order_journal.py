import pytest
from sqlalchemy import select

from backend.app.models.project import Project, ProjectEvent
from backend.app.models.user import User
from backend.app.services import order_journal

EXPECTED_KINDS = (
    "order_created", "status_changed", "fields_changed", "responsible_changed", "stage_changed",
    "line_added", "line_changed", "line_removed", "line_configured",
    "prints_filed", "prints_unfiled", "defects_recorded",
    "queue_items_filed", "plan_enqueued", "line_rebalanced",
    "surplus_banked", "procurement_updated",
    "kits_assembled", "goods_received", "goods_issued", "stock_taken", "goods_written_off", "goods_stocked",
    "attachment_added", "attachment_removed", "cover_changed",
)  # fmt: skip


def test_the_kinds_are_the_specs_closed_list_and_each_has_a_title():
    assert order_journal.EVENT_KINDS == EXPECTED_KINDS
    assert set(order_journal.TITLES) == set(EXPECTED_KINDS)


@pytest.mark.asyncio
async def test_record_names_the_actor_by_id_and_by_a_name_snapshot(db_session):
    project = Project(name="A")
    user = User(username="olena", role="user", is_active=True)
    db_session.add_all([project, user])
    await db_session.flush()
    await order_journal.record(db_session, project.id, "stage_changed", {"from": "prep", "to": "qc"}, actor=user)
    await order_journal.record(db_session, project.id, "defects_recorded", {"defective": 2}, actor_id=user.id)
    await order_journal.record(db_session, project.id, "plan_enqueued", {"prints": 3})
    rows = (await db_session.execute(select(ProjectEvent).order_by(ProjectEvent.id))).scalars().all()
    assert [(r.kind, r.user_id, r.user_name) for r in rows] == [
        ("stage_changed", user.id, "olena"),
        ("defects_recorded", user.id, "olena"),
        ("plan_enqueued", None, None),
    ]
    assert rows[0].payload == {"from": "prep", "to": "qc"}


@pytest.mark.asyncio
async def test_a_line_is_stamped_in_utc_when_it_is_written_not_by_the_database(db_session):
    # Spec rule 14: UTC. A database default is the SERVER's clock — local time on
    # a PostgreSQL whose timezone is not UTC — while print events are stamped in
    # Python UTC; the journal must sit on the same clock as the prints.
    from datetime import datetime, timedelta, timezone

    project = Project(name="A")
    db_session.add(project)
    await db_session.flush()
    event = await order_journal.record(db_session, project.id, "plan_enqueued", {"prints": 1})
    assert event.created_at is not None  # set at once, before any flush
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    assert abs(now - event.created_at) < timedelta(seconds=5)


@pytest.mark.asyncio
async def test_an_unknown_kind_is_a_programming_error(db_session):
    with pytest.raises(ValueError):
        await order_journal.record(db_session, 1, "stage_moved", {})


@pytest.mark.asyncio
async def test_deleting_an_order_or_a_user_leaves_no_reference(db_session):
    project = Project(name="A")
    user = User(username="ira", role="user", is_active=True)
    db_session.add_all([project, user])
    await db_session.flush()
    await order_journal.record(db_session, project.id, "stage_changed", {}, actor=user)
    await db_session.flush()
    await order_journal.detach_user(db_session, user.id)
    row = (await db_session.execute(select(ProjectEvent))).scalar_one()
    await db_session.refresh(row)
    assert row.user_id is None and row.user_name == "ira"
    await order_journal.delete_for_project(db_session, project.id)
    assert (await db_session.execute(select(ProjectEvent))).first() is None
