from typing import Literal

from pydantic import BaseModel, Field, model_validator

from backend.app.schemas.order_draft import DraftEntry


class WorkingEntry(DraftEntry):
    count: int = Field(ge=0, le=999)
    manual: bool = False
    protected_count: int | None = Field(default=None, ge=0, le=999)

    @model_validator(mode="after")
    def protection(self):
        if self.protected_count is None:
            self.protected_count = self.count if self.manual else 0
        if self.protected_count > self.count or not self.manual and self.protected_count:
            raise ValueError("Protected work must belong to this entry")
        return self


class WorkingWrite(BaseModel):
    expected_revision: int = Field(ge=0)
    inputs_token: str | None = Field(default=None, max_length=64)
    entries: list[WorkingEntry] = Field(max_length=10000)

    @model_validator(mode="after")
    def bounds(self):
        if sum(e.count for e in self.entries) > 10000 or len({e.entry_id for e in self.entries}) != len(self.entries):
            raise ValueError("The plan exceeds its budget or repeats an entry id")
        if len({(e.line_id, e.plate_id) for e in self.entries}) != len(self.entries):
            raise ValueError("Combine copies of one file within an order line")
        return self


class WorkingAction(BaseModel):
    expected_revision: int = Field(ge=0)
    expected_saved_revision: int = Field(ge=0)
    expected_epoch: int = Field(ge=0)
    inputs_token: str | None = Field(default=None, max_length=64)


class ReplanRequest(BaseModel):
    expected_revision: int = Field(ge=0)
    kind: Literal["remainder", "rebuild"]
    inputs_token: str | None = Field(default=None, max_length=64)
    apply: bool = False
    proposal_token: str | None = Field(default=None, max_length=64)
    proposal_entries: list[WorkingEntry] | None = Field(default=None, max_length=10000)


class SubmissionPart(BaseModel):
    entry_id: str = Field(min_length=1, max_length=100)
    count: int = Field(ge=1, le=999)


class SubmissionRequest(BaseModel):
    operation_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    expected_revision: int = Field(ge=1)
    parts: list[SubmissionPart] = Field(min_length=1, max_length=10000)

    @model_validator(mode="after")
    def unique_parts(self):
        if len({p.entry_id for p in self.parts}) != len(self.parts) or sum(p.count for p in self.parts) > 10000:
            raise ValueError("Each part is addressed once within the planning budget")
        return self


class SubmissionCancellation(BaseModel):
    reason: str = Field(min_length=1, max_length=500)
