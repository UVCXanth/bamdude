"""A line's composition — the ONE reader (spec workshop-product-variants, rules 8–10, 12).

Every figure that asks "which parts, how many per unit, for THIS line" asks
here: the order figures, the reservation, the stock tab, the filing of prints.
The product's own ``qty_per_unit`` is only the STANDARD answer; a line may
choose options and change counts (``services/line_config.py`` writes that).
Outside the product's authoring code and the stock ledger's own "has a shelf"
predicate, nothing reads ``qty_per_unit`` —
``tests/unit/test_line_composition_is_the_one_reader.py`` scans for it.
"""

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.models.line_config import ProjectLineChoice, ProjectLinePartCount
from backend.app.models.product import ProductPart
from backend.app.models.product_variant import ProductVariantGroup

Composition = list[tuple[ProductPart, int]]
# Large enough for a page of lines, small enough for asyncpg's bind-parameter limit.
_CHUNK = 500


@dataclass
class LineConfig:
    """What a line chose — ``group_id → option_id`` — and its changed counts, ``part_id → qty``."""

    choices: dict[int, int] = field(default_factory=dict)
    counts: dict[int, int] = field(default_factory=dict)


def composition(parts: Sequence[ProductPart], mode: str, chosen: set[int], counts: Mapping[int, int]) -> Composition:
    """The line's parts with their per-unit count; in ``parts`` mode, the wanted count.

    ``product`` mode: every part without an option, and every part of a chosen
    option, at its standard count — unless the line changed it; a count of 0
    drops the part, and a count on a part of another option brings it in.
    """
    ordered = sorted(parts, key=lambda p: (p.sort_order or 0, p.id))
    if mode == "parts":
        return [(p, counts[p.id]) for p in ordered if counts.get(p.id, 0) > 0]
    out: Composition = []
    for p in ordered:
        if p.id in counts:
            per = counts[p.id]
        elif p.variant_option_id is None or p.variant_option_id in chosen:
            per = p.qty_per_unit
        else:
            continue
        if per > 0:
            out.append((p, per))
    return out


def line_composition(
    parts: Sequence[ProductPart], mode: str, config: LineConfig, defaults: Mapping[int, int] | None = None
) -> Composition:
    """:func:`composition` for a loaded :class:`LineConfig`.

    ``defaults`` is the product's ``group_id → standard option``: a group the
    line has no choice for reads its standard option. The writer records a
    choice for every group, so this only covers the moment between a group's
    creation and its backfill — and a hand-built context in a test.
    """
    chosen = {**(defaults or {}), **config.choices}
    return composition(parts, mode, set(chosen.values()), config.counts)


def standard_composition(parts: Sequence[ProductPart], default_option_ids: set[int]) -> Composition:
    """The product's own kit: the standard option of every group, standard counts."""
    return composition(parts, "product", default_option_ids, {})


def counted(comp: Iterable[tuple[ProductPart, int]]) -> Composition:
    """The parts that have a shelf and make kits: printed, wanted at all."""
    return [(p, per) for p, per in comp if p.kind == "printed" and per > 0]


def config_key(mode: str, choices: Mapping[int, int], counts: Mapping[int, int]) -> str:
    """Stable identity of a configuration — the finished-goods position of WS-09.

    The same choices and the same changed counts give the same key; a product
    without groups and without changes is ``''``.
    """
    counts_part = ";".join(f"{pid}={counts[pid]}" for pid in sorted(counts))
    if mode == "parts":
        return f"parts:{counts_part}"
    choices_part = ";".join(f"{gid}={choices[gid]}" for gid in sorted(choices))
    return f"{choices_part}|{counts_part}" if counts else choices_part


async def load_line_configs(db: AsyncSession, line_ids: Sequence[int]) -> dict[int, LineConfig]:
    """Every line's choices and counts — two statements per chunk, whatever the page size."""
    ids = list(dict.fromkeys(line_ids))
    out: dict[int, LineConfig] = {lid: LineConfig() for lid in ids}
    for start in range(0, len(ids), _CHUNK):
        chunk = ids[start : start + _CHUNK]
        for line_id, group_id, option_id in (
            await db.execute(
                select(ProjectLineChoice.line_id, ProjectLineChoice.group_id, ProjectLineChoice.option_id).where(
                    ProjectLineChoice.line_id.in_(chunk)
                )
            )
        ).all():
            out[line_id].choices[group_id] = option_id
        for line_id, part_id, qty in (
            await db.execute(
                select(ProjectLinePartCount.line_id, ProjectLinePartCount.part_id, ProjectLinePartCount.qty).where(
                    ProjectLinePartCount.line_id.in_(chunk)
                )
            )
        ).all():
            out[line_id].counts[part_id] = qty
    return out


async def default_options(db: AsyncSession, product_ids: Iterable[int]) -> dict[int, dict[int, int]]:
    """``product_id → {group_id → standard option id}`` — one statement per chunk."""
    ids = list(dict.fromkeys(product_ids))
    out: dict[int, dict[int, int]] = {pid: {} for pid in ids}
    for start in range(0, len(ids), _CHUNK):
        for product_id, group_id, option_id in (
            await db.execute(
                select(
                    ProductVariantGroup.product_id, ProductVariantGroup.id, ProductVariantGroup.default_option_id
                ).where(
                    ProductVariantGroup.product_id.in_(ids[start : start + _CHUNK]),
                    ProductVariantGroup.default_option_id.is_not(None),
                )
            )
        ).all():
            out[product_id][group_id] = option_id
    return out


async def compositions_for_lines(
    db: AsyncSession, lines: Sequence, parts_by_product: Mapping[int, Sequence[ProductPart]]
) -> dict[int, Composition]:
    """``line_id → composition`` for many lines — three statements, whatever the count."""
    configs = await load_line_configs(db, [line.id for line in lines])
    defaults = await default_options(db, {line.product_id for line in lines})
    return {
        line.id: line_composition(
            parts_by_product.get(line.product_id, []),
            line.mode,
            configs.get(line.id, LineConfig()),
            defaults.get(line.product_id, {}),
        )
        for line in lines
    }


def per_by_line(compositions: Mapping[int, Composition]) -> dict[int, dict[int, int]]:
    """``line_id → {part_id → per}`` over the counted parts — the divisor the
    stock ledger reads a line's reservation back through."""
    return {line_id: {p.id: per for p, per in counted(comp)} for line_id, comp in compositions.items()}


def standard_per(part: ProductPart) -> int:
    """A part's per-unit count in the product's own kit — the named door for a
    reader that shows the product's standard (the stock shelf's row)."""
    return part.qty_per_unit
