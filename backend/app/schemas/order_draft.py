"""Explicit what-if work; estimates and source identity come from the server."""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from backend.app.schemas.farm_forecast import OrderForecastDetailOut
from backend.app.schemas.print_queue import UTCDatetime
from backend.app.schemas.project import PlanEnqueueTarget, PlanTotalsOut


class DraftEntry(BaseModel):
    entry_id: str = Field(min_length=1, max_length=100)
    line_id: int = Field(gt=0)
    plate_id: int = Field(gt=0)
    count: int = Field(ge=1, le=999)
    target: PlanEnqueueTarget = Field(default_factory=lambda: PlanEnqueueTarget(kind="auto"))
    source_token: str | None = Field(default=None, max_length=64)


class DraftPreviewRequest(BaseModel):
    schema_version: Literal[1] = 1
    client_revision: str = Field(min_length=1, max_length=100)
    inputs_token: str | None = Field(default=None, max_length=64)
    entries: list[DraftEntry] = Field(max_length=10_000)

    @model_validator(mode="after")
    def bounded(self):
        if sum(e.count for e in self.entries) > 10_000:
            raise ValueError("The draft exceeds the planning budget")
        if len({e.entry_id for e in self.entries}) != len(self.entries):
            raise ValueError("Draft entry ids must be unique")
        return self


class DraftCoverage(BaseModel):
    line_id: int
    part_id: int
    required: int
    planned: int
    missing: int
    surplus: int
    need: int = 0
    covered: int = 0


class DraftIssue(BaseModel):
    entry_id: str
    code: str


class WorkloadGroup(BaseModel):
    model: str | None = None
    line_id: int | None = None
    known_seconds: int
    unknown_prints: int
    total_seconds: int | None
    prints: int


class DraftWorkload(WorkloadGroup):
    by_model: list[WorkloadGroup] = []
    by_line: list[WorkloadGroup] = []


class DraftPreviewResponse(BaseModel):
    schema_version: int = 1
    client_revision: str
    inputs_token: str
    forecast: OrderForecastDetailOut | None = None
    forecast_error: str | None = None
    coverage: list[DraftCoverage]
    coverage_complete: bool
    issues: list[DraftIssue]
    order_ready_at: UTCDatetime = None
    totals: PlanTotalsOut
    workload: DraftWorkload
    comparison: dict = {"status": "no_baseline"}
