"""The runout tail is a latch, and a joined print's journal waits for its seed (post-rebuild F).

Spec: vault ``60-specs/ams-tail-refill-attribution-spec.md`` — F-R1 (the tail latch holds
until the feed leaves the external sentinel), F-R2 (``tail_start`` / ``feed_return``), F-R4
(the journal hold before the first tray branch of a joined print, its seed, and a return
first seen after an observation gap). Acceptance rows F01, F02, F04, F05, F07.

X2D incident 2026-10-22: AMS0/T0 ran dry (tray_now → 254, slot empty), the operator put a
new reel in while the tube still fed the old one, and the next 254 became a false tray change
because the slot no longer read empty.
"""

from unittest.mock import MagicMock

import pytest

from backend.app.services.bambu_mqtt import BambuMQTTClient

ORIGIN = 2


def ams(tray_type: str) -> dict:
    return {"ams": [{"id": 0, "tray": [{"id": ORIGIN, "tray_type": tray_type, "tray_color": ""}]}]}


@pytest.fixture
def client():
    """A client that watched this print start, on layer 23, origin slot 2 just emptied."""
    c = BambuMQTTClient(ip_address="1.2.3.4", serial_number="20PTAIL02", access_code="1")
    c._was_running = True
    c._completion_triggered = False
    c.state.state = "RUNNING"
    c.state.layer_num = 23
    c.state.total_layers = 200
    c.state.tray_now = ORIGIN
    c.state.last_loaded_tray = ORIGIN
    c.state.tray_change_log = [(ORIGIN, 0)]
    c.state.raw_data = {"ams": ams(""), "vt_tray": [{"id": 254}, {"id": 255}]}
    c.on_tray_change = MagicMock()
    c.on_usage_event = MagicMock()
    c.on_feed_event = MagicMock()
    return c


def feed(client, tray, *, layer=None):
    if layer is not None:
        client.state.layer_num = layer
    client._process_message({"print": {"ams": {"tray_now": str(tray)}}})


def refill(client, tray_type="PLA"):
    """A reel goes in (or our own ams_filament_setting echoes back): the slot reads loaded."""
    client.state.raw_data["ams"] = ams(tray_type)


def feed_events(client):
    """The tail facts this client journals, in the order it observed them: those a restart
    seed's replay batch holds (post-rebuild F3: one batch, never a callback per fact), then
    those main's callback received live."""
    replayed = [
        (f.kind, f.tray, f.layer, f.after_gap)
        for batch in client._replay_batches
        for f in batch.facts
        if f.kind in ("tail_start", "feed_return")
    ]
    return replayed + [c.args for c in client.on_feed_event.call_args_list]


def tray_changes(client):
    """The tray changes this client journals: the replay batch's, then the live callback's."""
    replayed = [(f.tray, f.layer) for batch in client._replay_batches for f in batch.facts if f.kind == "tray_change"]
    return replayed + [c.args for c in client.on_tray_change.call_args_list]


# ── F-R1 / F01 / F02 · the latch ─────────────────────────────────────────────


def test_a_refill_during_the_tail_does_not_turn_the_next_sentinel_into_a_tray_change(client):
    """F01: the slot reads loaded again (new reel, or our own echo) while the tube still feeds
    the old reel — every further 254 is still the tail."""
    feed(client, 254)
    refill(client)
    feed(client, 254, layer=24)
    feed(client, 254, layer=25)

    assert client.state.tray_change_log == [(ORIGIN, 0)]
    client.on_tray_change.assert_not_called()
    assert feed_events(client) == [("tail_start", ORIGIN, 23, False)]
    assert client.open_tail() == (ORIGIN, 23)


def test_the_return_to_the_origin_closes_the_episode_with_a_feed_return(client):
    """F02: the boundary is the layer the feed came back, not the assignment."""
    feed(client, 254)
    refill(client)
    feed(client, ORIGIN, layer=27)

    assert feed_events(client) == [("tail_start", ORIGIN, 23, False), ("feed_return", ORIGIN, 27, False)]
    assert client.state.tray_change_log == [(ORIGIN, 0)]
    client.on_tray_change.assert_not_called()
    assert client.open_tail() is None


def test_an_unreadable_sentinel_is_not_a_return(client):
    """F05: 255 is no proven feed; the episode stays open until the origin is seen."""
    feed(client, 254)
    feed(client, 255, layer=24)
    assert client.open_tail() == (ORIGIN, 23)
    feed(client, ORIGIN, layer=25)
    assert feed_events(client)[-1] == ("feed_return", ORIGIN, 25, False)


def test_a_backup_to_another_ams_tray_closes_the_episode_as_an_ordinary_tray_change(client):
    """F05: the AMS backup took over — the chronology says so, no feed_return."""
    feed(client, 254)
    feed(client, 3, layer=26)

    assert feed_events(client) == [("tail_start", ORIGIN, 23, False)]
    client.on_tray_change.assert_called_once_with(3, 26)
    assert client.state.tray_change_log == [(ORIGIN, 0), (3, 26)]
    assert client.open_tail() is None


def test_a_genuine_external_and_a_bmcu_blip_open_no_episode(client):
    """F05: the origin still holds filament — the existing proof of a tail is absent."""
    refill(client)
    feed(client, 254)
    feed(client, ORIGIN)

    client.on_feed_event.assert_not_called()
    assert client.state.tray_change_log == [(ORIGIN, 0), (254, 23), (ORIGIN, 23)]


def test_a_new_episode_after_a_return_opens_again(client):
    """F07: two tails of one print are two episodes."""
    feed(client, 254)
    refill(client)
    feed(client, ORIGIN, layer=30)
    refill(client, "")
    feed(client, 254, layer=90)

    assert [e[0] for e in feed_events(client)] == ["tail_start", "feed_return", "tail_start"]
    assert feed_events(client)[-1] == ("tail_start", ORIGIN, 90, False)


def test_a_new_print_forgets_the_latch(client):
    feed(client, 254)
    client._previous_gcode_state = "IDLE"
    client._was_running = False
    client._process_message({"print": {"gcode_state": "RUNNING", "gcode_file": "next.3mf"}})
    assert client.open_tail() is None


# ── F-R4 / F04 · the journal hold of a joined print and its seed ─────────────


@pytest.fixture
def joined():
    """A client created mid-print (a process restart): it has not seen this print start."""
    c = BambuMQTTClient(ip_address="1.2.3.4", serial_number="20PTAIL03", access_code="1")
    c._previous_gcode_state = "RUNNING"
    c._previous_gcode_file = "plate.3mf"
    c.state.raw_data = {"ams": ams(""), "vt_tray": [{"id": 254}, {"id": 255}]}
    c.on_tray_change = MagicMock()
    c.on_usage_event = MagicMock()
    c.on_feed_event = MagicMock()
    c.on_print_running_observed = MagicMock()
    return c


def first_packet(client, tray, layer=40):
    """The packet that tells this client a print is running — its tray branch runs FIRST."""
    client._process_message(
        {
            "print": {
                "ams": {"tray_now": str(tray)},
                "gcode_state": "RUNNING",
                "gcode_file": "plate.3mf",
                "layer_num": layer,
                "total_layer_num": 200,
            }
        }
    )


def test_a_joined_print_journals_nothing_before_its_seed(joined):
    first_packet(joined, 254)
    feed(joined, 254, layer=41)

    joined.on_tray_change.assert_not_called()
    joined.on_feed_event.assert_not_called()
    payload = joined.on_print_running_observed.call_args.args[0]
    assert payload["_journal_generation"] == joined.journal_generation()


def test_the_seed_restores_an_open_episode_and_replays_what_arrived_in_order(joined):
    """F04: the packets before and during the seed — the first one included — are processed
    after it, in order; the restored latch is not lost to the sentinel."""
    first_packet(joined, 254)
    refill(joined)
    feed(joined, 254, layer=41)
    feed(joined, ORIGIN, layer=43)
    generation = joined.on_print_running_observed.call_args.args[0]["_journal_generation"]

    assert joined.seed_usage_journal(generation, log=[(ORIGIN, 0)], last_loaded_tray=ORIGIN, tail_origin=ORIGIN)

    assert feed_events(joined) == [("feed_return", ORIGIN, 43, False)]
    joined.on_tray_change.assert_not_called()
    assert joined.state.tray_change_log == [(ORIGIN, 0)]


def test_a_return_first_seen_after_the_gap_says_so(joined):
    """F04: the first fresh status already shows the origin — the return happened in the gap."""
    refill(joined)
    first_packet(joined, ORIGIN, layer=50)
    generation = joined.on_print_running_observed.call_args.args[0]["_journal_generation"]

    joined.seed_usage_journal(generation, log=[(ORIGIN, 0)], last_loaded_tray=ORIGIN, tail_origin=ORIGIN)

    assert feed_events(joined) == [("feed_return", ORIGIN, 50, True)]


def test_a_tail_that_began_while_we_were_away_opens_from_the_seeded_origin(joined):
    """F04: no episode in the journal yet; the replayed sentinel with an empty origin opens one."""
    first_packet(joined, 254, layer=45)
    generation = joined.on_print_running_observed.call_args.args[0]["_journal_generation"]

    joined.seed_usage_journal(generation, log=[(ORIGIN, 0)], last_loaded_tray=ORIGIN, tail_origin=None)

    assert feed_events(joined) == [("tail_start", ORIGIN, 45, True)]
    joined.on_tray_change.assert_not_called()


def test_a_seed_of_another_print_is_refused(joined):
    """F04: a seed computed for the print before is never applied to the next one."""
    first_packet(joined, 254)
    stale = joined.on_print_running_observed.call_args.args[0]["_journal_generation"]
    joined._previous_gcode_state = "IDLE"
    joined._was_running = False
    joined._process_message({"print": {"gcode_state": "RUNNING", "gcode_file": "next.3mf"}})

    assert not joined.seed_usage_journal(stale, log=[(ORIGIN, 0)], last_loaded_tray=ORIGIN, tail_origin=ORIGIN)
    assert joined.open_tail() is None


def packet(client, tray, layer=None):
    """A real status packet: the tray and, when it carries one, its own layer — no state prepared."""
    data = {"ams": {"tray_now": str(tray)}}
    if layer is not None:
        data["layer_num"] = layer
    client._process_message({"print": data})


def test_each_held_fact_keeps_its_own_packets_layer(joined):
    """F-R4: a held tray report is journaled at the layer of the packet that carried it —
    not the layer of the packet before, nor the layer at the seed."""
    first_packet(joined, 254, layer=40)
    refill(joined)
    packet(joined, ORIGIN, layer=45)
    generation = joined.journal_generation()

    assert joined.seed_usage_journal(generation, log=[(ORIGIN, 0)], last_loaded_tray=ORIGIN, tail_origin=None)

    assert feed_events(joined) == [("tail_start", ORIGIN, 40, True), ("feed_return", ORIGIN, 45, False)]


def test_a_slow_seed_replays_several_transitions_in_their_own_order(joined):
    """F-R4: two tails and their returns held through a long seed come back chronological."""
    first_packet(joined, 254, layer=40)
    refill(joined)
    packet(joined, ORIGIN, layer=45)
    refill(joined, "")
    packet(joined, 254, layer=60)
    refill(joined)
    packet(joined, ORIGIN, layer=72)
    joined.state.layer_num = 90  # the seed lands much later

    assert joined.seed_usage_journal(
        joined.journal_generation(), log=[(ORIGIN, 0)], last_loaded_tray=ORIGIN, tail_origin=None
    )

    assert [(e[0], e[2]) for e in feed_events(joined)] == [
        ("tail_start", 40),
        ("feed_return", 45),
        ("tail_start", 60),
        ("feed_return", 72),
    ]


def test_a_packet_without_a_layer_takes_the_layer_already_known(joined):
    """A delta that carries no layer was sent on the layer already reported."""
    first_packet(joined, ORIGIN, layer=40)
    refill(joined, "")
    packet(joined, 254)
    refill(joined)
    packet(joined, ORIGIN, layer=44)

    assert joined.seed_usage_journal(
        joined.journal_generation(), log=[(ORIGIN, 0)], last_loaded_tray=ORIGIN, tail_origin=None
    )

    assert [(e[0], e[2]) for e in feed_events(joined)] == [("tail_start", 40), ("feed_return", 44)]


def test_a_fact_seen_before_any_layer_is_a_gap_boundary_never_a_later_one_backwards(joined):
    """No layer at all yet: the boundary is the next one observed and says it was not seen
    at its own layer (a gap), and the replay never runs backwards."""
    joined._process_message(
        {"print": {"ams": {"tray_now": "254"}, "gcode_state": "RUNNING", "gcode_file": "plate.3mf"}}
    )
    refill(joined)
    packet(joined, ORIGIN, layer=50)
    joined.state.layer_num = 90  # the seed lands much later

    assert joined.seed_usage_journal(
        joined.journal_generation(), log=[(ORIGIN, 0)], last_loaded_tray=ORIGIN, tail_origin=None
    )

    events = feed_events(joined)
    assert events == [("tail_start", ORIGIN, 50, True), ("feed_return", ORIGIN, 50, False)]


def test_a_live_tray_change_is_logged_at_its_own_packets_layer(client):
    """The non-held path reads the same layer: the packet's own, not the one before."""
    packet(client, 3, layer=26)

    client.on_tray_change.assert_called_once_with(3, 26)
    assert client.state.tray_change_log == [(ORIGIN, 0), (3, 26)]


# ── F-R4 · lost observations become an explicit unknown, never the old chronology ──


def test_held_reports_lost_to_the_bound_leave_an_unknown_feed_from_the_first_lost_layer(joined, monkeypatch):
    """M2: more tray reports than the hold keeps — the oldest go, and the replay says the
    feed is unknown from the first lost layer instead of joining the kept ones to the old
    chronology."""
    import backend.app.services.bambu_mqtt as mqtt
    from backend.app.utils.usage_attribution import UNKNOWN_FEED

    monkeypatch.setattr(mqtt, "_JOURNAL_PENDING_LIMIT", 3)
    first_packet(joined, 0, layer=10)
    for layer, tray in ((12, 1), (14, 0), (16, 1), (18, 0)):
        packet(joined, tray, layer=layer)

    assert joined.seed_usage_journal(
        joined.journal_generation(), log=[(ORIGIN, 0)], last_loaded_tray=ORIGIN, tail_origin=None
    )

    assert joined.state.tray_change_log == [(ORIGIN, 0), (UNKNOWN_FEED, 10), (0, 14), (1, 16), (0, 18)]
    assert tray_changes(joined) == [(UNKNOWN_FEED, 10), (0, 14), (1, 16), (0, 18)]


def test_a_journal_that_never_got_its_seed_is_released_with_an_unknown_feed(joined):
    """M2: the seed failed for good — the hold ends with the feed unknown from the start
    (nothing before the restart could be read back) and the held reports journaled in order."""
    from backend.app.utils.usage_attribution import UNKNOWN_FEED

    first_packet(joined, 1, layer=40)
    packet(joined, 3, layer=45)

    assert joined.abandon_journal_hold(joined.journal_generation())

    assert joined.state.tray_change_log == [(UNKNOWN_FEED, 0), (1, 40), (3, 45)]
    assert not joined.journal_held()
    packet(joined, 1, layer=50)  # observed live from here
    assert joined.state.tray_change_log[-1] == (1, 50)


def test_a_release_with_nothing_held_names_the_feed_seen_now(joined):
    """M2: no tray report was held — the feed the printer names now is the first observed one."""
    from backend.app.utils.usage_attribution import UNKNOWN_FEED

    joined._process_message(
        {"print": {"gcode_state": "RUNNING", "gcode_file": "plate.3mf", "layer_num": 40, "total_layer_num": 200}}
    )
    joined.state.tray_now = 2

    assert joined.abandon_journal_hold(joined.journal_generation())

    assert joined.state.tray_change_log == [(UNKNOWN_FEED, 0), (2, 40)]


def test_a_release_is_refused_for_another_print_or_a_seeded_one(joined):
    first_packet(joined, 1, layer=40)
    stale = joined.journal_generation()
    assert joined.seed_usage_journal(stale, log=[(1, 0)], last_loaded_tray=1, tail_origin=None)
    assert not joined.abandon_journal_hold(stale)  # already seeded
    assert not joined.abandon_journal_hold(stale + 1)  # not the print it is on


def test_without_a_seed_the_journal_stays_held(joined):
    """F04: a failed seed opens nothing with an invented clean state."""
    first_packet(joined, 254)
    for layer in range(41, 46):
        feed(joined, ORIGIN if layer % 2 else 254, layer=layer)
    joined.on_tray_change.assert_not_called()
    joined.on_feed_event.assert_not_called()
    assert joined.open_tail() is None


def test_a_recreated_client_keeps_the_latch_and_the_chronology(client):
    """F04: a new MQTT client in the same process carries the episode; its first status after
    the reconnect gap closing the episode is a gap return."""
    feed(client, 254)
    successor = BambuMQTTClient(ip_address="1.2.3.4", serial_number="20PTAIL02", access_code="1")
    successor.on_tray_change = MagicMock()
    successor.on_feed_event = MagicMock()
    successor.carry_print_lifecycle_from(client)
    successor.state.raw_data = {"ams": ams("PLA"), "vt_tray": [{"id": 254}]}
    successor.state.layer_num = 31

    assert successor.state.tray_change_log == [(ORIGIN, 0)]
    assert successor.open_tail() == (ORIGIN, 23)
    feed(successor, ORIGIN, layer=31)
    assert feed_events(successor) == [("feed_return", ORIGIN, 31, True)]
    successor.on_tray_change.assert_not_called()


def test_an_unknown_feed_never_goes_back_before_the_chronology_it_follows(joined, monkeypatch):
    """Review r1: a lost report carried no layer — the unknown feed starts no earlier than the
    chronology's last entry, so normalizing never drops the entries before it."""
    import backend.app.services.bambu_mqtt as mqtt
    from backend.app.utils.usage_attribution import UNKNOWN_FEED

    monkeypatch.setattr(mqtt, "_JOURNAL_PENDING_LIMIT", 2)
    joined._process_message({"print": {"ams": {"tray_now": "0"}, "gcode_state": "RUNNING", "gcode_file": "plate.3mf"}})
    packet(joined, 1, layer=35)
    packet(joined, 0, layer=37)

    assert joined.seed_usage_journal(
        joined.journal_generation(), log=[(ORIGIN, 0), (3, 30)], last_loaded_tray=3, tail_origin=None
    )

    assert joined.state.tray_change_log == [(ORIGIN, 0), (3, 30), (UNKNOWN_FEED, 30), (1, 35), (0, 37)]


def test_a_journal_released_at_completion_still_states_the_feed_unknown(joined):
    """Review r1 #1: the print completed before the seed came — the release still writes the
    unknown feed and the held reports, although the print is no longer running."""
    from backend.app.utils.usage_attribution import UNKNOWN_FEED

    first_packet(joined, 1, layer=40)
    joined._completion_triggered = True

    assert joined.abandon_journal_hold(joined.journal_generation())

    assert joined.state.tray_change_log == [(UNKNOWN_FEED, 0), (1, 40)]
    assert tray_changes(joined) == [(UNKNOWN_FEED, 0), (1, 40)]
