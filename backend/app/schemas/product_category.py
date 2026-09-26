from typing import Any

from pydantic import BaseModel, Field, field_validator


class ProductCategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=128)

    @field_validator("name", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        # ``mode="before"``: the length limits measure what is stored.
        return value.strip() if isinstance(value, str) else value


class ProductCategoryOut(BaseModel):
    id: int
    name: str
    # Products filed under this category, catalog or not.
    products_count: int
