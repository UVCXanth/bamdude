"""Process-wide state keyed by printer never outlives a test (conftest ``_clean_print_lifecycle_registries``).

Every test gets a fresh database, so printer ids repeat: printer 1 of the next test inherits whatever printer 1 of
the previous one left in memory. A plate gate left that way made the scheduler skip the next test's printer, and the
dispatch-attempt tests failed only when xdist put them after ``test_interrupted_dispatch`` on one worker
(2026-10-26, vault ``70-research/test-isolation-printer-registries-leak-2026-10-26``).
"""

import importlib

from backend.tests.conftest import PRINTER_KEYED_REGISTRIES, clean_printer_keyed_registries

#: ``printer_manager`` containers that live for the process on purpose: connection caches, which tests change only
#: through ``monkeypatch`` (restored), and which the leak census found clean.
PROCESS_SCOPED = {
    "_clients": "the MQTT client per printer; tests install one with monkeypatch.setitem",
    "_models": "model cache filled alongside a client",
    "_printer_info": "name/serial cache filled alongside a client",
    "_connected_at": "connection time, filled alongside a client",
    "_client_generations": "connection generation counter, monotonic for the process",
    "_last_trays": "last tray snapshot of a connected client",
}


def _container(module_name, path):
    obj = importlib.import_module(module_name)
    for part in path.split("."):
        obj = getattr(obj, part)
    return obj


def test_every_listed_registry_is_emptied_between_tests():
    for module_name, path in PRINTER_KEYED_REGISTRIES:
        try:
            registry = _container(module_name, path)
        except AttributeError:
            continue  # created lazily by its owner: nothing to leak until it exists
        if isinstance(registry, set):
            registry.add(1)
        else:
            registry[1] = object()
    clean_printer_keyed_registries()
    left = [path for module_name, path in PRINTER_KEYED_REGISTRIES if _filled(module_name, path)]
    assert left == []


def _filled(module_name, path):
    try:
        return bool(_container(module_name, path))
    except AttributeError:
        return False


def test_every_printer_manager_container_is_either_cleaned_or_process_scoped():
    """A new dict/set on ``printer_manager`` needs a decision: cleaned per test, or process-scoped with a reason."""
    from backend.app.services.printer_manager import printer_manager

    cleaned = {
        path.split(".", 1)[1] for module_name, path in PRINTER_KEYED_REGISTRIES if path.startswith("printer_manager.")
    }
    undecided = sorted(
        name
        for name, value in vars(printer_manager).items()
        if isinstance(value, (dict, set)) and name not in cleaned and name not in PROCESS_SCOPED
    )
    assert undecided == [], undecided
