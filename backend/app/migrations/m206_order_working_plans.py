"""A recoverable order draft, explicit comparison baseline and publication receipts.

Receipts reference the operation, never ephemeral queue rows. A read does not
create a plan or invent an operator-confirmed baseline for an existing order.
"""

version = 206
name = "order_working_plans"


async def upgrade(conn):
    from uuid import uuid4

    from sqlalchemy import inspect, text

    from backend.app.models.order_working_plan import OrderPlanReceipt, OrderPlanSubmission, OrderWorkingPlan

    columns = await conn.run_sync(lambda sync: {c["name"] for c in inspect(sync).get_columns("project_lines")})
    if "plan_identity" not in columns:
        await conn.execute(text("ALTER TABLE project_lines ADD COLUMN plan_identity VARCHAR(36)"))
    ids = (await conn.execute(text("SELECT id FROM project_lines WHERE plan_identity IS NULL"))).scalars().all()
    for line_id in ids:
        await conn.execute(
            text("UPDATE project_lines SET plan_identity=:identity WHERE id=:id"),
            {"id": line_id, "identity": str(uuid4())},
        )

    for model in (OrderWorkingPlan, OrderPlanSubmission, OrderPlanReceipt):
        await conn.run_sync(lambda sync, table=model.__table__: table.create(sync, checkfirst=True))
