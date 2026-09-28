"""The frontend reads the directed Bambu Studio matrix from this route."""

import pytest

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_model_matrix_route_is_static_and_directed(async_client):
    response = await async_client.get("/api/v1/printers/model-compatibility")
    assert response.status_code == 200, response.text
    matrix = response.json()["models"]
    assert "P1P" in matrix["P1S"]
    assert "N8" in matrix and matrix["N8"] == []
