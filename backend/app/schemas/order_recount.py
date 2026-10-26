"""An explicit physical count of loose printed parts still held for a line."""

from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator


class CountedPart(BaseModel):
    model_config = ConfigDict(extra="forbid")
    part_id: StrictInt = Field(gt=0)
    actual: StrictInt = Field(ge=0, le=1_000_000)


class RecountWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_token: str = Field(min_length=64, max_length=64)
    reason: str = Field(min_length=1, max_length=1000)
    parts: list[CountedPart] = Field(min_length=1, max_length=500)

    @field_validator("reason")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("A recount reason is required")
        return value.strip()

    @field_validator("parts")
    @classmethod
    def unique_parts(cls, value):
        if len({p.part_id for p in value}) != len(value):
            raise ValueError("Each part must occur once")
        return value
