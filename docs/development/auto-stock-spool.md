# Automatic full stock spool assignment (issue #66)

## Existing solutions considered

1. BamDude's manual/pre-assignment and RFID auto-assignment (`docs.bamdude.top/features/inventory/`): authoritative inventory links, journal and MQTT publisher already exist and remain the implementation path. Manual assignment alone needs an operator action for every untagged reel. RFID identifies tagged spools and takes priority, but cannot identify arbitrary untagged stock.
2. SpoolmanSync (`github.com/gibz104/SpoolmanSync`): an existing Home Assistant/Spoolman integration. It would add an external inventory owner and does not implement BamDude's runout journal or printer queue policies. It is incompatible with the requested built-in inventory behavior; no new Spoolman integration is added.
3. SQLAlchemy's supported transactions/row locks (`docs.sqlalchemy.org/en/20/orm/queryguide/dml.html`) plus the existing SQLite write-lock helper arbitrate stock claims. No scheduler, persistent event subsystem or alternate usage ledger is introduced.

## Contract and behavior

`Printer.ams_policies.auto_stock_spool` contains `enabled` (default false) and nullable `group`. An enabled policy requires a group with exact `material`, `rgba` (RRGGBBAA), `brand`, `subtype`, `filament_family_id`, `label_weight`. Names are display only. Changes need printer-edit **and** inventory-update authority. Other AMS policy namespaces survive patches. The UI lives in Edit Printer, with descriptive help and the existing Select control; EN/UK translations are included.

`GET /api/v1/inventory/spools/auto-stock-groups` needs inventory-read authority and returns eligible strict groups with `available_count`. Full means actual `weight_used=0` (not the resettable display counter), no previous print usage, positive label weight, unarchived, untagged, solid 1.75 mm filament and no assignment anywhere. An explicit historical `added_full=false` excludes a partial spool; NULL is allowed because ordinary internal single/bulk creation leaves that marker unset. This matches the inventory's remaining-weight calculation without backfilling stored records. Selection is FIFO by `created_at,id`. No inventory spool is fabricated. An exhausted selected group stays selected; no silent fallback to another color/profile/brand.

Insertion requires a fresh local printer status frame with a firmware presence bit going false to true on the same connection. The canonical bit decoder supports regular AMS, AMS HT and normalized A2L AMS Lite. Startup/reconnect only establish a baseline. Missing/invalid bits, command acknowledgements, shutdown zeros and external holders cannot admit a claim. This is an operator declaration that the inserted spool is full and from the selected group; telemetry cannot prove its individual inventory ID or weigh it.

When this policy is enabled, an existing assignment of a known used/partial spool is retained across removal or an untagged metadata reset, including while idle. Returning it therefore cannot claim a full warehouse spool. A confirmed runout still permits the existing replacement path. To intentionally replace a partial spool with a full one without runout, assign the new spool manually: untagged telemetry cannot distinguish that operation from returning the old spool. The existing persistent assignment provides this guard across application restarts; no separate history store is added. RFID identity, external holders, Spoolman and printers with this policy disabled retain their existing unlink behavior.

The insertion callback shares the existing per-printer reconciliation lock, including manual assignment. Claims use a SQLite write lock or PostgreSQL printer/stock row locks with SKIP LOCKED. Immediately before writing, connection generation, age (30 seconds maximum), presence and RFID are rechecked. Manual/pre-assignment wins. A retained assignment can only be replaced if that tray has an open, unambiguous runout of that exact spool; both pause and AMS autoswitch runouts are supported. An autoswitch by itself has no insertion edge and consumes no extra spool.

The existing `note_assignment_change` writer commits the replacement with its journal boundary. If it fails, the auto claim rolls back. Consumption before/after refill, outgoing-spool zero correction and frozen dispatch mapping remain owned by the existing journal/usage tracker. No print resume or queue kick is introduced. Missing stock triggers a warning and manual fallback. Failure to publish configuration leaves the physical spool identity recorded and warns separately; existing assignment read-back verification remains in force.

Configuration uses the same `apply_spool_to_slot_via_mqtt` and projected slot publisher as manual assignment. Queue ignore-color/base-profile flags, explicit overrides, pinned mappings and advertised-versus-actual AMS Backup identity are neither rewritten nor used as permission to choose a different inventory group.

## Validation scope

Only synthetic printers/spools/jobs and disposable SQLite/PostgreSQL targets. New tests cover insertion/reconnect/ack edges, invalid/shutdown masks, slot layouts, stock exclusions, manual/RFID priority, late disappearance, rollback, full-group API/security, overlapping claims, real runout journal/completion splitting and Edit Printer persistence/fallback. Existing routing, queue, overlay, publisher and manual-assignment suites run unchanged. Isolated port-8001 deployment does not provide hardware validation; real printer/RFID timing requires an explicitly approved later trial.

## UI preview

The following screenshots use synthetic stock and a documentation-only printer address. Edit Printer exposes the opt-in checkbox, exact stock group and expandable help through existing shared controls.

### Dark theme

![Automatic stock assignment in Edit Printer, dark theme](images/auto-stock-settings-dark.png)

### Light theme

![Automatic stock assignment in Edit Printer, light theme](images/auto-stock-settings-light.png)

### Expanded help

![Expanded automatic stock assignment help](images/auto-stock-help-dark.png)
