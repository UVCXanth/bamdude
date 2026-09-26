from typing import Any

from pydantic import BaseModel, Field, field_validator


class DeliveryMethodIn(BaseModel):
    name: str = Field(min_length=1, max_length=255)

    @field_validator("name", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        # ``mode="before"``: the length limits measure what is stored.
        return value.strip() if isinstance(value, str) else value


class DeliveryMethodOut(BaseModel):
    id: int
    name: str
    position: int
    # Contacts that pick this method — a used method cannot be deleted (409).
    contacts_count: int


class DeliveryMethodOrder(BaseModel):
    ids: list[int]
