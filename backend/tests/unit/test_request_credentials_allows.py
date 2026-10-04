"""``RequestCredentials.allows`` — the canonical gate asked without refusing (WS-13 E13 T14).

A read mask asks "may this caller see the field?" of the same gate a route would ask, so an API
key keeps answering for its scope AND its owner. A 403 is the answer "no"; anything else (401,
a broken gate) is not a mask decision and propagates.
"""

import pytest
from fastapi import HTTPException

from backend.app.core.auth import RequestCredentials


def _creds() -> RequestCredentials:
    return RequestCredentials(request=None, credentials=None, x_api_key=None)


@pytest.mark.asyncio
async def test_a_gate_that_lets_through_answers_yes():
    async def gate(**_):
        return None

    assert await _creds().allows(gate) is True


@pytest.mark.asyncio
async def test_a_gate_that_refuses_with_403_answers_no():
    async def gate(**_):
        raise HTTPException(status_code=403, detail="Missing permission")

    assert await _creds().allows(gate) is False


@pytest.mark.asyncio
async def test_an_unauthenticated_caller_is_not_a_mask_decision():
    async def gate(**_):
        raise HTTPException(status_code=401, detail="Not authenticated")

    with pytest.raises(HTTPException) as refused:
        await _creds().allows(gate)
    assert refused.value.status_code == 401


@pytest.mark.asyncio
async def test_the_gate_is_called_with_the_requests_own_credentials():
    seen = {}

    async def gate(**kwargs):
        seen.update(kwargs)

    creds = RequestCredentials(request="req", credentials="cred", x_api_key="key")
    await creds.allows(gate)
    assert seen == {"request": "req", "credentials": "cred", "x_api_key": "key"}
