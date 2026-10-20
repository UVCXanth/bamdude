"""A global restart acknowledgement is a separate, administrator-default right."""

version = 205
name = "farm_resume_permission"


async def upgrade(conn):
    """No schema change; operational state belongs to the installation."""


async def seed(session_factory):
    from sqlalchemy import select, update

    from backend.app.models.group import Group

    async with session_factory() as db:
        rows = (await db.execute(select(Group.id, Group.name, Group.is_system, Group.permissions))).all()
        for row in rows:
            if row.is_system and row.name == "Administrators" and "farm:resume" not in (row.permissions or []):
                await db.execute(
                    update(Group)
                    .where(Group.id == row.id)
                    .values(permissions=[*(row.permissions or []), "farm:resume"])
                )
        await db.commit()
