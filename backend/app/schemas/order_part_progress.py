"""Read-only part progress, separate from the planner's greedy attribution."""

from typing import Literal

from pydantic import BaseModel, Field


class PartContributionOut(BaseModel):
    source_kind: Literal["archive", "printer_queue", "auto_queue", "recipe"]
    source_id: int
    filename: str
    library_file_id: int | None = None
    recipe_id: int | None = None
    plate_index: int | None = None
    runs: int = 1
    expected_qty: int | None = None
    completed_good_qty: int = 0
    printing_qty: int = 0
    queued_qty: int = 0
    rejected_qty: int = 0


class OrderPartProgressRowOut(BaseModel):
    order_line_id: int
    product_id: int
    product_name: str
    part_id: int
    part_name: str
    required_qty: int
    free_stock_qty: int = 0
    allocated_stock_qty: int = 0
    completed_good_qty: int = 0
    printing_qty: int = 0
    queued_qty: int = 0
    rejected_qty: int = 0
    secured_qty: int = 0
    remaining_qty: int = 0
    contributions: list[PartContributionOut] = Field(default_factory=list)


class UnallocatedPartProgressOut(PartContributionOut):
    reason: Literal["ambiguous", "unallocated", "missing_part_rows", "missing_recipe"]
    part_name: str | None = None
    candidate_pairs: list[tuple[int, int]] = Field(default_factory=list)


class OrderPartProgressOut(BaseModel):
    order_id: int
    scope_limited: bool = False
    parts: list[OrderPartProgressRowOut] = Field(default_factory=list)
    unallocated: list[UnallocatedPartProgressOut] = Field(default_factory=list)
