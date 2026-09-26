"""An order line's configuration — the ONE writer (spec workshop-product-variants, rules 5, 11–14).

Writes ``project_line_choices``, ``project_line_part_counts`` and
``project_lines.config_key`` and nothing else does
(``tests/unit/test_line_config_has_one_writer.py``). Every reader asks
``services/line_composition.py``.

* A ``product`` line records a choice for EVERY group of its product — the
  standard one too — so a changed standard or a group added later never
  changes a saved order's kit. A changed count is stored only when it differs
  from what the configuration would give anyway.
* A ``parts`` line records the count of each part it wants, and no choice.
* Changing a configuration moves the line's reservation to the new kit in the
  same transaction and journals ``line_configured``; ``dry_run`` answers what it
  would do — the parts that drop out, what of them is already printed or queued
  — and writes nothing.

Never commits; SQLite runs no FK actions, so a part or line that goes takes its
rows with it through :func:`forget_part` / :func:`forget_line`. Rows are
replaced with Core statements, never ORM objects (a reader in the same session
may hold the old ones in its identity map).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from sqlalchemy import delete, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.app.models.line_config import ProjectLineChoice, ProjectLinePartCount
from backend.app.models.product import Product
from backend.app.models.product_variant import ProductVariantGroup
from backend.app.models.project_line import ProjectLine
from backend.app.models.user import User
from backend.app.services import order_journal, part_stock
from backend.app.services.line_composition import (
    Composition,
    LineConfig,
    composition,
    config_key,
    counted,
    line_composition,
    load_line_configs,
)

MAX_COUNT = 9999


class LineConfigError(ValueError):
    """A configuration the product cannot have; ``status`` is the HTTP answer."""

    def __init__(self, detail: str, status: int = 422) -> None:
        super().__init__(detail)
        self.status = status


@dataclass
class DroppedPart:
    """A part the new configuration wants less of — and what of it already exists."""

    part_id: int
    name: str
    per_before: int
    per_after: int
    printed: int
    queued: int


@dataclass
class ConfigOutcome:
    reserved_before: int = 0
    reserved_after: int = 0
    dropping: list[DroppedPart] = field(default_factory=list)


async def _product(db: AsyncSession, product_id: int) -> Product:
    product = (
        await db.execute(
            select(Product)
            .options(
                selectinload(Product.parts),
                selectinload(Product.variant_groups).selectinload(ProductVariantGroup.options),
            )
            .where(Product.id == product_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    return product


def _defaults(product: Product) -> dict[int, int]:
    return {g.id: g.default_option_id for g in product.variant_groups if g.default_option_id is not None}


def _validate(
    product: Product, mode: str, choices: Mapping[int, int], counts: Mapping[int, int]
) -> tuple[dict[int, int], dict[int, int]]:
    """The choices and counts to store, or :class:`LineConfigError`."""
    parts = {p.id: p for p in product.parts}
    for pid, qty in counts.items():
        if pid not in parts:
            raise LineConfigError("That part does not belong to this product")
        if not 0 <= qty <= MAX_COUNT:
            raise LineConfigError("A part count must be between 0 and 9999")
    if mode == "parts":
        wanted = {pid: qty for pid, qty in counts.items() if qty > 0}
        if not wanted:
            raise LineConfigError("A parts line needs at least one part")
        return {}, wanted
    group_of = {o.id: g.id for g in product.variant_groups for o in g.options}
    new_choices = _defaults(product)
    for gid, oid in choices.items():
        if group_of.get(oid) != gid:
            raise LineConfigError("That option does not belong to this product")
        new_choices[gid] = oid
    # A count equal to what the configuration gives anyway is not a change.
    by_id = {p.id: per for p, per in composition(list(parts.values()), "product", set(new_choices.values()), {})}
    changed = {pid: qty for pid, qty in counts.items() if qty != by_id.get(pid, 0)}
    return new_choices, changed


async def _write(db: AsyncSession, line: ProjectLine, choices: Mapping[int, int], counts: Mapping[int, int]) -> None:
    await db.execute(delete(ProjectLineChoice).where(ProjectLineChoice.line_id == line.id))
    await db.execute(delete(ProjectLinePartCount).where(ProjectLinePartCount.line_id == line.id))
    if choices:
        await db.execute(
            insert(ProjectLineChoice),
            [{"line_id": line.id, "group_id": gid, "option_id": oid} for gid, oid in sorted(choices.items())],
        )
    if counts:
        await db.execute(
            insert(ProjectLinePartCount),
            [{"line_id": line.id, "part_id": pid, "qty": qty} for pid, qty in sorted(counts.items())],
        )
    line.config_key = config_key(line.mode, choices, counts)


async def _rekey(db: AsyncSession, line_ids: Sequence[int]) -> None:
    """Recompute the stored key of these lines from their rows."""
    if not line_ids:
        return
    configs = await load_line_configs(db, line_ids)
    for line in (await db.execute(select(ProjectLine).where(ProjectLine.id.in_(line_ids)))).scalars():
        cfg = configs.get(line.id, LineConfig())
        line.config_key = config_key(line.mode, cfg.choices, cfg.counts)


def _describe(product: Product, cfg: LineConfig) -> dict:
    """Names only — the journal composes the sentence in the reader's language."""
    options = {o.id: o.name for g in product.variant_groups for o in g.options}
    parts = {p.id: p.name for p in product.parts}
    return {
        "choices": [
            [g.name, options.get(cfg.choices[g.id], "?")] for g in product.variant_groups if g.id in cfg.choices
        ],
        "changed": [[parts.get(pid, "?"), qty] for pid, qty in sorted(cfg.counts.items())],
    }


async def _dropping(
    db: AsyncSession, line: ProjectLine, product: Product, old: Composition, new: Composition
) -> list[DroppedPart]:
    """Printed and queued of every counted part the new kit wants less of —
    read from the order's own figures and plan (no second arithmetic)."""
    from backend.app.services.order_metrics import attribute, load_order_context
    from backend.app.services.plan_engine import queued_yield_by_line
    from backend.app.services.product_composition import recipes_for_products

    new_per = {p.id: per for p, per in new}
    shrinking = [(p, per, new_per.get(p.id, 0)) for p, per in counted(old) if new_per.get(p.id, 0) < per]
    if not shrinking:
        return []
    ctx = await load_order_context(db, line.project_id)
    usable: dict[int, int] = {}
    if ctx is not None:
        figures, _other = attribute(ctx)
        if line.id in figures:
            usable = {pf.part_id: pf.usable for pf in figures[line.id].parts}
    recipes = await recipes_for_products(db, [product])
    queued = await queued_yield_by_line(db, recipes, [line], {line.id: {p.id for p, _per in counted(old)}})
    line_queued = queued.get(line.id, {})
    return [
        DroppedPart(
            part_id=part.id,
            name=part.name,
            per_before=before,
            per_after=after,
            printed=usable.get(part.id, 0),
            queued=line_queued.get(part.id, 0),
        )
        for part, before, after in shrinking
    ]


async def seed_line(
    db: AsyncSession, line: ProjectLine, *, choices: Mapping[int, int] | None, counts: Mapping[int, int] | None
) -> None:
    """A new line's configuration: the given choices, the standard for every other group."""
    product = await _product(db, line.product_id)
    new_choices, new_counts = _validate(product, line.mode, choices or {}, counts or {})
    await _write(db, line, new_choices, new_counts)


async def set_configuration(
    db: AsyncSession,
    line: ProjectLine,
    *,
    choices: Mapping[int, int],
    counts: Mapping[int, int],
    actor: User | None,
    dry_run: bool = False,
) -> ConfigOutcome:
    """Change a line's configuration (spec rules 11, 13–14).

    ``choices`` names the groups to change — the others keep the line's current
    choice; ``counts`` is the WHOLE set of changed counts (or, for a parts line,
    of wanted counts): what is not in it goes back to the standard.
    """
    product = await _product(db, line.product_id)
    current = (await load_line_configs(db, [line.id])).get(line.id, LineConfig())
    new_choices, new_counts = _validate(product, line.mode, {**current.choices, **choices}, counts)
    parts = list(product.parts)
    old_comp = line_composition(parts, line.mode, current, _defaults(product))
    new_comp = composition(parts, line.mode, set(new_choices.values()), new_counts)
    reserved_before = await part_stock.reserved_units_for_line(db, line)
    dropping = await _dropping(db, line, product, old_comp, new_comp)
    if dry_run:
        after = 0
        if reserved_before:
            shelf = await part_stock.balances(db, product.id)
            # The line's own kits come back first — the rewrite releases them.
            for part, per in counted(old_comp):
                shelf[part.id] = shelf.get(part.id, 0) + reserved_before * per
            after = min(reserved_before, line.quantity, part_stock.kits_of(shelf, new_comp))
        return ConfigOutcome(reserved_before, after, dropping)
    await _write(db, line, new_choices, new_counts)
    await db.flush()
    after = 0
    if reserved_before:
        after = await part_stock.reserve_for_line(
            db, line, reserved_before, comp=new_comp, created_by=actor.id if actor else None
        )
    await order_journal.record(
        db,
        line.project_id,
        "line_configured",
        {
            "line_id": line.id,
            "product": product.name,
            "from": _describe(product, current),
            "to": _describe(product, LineConfig(new_choices, new_counts)),
            "reserved": [reserved_before, after],
        },
        actor=actor,
    )
    return ConfigOutcome(reserved_before, after, dropping)


async def add_group_to_lines(db: AsyncSession, group: ProductVariantGroup) -> int:
    """A group added to a product already on orders: every product line of it
    records the group's standard option (rule 5 — choices are explicit)."""
    if group.default_option_id is None:
        return 0
    line_ids = (
        (
            await db.execute(
                select(ProjectLine.id).where(ProjectLine.product_id == group.product_id, ProjectLine.mode == "product")
            )
        )
        .scalars()
        .all()
    )
    if not line_ids:
        return 0
    have = set(
        (
            await db.execute(
                select(ProjectLineChoice.line_id).where(
                    ProjectLineChoice.line_id.in_(line_ids), ProjectLineChoice.group_id == group.id
                )
            )
        )
        .scalars()
        .all()
    )
    missing = [lid for lid in line_ids if lid not in have]
    if missing:
        await db.execute(
            insert(ProjectLineChoice),
            [{"line_id": lid, "group_id": group.id, "option_id": group.default_option_id} for lid in missing],
        )
    await _rekey(db, line_ids)
    return len(missing)


async def forget_part(db: AsyncSession, part_id: int) -> None:
    """A deleted part takes its count rows with it."""
    line_ids = (
        (await db.execute(select(ProjectLinePartCount.line_id).where(ProjectLinePartCount.part_id == part_id)))
        .scalars()
        .all()
    )
    await db.execute(delete(ProjectLinePartCount).where(ProjectLinePartCount.part_id == part_id))
    await _rekey(db, list(line_ids))


async def repoint_part(db: AsyncSession, source_id: int, target_id: int) -> None:
    """A merged part's count rows move to the target (summed where both exist)."""
    rows = (
        await db.execute(
            select(ProjectLinePartCount.line_id, ProjectLinePartCount.qty).where(
                ProjectLinePartCount.part_id == source_id
            )
        )
    ).all()
    if not rows:
        return
    existing = dict(
        (
            await db.execute(
                select(ProjectLinePartCount.line_id, ProjectLinePartCount.qty).where(
                    ProjectLinePartCount.part_id == target_id,
                    ProjectLinePartCount.line_id.in_([lid for lid, _q in rows]),
                )
            )
        ).all()
    )
    await db.execute(delete(ProjectLinePartCount).where(ProjectLinePartCount.part_id == source_id))
    for line_id, qty in rows:
        if line_id in existing:
            await db.execute(
                update(ProjectLinePartCount)
                .where(ProjectLinePartCount.line_id == line_id, ProjectLinePartCount.part_id == target_id)
                .values(qty=min(MAX_COUNT, existing[line_id] + qty))
            )
        else:
            await db.execute(insert(ProjectLinePartCount).values(line_id=line_id, part_id=target_id, qty=qty))
    await _rekey(db, [lid for lid, _q in rows])


async def forget_line(db: AsyncSession, line_id: int) -> None:
    """A deleted line takes its configuration with it."""
    await db.execute(delete(ProjectLineChoice).where(ProjectLineChoice.line_id == line_id))
    await db.execute(delete(ProjectLinePartCount).where(ProjectLinePartCount.line_id == line_id))


async def copy_configuration(db: AsyncSession, source: ProjectLine, target: ProjectLine) -> None:
    """The copy of an order carries each line's configuration."""
    cfg = (await load_line_configs(db, [source.id])).get(source.id, LineConfig())
    target.mode = source.mode
    await _write(db, target, cfg.choices, cfg.counts)
