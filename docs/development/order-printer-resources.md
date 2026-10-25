# Order printer resources

An order may restrict actual printer models and/or concrete printer ids. The
sets intersect; NULL preserves the whole farm. A missing, offline or excluded
printer never widens the selection. These are routing restrictions, not an
exclusive reservation or a dynamic concurrency limit. Product plates remain
linked and available to other orders.

The order page exposes an always-visible **Printers for this order** panel above
its forecast and print plan, with a named Configure restrictions button and a
persistent summary. The existing order action host owns the modal. Its help
explains intersection, non-reservation, preserved work and explicit publication.

The existing planner filters recipes and capacity, while the forecast filters
placements and its per-model machine counts. AutoQueue eligibility also filters
offline wake candidates. The existing final printer-lane claim rechecks the
current order policy under the order row lock; already claimed work keeps its
lifecycle. Constrained orders are excluded from the model-wide opportunistic
rebalancer: use the order's reviewed replan to change sliced sources. No file is
retargeted by changing a model string.

Saving restrictions changes no queue job. A separate read-only review proposes
removing replaceable, never-started jobs from both queue tiers and replacing the
shared working draft. Explicit line ownership, source identity, queue policy,
timestamps and all relevant job choices are part of the signed review. Waiting
observations alone do not invalidate it. Manual filament pins, manual/scheduled
starts, calibration jobs, ambiguous/unfiled sources and started claims are not
removed. A claimed preparation without an attributable execution refuses the
review until its bookkeeping is available instead of duplicating its parts.

Application takes the existing lane guards before order/draft locks and verifies
the reviewed input digest, revision, actor, permissions and payload. Any changed
work refuses the transaction before deletion. It reuses queue reference cleanup
and counters; source blobs stay for normal GC. Good output, stock allocations,
running work and retained queue yield count through the existing arithmetic.
The changed draft advances its comparison epoch. No printer command, plate
clearance, queue pause or new job is created. The operator publishes the new
draft with the existing **Whole plan to queue** action and current order settings.

Existing alternatives were checked against current upstream 0.7.2:

- Printer-level auto-distribution eligibility affects other orders, so it cannot
  express an order-local selection.
- Existing per-job model/location routing remains the execution mechanism, but
  cannot constrain whole-order planning or replace already pending work alone.
- Existing shared working-plan review/publication supplies the revision, signed
  proposal and explicit send workflow. It is extended with this order policy;
  no external solver, scheduler, storage or alternate queue writer is added.

Migration 209 adds one nullable JSON column with no backfill on SQLite and
PostgreSQL. No new permission is introduced: reading the editor needs order and
printer read access; changing restrictions needs order update; whole-order
queue replacement additionally needs queue read/delete-all. Printer-scoped API
keys cannot manage a partial version of a whole-order policy.

A zero-count working entry remains an explicit exclusion when restrictions
change. It requests no printer work and cannot block remainder planning merely
because its model or pinned machine is outside the new selection. Positive
counts still require the current policy; source and line identities are checked
even for zero entries. Reading current inputs and reviewing the remainder keeps
the exclusion and schedules only allowed models.
