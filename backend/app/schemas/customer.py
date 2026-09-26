from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

CustomerKind = Literal["company", "regular", "private"]


def _clean_name(value: Any) -> Any:
    """Trim, and refuse a name that is nothing but whitespace.

    ⚠️ ``mode="before"`` on both validators, so the field's ``min_length`` and
    ``max_length`` measure what will be STORED. After the constraints they were
    decoration on one side and a lie on the other: ``"   "`` passed
    ``min_length=1`` and only this function caught it, while a 255-character
    name typed with a trailing space was a 422 for a length the very next step
    was about to remove.

    A non-string goes straight through: the field's own type check is what
    answers those, and raising here would be an internal error rather than a
    422. Both create and update run this, so the two paths cannot disagree
    about what a stored name looks like.
    """
    if not isinstance(value, str):
        return value
    trimmed = value.strip()
    if not trimmed:
        raise ValueError("name cannot be blank")
    return trimmed


class CustomerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    kind: CustomerKind = "company"
    notes: str | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _name_is_clean(cls, value: Any) -> Any:
        return _clean_name(value)


class CustomerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    kind: CustomerKind | None = None
    notes: str | None = None

    @field_validator("kind", mode="before")
    @classmethod
    def _kind_is_never_null(cls, value: Any) -> Any:
        """``customers.kind`` is NOT NULL: an explicit null is a 422, not a 500 from the flush."""
        if value is None:
            raise ValueError("kind cannot be null")
        return value

    @field_validator("name", mode="before")
    @classmethod
    def _name_is_never_null_and_is_clean(cls, value: Any) -> Any:
        """An omitted ``name`` leaves it alone; an explicit ``null`` is a 422.

        PATCH clears a field by sending ``null`` — but ``customers.name`` is NOT
        NULL, so clearing it would surface as an IntegrityError from the flush,
        i.e. a 500 on malformed input. A validator answers 422 instead. It does
        not fire when the field is absent: pydantic does not validate defaults.
        """
        if value is None:
            raise ValueError("name cannot be null")
        return _clean_name(value)


class CustomerListFigures(BaseModel):
    """What the LIST endpoint promises: counts and a price sum, no archive work.

    ``extra="allow"`` on purpose — a status this build has never heard of is
    counted under its own key rather than dropped, which is the rule both
    figure builders follow. Declaring the four known statuses still documents
    what a client may rely on.
    """

    model_config = ConfigDict(extra="allow")

    projects: int
    active: int
    completed: int
    cancelled: int
    total_price: float


class CustomerFigures(CustomerListFigures):
    """The DETAIL endpoint's superset — the keys that cost archive work.

    ``CustomerPage`` tells the two apart with ``'ordered' in figures``, so the
    list model must never grow these fields "for symmetry": an absent key means
    "not asked", a zero would mean "measured, and it is nothing".

    ``ordered`` / ``printed`` / ``covered_units`` leave cancelled orders out;
    ``total_cost`` counts every order (spec workshop-lists, rule 6).
    """

    ordered: int
    printed: int
    covered_units: int
    total_cost: float


class CustomerContactOut(BaseModel):
    """One contact; ``contacts[0]`` of a customer is its main contact (spec rule 12)."""

    id: int
    code: str
    name: str | None
    role: str | None
    phone: str | None
    email: str | None
    city: str | None
    delivery_method_id: int | None
    # Read through the join, never copied: renaming a method renames it everywhere.
    delivery_method_name: str | None
    delivery_details: str | None
    note: str | None
    # Orders that name this contact — what the form warns about before removing it.
    orders_count: int


class CustomerResponse(BaseModel):
    id: int
    code: str
    name: str
    kind: CustomerKind
    notes: str | None
    created_at: datetime
    updated_at: datetime
    contacts: list[CustomerContactOut]
    # The detail model first because SERIALISATION is what the order decides:
    # pydantic checks ``isinstance`` against the members in declaration order,
    # and ``CustomerFigures`` is a subclass of ``CustomerListFigures``, so the
    # broad member listed first would match a detail instance and drop the three
    # keys that cost archive work. Validation is not what this order is for —
    # both members are built here, never parsed from a client.
    figures: CustomerFigures | CustomerListFigures

    class Config:
        from_attributes = True
