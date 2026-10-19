"""Read-only whole-plate quantity proposals; applying uses the ordinary line writer."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field

PositiveId = Annotated[int, Field(strict=True, gt=0)]
FitQuantity = Annotated[int, Field(strict=True, ge=1, le=1_000_000)]


class PlateFitRequest(BaseModel):
    around: FitQuantity
    plate_ids: list[PositiveId] | None = Field(default=None, max_length=64)
    steps: int = Field(default=1, ge=1, le=4, strict=True)
    replace_pending: bool = False


class PlateFitRun(BaseModel):
    plate_id: PositiveId
    count: FitQuantity


class PlateFitConfirmation(BaseModel):
    basis: str = Field(min_length=64, max_length=64, pattern=r"^[0-9a-f]+$")
    plate_ids: list[PositiveId] = Field(min_length=1, max_length=64)
    runs: list[PlateFitRun] = Field(max_length=64)
    acknowledge_large_change: bool = False
    replace_pending: bool = False
    acknowledge_queue_change: bool = False


class PlateFitPart(BaseModel):
    part_id: int
    name: str
    required: int
    allocated: int
    completed: int
    printing: int
    queued: int
    other_coverage: int = 0
    free_stock: int = 0
    new_printed: int


class PlateFitOption(BaseModel):
    quantity: int
    from_finished: int = 0
    from_kits: int = 0
    stock_parts: dict[int, int] = Field(default_factory=dict)
    runs: list[PlateFitRun]
    parts: list[PlateFitPart]
    print_time_seconds: int | None
    filament_used_grams: float | None


class PlateFitPlate(BaseModel):
    plate_id: int
    library_file_id: int
    plate_index: int
    print_time_seconds: int | None = None
    filament_used_grams: float | None = None
    filename: str | None = None
    printer_model: str | None = None
    hidden: bool = False


class PlateFitResponse(BaseModel):
    line_id: int
    current_quantity: int
    around: int
    basis: str
    plate_ids: list[int]
    plates: list[PlateFitPlate] = Field(default_factory=list)
    options: list[PlateFitOption]
    lower: Literal["found", "none", "limited"]
    upper: Literal["found", "none", "limited"]
    current: Literal["found", "none", "limited"]
    quantity_limit: int = 1_000_000
    removable_auto_ids: list[int] = Field(default_factory=list)
