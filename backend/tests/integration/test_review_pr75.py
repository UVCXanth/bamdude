"""Independent review: a routing restriction must not change sliced-model intent."""

import pytest
from sqlalchemy import select

from backend.app.models.auto_queue import AutoQueueItem
from backend.app.services.auto_queue_scheduler import AutoQueueScheduler
from backend.tests.integration.test_order_print_options import (
    test_real_promotion_explicit_order_choices_outlive_profile_changes as promotion_case,
)


@pytest.mark.asyncio
async def test_compatible_target_edit_retains_sliced_file_order_options(
    committing_client, db_session, tmp_path, printer_factory, monkeypatch
):
    original_tick = AutoQueueScheduler.tick

    async def change_routing_then_tick(scheduler):
        auto = (await db_session.execute(select(AutoQueueItem))).scalar_one()
        assert auto.target_model == "P1P"
        assert auto.order_print_options["P1P"]["bed_levelling"] == "off"
        source_before = auto.queue_source_id
        response = await committing_client.put(f"/api/v1/auto-queue/{auto.id}", json={"target_model": "P1S"})
        assert response.status_code == 200, response.text
        await db_session.refresh(auto)
        assert auto.target_model == "P1S"
        assert auto.queue_source_id == source_before  # No reslicing / rebalance.
        await original_tick(scheduler)

    monkeypatch.setattr(AutoQueueScheduler, "tick", change_routing_then_tick)
    await promotion_case(committing_client, db_session, tmp_path, printer_factory, monkeypatch, "P1S")
