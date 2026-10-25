# Preserve fleet choices at the working-plan boundary

The existing greedy planner can choose equivalent-yield files for different
model lanes, using the farm's machine counts, held work and each recipe's print
duration. A working draft and its forecast intentionally name exact files.
Collapsing those choices into one representative plate loses the allocation:
autosave and reviewed replans then turn all equal-yield runs into that file.

`plan_lines` now keeps the existing cover result uncompressed. Already-selected
plates are not also offered as alternatives on each other's rows. Unselected
equivalent files remain available as alternatives. No schedule or queue writer
is added; source checks, review tokens and explicit publication stay unchanged.

Three existing approaches were considered:

- Keeping compact rows and recalculating a forecast split during save would use
  a later farm snapshot and could change a reviewed proposal or a manual choice.
- Adding a separate persisted allocation to compact rows would duplicate the
  existing file-specific working entries and require a second representation.
- Keeping the planner's existing per-file rows uses its current public cover
  option and fits the working-entry and forecast contracts directly. This is
  the selected approach; no external solver or new planning layer is needed.

Existing working drafts are never silently redistributed. An operator can
explicitly rebuild a draft, or review the remainder while preserving protected
manual work and zero exclusions. No print starts until normal publication.
