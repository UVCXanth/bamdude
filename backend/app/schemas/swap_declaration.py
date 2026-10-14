"""The operator's swap declaration of a source (swap-source-declaration spec r3 §5)."""

from uuid import UUID

from pydantic import BaseModel, Field, StrictBool

_HEX64 = r"^[0-9a-f]{64}$"


class SwapDeclarationRequest(BaseModel):
    """What the operator saw and decided: no default value -- a declaration is chosen, never preselected."""

    value: StrictBool
    expected_sha256: str = Field(pattern=_HEX64)
    expected_revision: str = Field(pattern=_HEX64)
    operation_id: UUID
