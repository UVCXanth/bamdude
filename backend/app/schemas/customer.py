from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator

CustomerKind = Literal["company", "regular", "private"]
_CONTACT_TEXT = ("name", "role", "phone", "email", "city", "delivery_details", "note")


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


class CustomerContactIn(BaseModel):
    """One row of the customer form. With ``id`` it updates that contact; without,
    it creates one. Blanks become null; a row with nothing in it is dropped."""

    id: int | None = None
    name: str | None = Field(default=None, max_length=255)
    role: str | None = Field(default=None, max_length=255)
    phone: str | None = Field(default=None, max_length=255)
    email: str | None = Field(default=None, max_length=255)
    city: str | None = Field(default=None, max_length=255)
    delivery_method_id: int | None = None
    delivery_details: str | None = Field(default=None, max_length=255)
    note: str | None = None

    @field_validator(*_CONTACT_TEXT, mode="before")
    @classmethod
    def _blank_is_null(cls, value: Any) -> Any:
        # ``mode="before"``: the lengths measure what is stored, as ``_clean_name`` does.
        if isinstance(value, str):
            return value.strip() or None
        return value

    def is_empty(self) -> bool:
        return all(getattr(self, field) is None for field in (*_CONTACT_TEXT, "delivery_method_id"))


class CustomerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    kind: CustomerKind = "company"
    notes: str | None = None
    contacts: list[CustomerContactIn] = Field(default_factory=list)
    # A namesake is a warning, not a ban (WS-13 E11 A01): true = made knowingly.
    allow_duplicate_name: bool = False

    @field_validator("name", mode="before")
    @classmethod
    def _name_is_clean(cls, value: Any) -> Any:
        return _clean_name(value)


class CustomerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    kind: CustomerKind | None = None
    notes: str | None = None
    # Sent whole: a contact missing from the list is removed. Absent = leave them alone.
    contacts: list[CustomerContactIn] | None = None
    # Renaming onto a namesake knowingly (WS-13 E11 A01); asked only when the name changes.
    allow_duplicate_name: bool = False

    @field_validator("kind", "contacts", mode="before")
    @classmethod
    def _never_null(cls, value: Any, info: ValidationInfo) -> Any:
        """``customers.kind`` is NOT NULL and a null contact list means nothing:
        an explicit null is a 422, not a 500 from the flush or a silent wipe."""
        if value is None:
            raise ValueError(f"{info.field_name} cannot be null")
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
    # Null for a caller without orders:read (WS-13 E13 O12).
    orders_count: int | None


class CustomerOption(BaseModel):
    """``GET /customers/options`` — a customer as a picker names it (WS-13 E13 O12)."""

    id: int
    code: str
    name: str


class ContactOption(BaseModel):
    """``GET /customers/{id}/contact-options`` — who may receive an order: what the order
    itself shows of its contact, never the phone or the address (WS-13 E13 O12)."""

    id: int
    code: str
    name: str | None
    role: str | None


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
    # Null for a caller without orders:read (WS-13 E13 O12).
    figures: CustomerFigures | CustomerListFigures | None

    class Config:
        from_attributes = True
