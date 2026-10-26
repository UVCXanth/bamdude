# Counted output of an order line

The expanded parts table has a labelled **Recount actual parts** button. A count
is of loose, completed printed parts still held for that line. Stock allocations,
received goods (including goods already issued), banked surplus and work on
printers are excluded. The dialog shows the excluded quantity separately.
Use the existing Stock & issue / stock adjustment doors for those goods.

The operator enters actual quantities, a reason, reviews the changes and confirms
them. Zero is an actual count. A shortage is not assigned as defects to an arbitrary
print. `ProjectLine.part_count_adjustments` stores signed deltas; the existing
order journal records before/after, actor, time and reason in the same transaction.
For example, 1196 counted as 1180 stores -16; a later good print of 10 yields 1190.
The parts table marks corrected totals. Increasing a count or reversing an earlier
correction uses the same explicit workflow. Do not also record the same shortage
against an archive as defects.

## Existing mechanisms considered

* `archive_defects.record_defects`: retain for a defect attributable to a known run.
  It would invent provenance for an unexplained recount discrepancy.
* `part_stock.move(reason='manual')`: retain for free shelf stock. Using it here
  would move the wrong inventory and count order parts as free stock.
* `order_fulfilment` write-off: retain for received goods. It cannot correct a
  single loose component of an unreceived composite product.

Reuse SQLAlchemy's existing JSON column/migration pattern, order stock locks,
part figures, journal, Modal, order action host and query invalidation. No new
storage engine, ledger framework, scheduler, dependencies or automatic queue
writer is introduced. The source and lock contracts are the current repository's
documented APIs (`CLAUDE.md`, the services' docstrings and executable tests).

## Concurrency and scope

Only an active order can be corrected. Read needs orders/products/stock read;
write additionally orders update and stock adjust, rechecked under the write's
locks. A printer-scoped key cannot edit aggregate order facts. Lock order is
product gate -> order -> existing stock positions/line -> parts -> working draft.
An active plan submission refuses the correction. The read token includes output,
line/configuration, protected quantities and journal generation. A changed input
or repeated old request returns 409, including correction/reversal ABA; the UI
requires a fresh count review and never automatically replays a write.

Pooled completed prints shared by several compatible lines must first be filed
under their actual lines; an ambiguous share is not an authoritative physical
count. Corrections belong to a line's output, not the product's free stock. Do not
duplicate a line's existing counts onto another line. Copies of orders start
without recount corrections. A corrected part cannot be removed/merged or its
catalog count changed until the correction is reversed. Deleting the corrected
line or order also requires reversing its correction. Completed print filing
cannot change while the order has corrections: the aggregate correction cannot
truthfully follow a particular run, and unfiling its raw output would resurrect
missing parts as free stock. Reverse the correction before refiling; the ordinary
stock/receipt guards still apply. Pending or failed work can move normally.

A pooled print's share depends on sibling lines and their need. While a product
has outstanding recount corrections and pooled completed output, its line intake,
quantity/material/reservation edits and stock offers refuse redistribution with
an explicit reversal instruction. Reconfiguration of corrected products also
refuses, since it can move explicitly filed foreign parts to siblings. The existing
product gates serialize these checks with recount. Explicitly filed output can
still receive ordinary quantity edits; note/color edits and other products remain
editable. New completed output is counted normally. If later pooled output makes
an existing count ambiguous, the dialog offers **Review reversal of existing
corrections**: reason, review and confirmation are still required, and the server
accepts only a full reversal of that line's corrections, never a partial new count.
There is no automatic adjustment or lost correction hidden behind a clamp.
Reassigning historical archives would change filing the operator did not ask to
change; a persistent attribution ledger would introduce another accounting model.
The bounded refusal/reversal option instead reuses the existing product gate,
line edit and recount workflow. Neither alternative is needed for this fix.

The correction updates the normal figures used by plan, forecast, exact plate
fit and fulfilment. It neither edits nor removes either queue and never changes
printer settings. The working draft remains operator intent: use the existing
**Replan remainder** review, which subtracts running work and both pending queues,
then enqueue explicitly. Replace pending work separately through the normal queue
controls if needed. Recount itself never prints, clears a plate or changes printer state.

## PR boundaries

This feature is based directly on upstream `feature/v0.7.2-fixes` and does not depend on the
separate printer-restrictions feature. Both use the same optional plan-preparation
callback so opening an order-changing action flushes the current editor first.
No generated `static/` files are part of the change. Migration 210 is reserved
for recounts independently of the proposed restrictions migration 209; the runner
discovers the migration files present in the installation.
