"""The operator's swap declaration of a source (swap-source-declaration spec r3 §5)."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, StrictBool, StrictInt

_HEX64 = r"^[0-9a-f]{64}$"


class SwapDeclarationRequest(BaseModel):
    """What the operator saw and decided: no default value -- a declaration is chosen, never preselected."""

    value: StrictBool
    expected_sha256: str = Field(pattern=_HEX64)
    expected_revision: str = Field(pattern=_HEX64)
    operation_id: UUID


class SwapRefreshJob(BaseModel):
    """One job the operator selected, with the revision it was listed under."""

    kind: Literal["queue", "auto_queue"]
    id: StrictInt = Field(gt=0)
    revision: str = Field(pattern=_HEX64)


class SwapRefreshRequest(BaseModel):
    """Apply the source's current declaration to these jobs -- explicitly named, never a batch or "all of them"."""

    declaration_id: UUID
    source_revision: str = Field(pattern=_HEX64)
    operation_id: UUID
    jobs: list[SwapRefreshJob] = Field(min_length=1, max_length=100)
