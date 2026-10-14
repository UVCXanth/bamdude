from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

RecoveryAction = Literal[
    "align_terminal_item", "fill_estimated_end_and_align", "release_orphan_header", "delete_stale_item"
]


class RecoveryPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["item", "header"]
    target_id: int = Field(gt=0, le=2_147_483_647)
    action: RecoveryAction
    confirmed_completed: StrictBool = False
    note: str = Field(default="", max_length=500)


class RecoveryApplyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    preview_token: str = Field(min_length=32, max_length=8192)
    confirmed: Literal[True]

    @field_validator("confirmed", mode="before")
    @classmethod
    def explicit_confirmation(cls, value):
        if value is not True:
            raise ValueError("explicit confirmation required")
        return value
