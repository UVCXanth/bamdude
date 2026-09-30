"""A slot remembers the backup group it was last in while it held filament."""

from backend.app.services import backup_group_memory
from backend.app.services.bambu_mqtt import BambuMQTTClient


def setup_function():
    backup_group_memory.forget_all()


def test_a_dry_slot_keeps_its_group_and_a_reloaded_ungrouped_one_loses_it():
    backup_group_memory.observe("S", {0: [[0, 1]]}, loaded={0, 1})
    backup_group_memory.observe("S", {0: []}, loaded={1})
    assert backup_group_memory.membership("S") == {0: frozenset({0, 1})}


def test_an_unreported_field_changes_nothing():
    backup_group_memory.observe("S", {0: [[0, 1]]}, loaded={0, 1})
    backup_group_memory.observe("S", None, loaded=set())
    assert backup_group_memory.membership("S") == {0: frozenset({0, 1}), 1: frozenset({0, 1})}


def test_an_ams_ht_group_is_remembered_by_its_global_ids():
    backup_group_memory.observe("S", {0: [[128, 129]]}, loaded={128, 129})
    backup_group_memory.observe("S", {0: []}, loaded={129})
    assert backup_group_memory.membership("S") == {128: frozenset({128, 129})}


def test_a_slot_that_ran_dry_keeps_the_group_through_the_real_client():
    client = BambuMQTTClient("127.0.0.1", "SYNTHETIC-TWIN", "00000000", model="P1S")
    client.state.connected = True

    def trays(*loaded):
        return [
            {"id": t, "tray_type": "PETG", "tray_color": "000000FF"} if t in loaded else {"id": t, "tray_type": ""}
            for t in range(4)
        ]

    client._process_message(
        {"print": {"command": "push_status", "ams": {"ams": [{"id": 0, "tray": trays(0, 1)}]}, "filam_bak": [3]}}
    )
    client._process_message(
        {"print": {"command": "push_status", "ams": {"ams": [{"id": 0, "tray": trays(1)}]}, "filam_bak": []}}
    )
    snap = client.get_feed_snapshot(1)
    assert [s.id for s in snap.sources] == [1]
    assert snap.backup_membership[0] == (0, 1)


def test_the_memory_outlives_a_new_client_for_the_same_printer():
    backup_group_memory.observe("SYNTHETIC-TWIN-2", {0: [[0, 1]]}, loaded={0, 1})
    client = BambuMQTTClient("127.0.0.1", "SYNTHETIC-TWIN-2", "00000000", model="P1S")
    client.state.connected = True
    assert client.get_feed_snapshot(1).backup_membership[0] == (0, 1)
