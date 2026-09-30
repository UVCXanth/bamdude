import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Order, PlanRow as PlanRowData } from '../../api/client';
import { formatMoney } from '../../utils/currency';
import { formatDuration } from '../../utils/date';
import { Button } from '../Button';
import { PrintModal } from '../PrintModal';
import { chosenPlate, parseCount, plateName, plateOptions, projectRow, splitIsOff, type ChosenPlate } from './planMath';
import { PlanPrinterDialog } from './PlanPrinterDialog';
import { Select } from '../Select';

/** The server's own ceiling on one enqueue item (`PlanEnqueueItem.count`). */
export const MAX_PER_PLATE = 999;

/** The blue model chip (mockup `.m-model`). */
const MODEL_CHIP =
  'inline-block rounded px-1.5 py-px text-[11px] font-medium leading-4 whitespace-nowrap bg-blue-500/15 text-blue-700 dark:text-blue-400';
const CELL = 'px-2.5 py-2.5 align-top';

interface PlanRowProps {
  order: Order;
  lineId: number;
  row: PlanRowData;
  count: number;
  /** The count the server planned for this row — `null` for a plate the operator
   *  added by hand, which has no plan to differ from (WS-13 E4 E06). */
  planned: number | null;
  /** Which of the row's plates the operator set it to print — its own, or one
   *  of its alternatives. Undefined is the engine's own pick. */
  chosen: number | undefined;
  /** `plate_id → prints`, once the operator has opened the split and edited it.
   *  Undefined means "all on the chosen file", which is what every row does
   *  until somebody says otherwise. */
  split: Record<number, number> | undefined;
  /** The farm's own suggested split across this row's files, when it has one.
   *  `null` (not sent, the row has no alternatives, or the draft moved the plan)
   *  hides the proposal — it never seeds `split` on its own; only its button does. */
  proposal?: Record<number, number> | null;
  currency: string | null | undefined;
  showCost: boolean;
  canQueue: boolean;
  canPrint: boolean;
  busy: boolean;
  onCount: (next: number) => void;
  onChoose: (plateId: number) => void;
  onSplit: (next: Record<number, number>) => void;
  onEnqueue: () => void;
  onQueued: () => void;
  /** Where the plan sits — the order page, or the «Plan from files» dialog. On
   *  the page a phone keeps the row's actions on one line (WS-13 E4 F6). */
  variant?: 'page' | 'dialog';
}

/** `filename (X1C)`, or the bare filename when the file names no model. The
 *  model is what tells two otherwise identically-named exports apart. */
function optionLabel(plate: ChosenPlate, hiddenLabel: string): string {
  const name = plateName(plate, hiddenLabel);
  return plate.printer_model ? `${name} (${plate.printer_model})` : name;
}

/**
 * One recommended plate, printed `count` times (WS-13 E4 E03–E09).
 *
 * Five cells — plate, covers, prints, time / filament, actions — and, under the row,
 * the split panel as a row of its own when it is open. The actions are buttons that
 * never wrap their own text; the cell wraps them instead.
 *
 * ⚠️ **The figures on the row describe its effective enqueue distribution.** Until
 * split opens that is one file × `count`; afterwards each file carries its own time,
 * grams and cost. The count editor stays here so the operator changes a number and
 * reads that consequence in the same line.
 *
 * ⚠️ **`plate_id` is `ProductPlate.id`, `plate_index` is the slicer's.** The queue
 * and `PrintModal` speak the second one, where 0 means "no plate pinned", i.e. the
 * whole file — hence `plate_index || undefined` below and nowhere a bare index.
 *
 * ⚠️ **A row can stand for SEVERAL files** (`row.alternatives`): the same part is
 * routinely sliced once per printer model. The switch, the printer match and the
 * split all read the same `plateOptions` list, and the only thing that never moves
 * with the choice is the COUNT — the alternatives make the same counted parts.
 *
 * ⚠️ **The split panel has two modes by right (R06).** With `queue:create` it edits:
 * a number per file, the farm's proposal to apply, «queue split». Without it, the
 * panel only READS the farm's proposal — the numbers per file, nothing to change or
 * send — so a reader never loses the proposal the row used to show.
 *
 * The `+` is deliberately uncapped: a count over the server's 999 disables the
 * *queue* button with the reason in its title, rather than silently refusing a
 * click or clamping a number the operator typed on purpose.
 *
 * ⚠️ **The test ids carry the LINE id beside the plate's.** `ProductPlate.id` is
 * unique per product, not per order — two lines of the same product put the same
 * plate on screen twice.
 */
export function PlanRow({
  order,
  lineId,
  row,
  count,
  planned,
  chosen,
  split,
  proposal,
  currency,
  showCost,
  canQueue,
  canPrint,
  busy,
  onCount,
  onChoose,
  onSplit,
  onEnqueue,
  onQueued,
  variant = 'page',
}: PlanRowProps) {
  const { t } = useTranslation();
  const [printing, setPrinting] = useState<{ plate: ChosenPlate; printerId?: number } | null>(null);
  const [pickingPrinter, setPickingPrinter] = useState(false);
  const [splitting, setSplitting] = useState(false);

  const hiddenLabel = t('products.plates.hiddenFile');
  const options = plateOptions(row);
  const plate = chosenPlate(row, chosen);
  const hasAlternatives = row.alternatives.length > 0;
  // «To printer» opens the FILE. Offered while at least one of the row's plates
  // is one the reader may open; which one a printer gets is checked on the final
  // plate in the printer dialog (WS-13 E1 CL6).
  const anyOpenable = options.some((option) => !option.hidden);

  const tooMany = count > MAX_PER_PLATE;
  const atZero = count === 0;
  // A split that does not add up is not a distribution — it is half an edit,
  // and sending it would queue a number nobody asked for. Same predicate the
  // block uses on its whole-plan button (`splitIsOff`), so the two cannot drift.
  const splitOff = splitIsOff(split, count);
  const step =
    'px-2 py-1 rounded border border-bambu-dark-tertiary text-white hover:bg-bambu-dark-tertiary disabled:opacity-40 disabled:hover:bg-transparent';

  const currentSplit = split ?? { [plate.plate_id]: count };
  const figures = projectRow(row, count, chosen, split);

  // The panel's toggle: an editor for somebody who may queue, a reading of the
  // farm's proposal for somebody who may not — and nothing when there is neither.
  const offersPanel = hasAlternatives && (canQueue || proposal != null);
  const panelOpen = splitting && offersPanel;
  const toggleLabel = canQueue
    ? panelOpen
      ? t('orders.plan.split.hide')
      : t('orders.plan.split.title')
    : panelOpen
      ? t('orders.plan.split.hideProposal')
      : t('orders.plan.split.proposal');

  return (
    <>
      <tr
        data-testid={`plan-row-${lineId}-${row.plate_id}`}
        className={`border-t border-bambu-dark-tertiary ${count === 0 ? 'opacity-50' : ''}`}
      >
        <td className={`${CELL} min-w-[9rem]`}>
          {hasAlternatives ? (
            <Select
              size="sm"
              // A file name rarely fits the cell: it ends in an ellipsis rather than
              // mid-letter at the border (WS-13 E4 F6 — see `select-ellipsis`).
              className="w-full select-ellipsis"
              data-testid={`plan-row-${lineId}-${row.plate_id}-file`}
              aria-label={t('orders.plan.row.file')}
              // The title keeps the shortened name readable in full.
              title={optionLabel(plate, hiddenLabel)}
              value={plate.plate_id}
              onChange={(e) => onChoose(Number(e.currentTarget.value))}
            >
              {options.map((option) => (
                <option key={option.plate_id} value={option.plate_id}>
                  {optionLabel(option, hiddenLabel)}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-white font-semibold [overflow-wrap:anywhere]">{plateName(plate, hiddenLabel)}</p>
          )}
          <small className="block mt-0.5 text-xs text-bambu-gray" data-testid={`plan-row-${lineId}-${row.plate_id}-plate`}>
            {plate.plate_index === 0 ? t('orders.plan.row.wholeFile') : t('orders.plan.row.plate', { n: plate.plate_index })}
            {plate.printer_model && (
              <>
                {' · '}
                <span className={MODEL_CHIP}>{plate.printer_model}</span>
              </>
            )}
          </small>
        </td>

        <td className={`${CELL} text-xs text-bambu-gray`}>
          {row.useful.length > 0 ? row.useful.map((u) => `${u.name} × ${u.count}`).join(', ') : '—'}
        </td>

        <td className={CELL}>
          <div className="inline-flex items-center gap-1 whitespace-nowrap">
            {/* ⚠️ A bare `−` / `+` is invisible to a screen reader and to every test
                that asks for a control by name — the glyphs carry the whole meaning. */}
            <button
              type="button"
              data-testid={`plan-row-${lineId}-${row.plate_id}-dec`}
              className={step}
              aria-label={t('orders.plan.row.decrease')}
              title={atZero ? t('orders.plan.row.atZero') : undefined}
              disabled={atZero}
              onClick={() => onCount(count - 1)}
            >
              −
            </button>
            <input
              type="number"
              min={0}
              data-testid={`plan-row-${lineId}-${row.plate_id}-count`}
              value={count}
              aria-label={t('orders.plan.row.count')}
              onChange={(e) => onCount(parseCount(e.currentTarget.value, count))}
              className="w-12 px-1.5 py-1 text-right tabular-nums bg-bambu-dark border border-bambu-dark-tertiary rounded text-white focus:border-bambu-green focus:outline-none"
            />
            <button
              type="button"
              data-testid={`plan-row-${lineId}-${row.plate_id}-inc`}
              className={step}
              aria-label={t('orders.plan.row.increase')}
              onClick={() => onCount(count + 1)}
            >
              +
            </button>
          </div>
          {planned != null && planned !== count && (
            <small
              className="block mt-0.5 text-xs text-amber-700 dark:text-amber-400"
              data-testid={`plan-row-${lineId}-${row.plate_id}-planned`}
            >
              {t('orders.plan.row.planned', { count: planned })}
            </small>
          )}
        </td>

        <td
          className={`${CELL} text-xs text-bambu-gray tabular-nums whitespace-nowrap`}
          data-testid={`plan-row-${lineId}-${row.plate_id}-figures`}
        >
          <span className="block">{figures.seconds == null ? '—' : formatDuration(figures.seconds)}</span>
          <span className="block">
            {figures.hasGrams ? t('orders.plan.row.grams', { grams: figures.grams.toFixed(1) }) : '—'}
          </span>
          {showCost && figures.cost != null && <span className="block">{formatMoney(figures.cost, currency)}</span>}
        </td>

        <td className={CELL}>
          {/* ⚠️ On a phone the order page keeps the actions on ONE line (WS-13 E4 F6):
              stacked, three 44 px buttons made every row ~160 px tall, while the
              table already scrolls sideways in its own frame. The dialog keeps
              wrapping — the owner's call left it as it was. */}
          <div
            className={`flex items-center justify-end gap-1 flex-wrap ${variant === 'page' ? 'max-sm:flex-nowrap' : ''}`}
          >
            {canQueue && (
              <Button
                size="sm"
                className="whitespace-nowrap"
                data-testid={`plan-row-${lineId}-${row.plate_id}-queue`}
                disabled={busy || atZero || tooMany || splitOff}
                title={
                  tooMany
                    ? t('orders.plan.row.tooMany')
                    : atZero
                      ? t('orders.plan.row.atZero')
                      : splitOff
                        ? t('orders.plan.split.sum', { count })
                        : undefined
                }
                onClick={onEnqueue}
              >
                {t('orders.plan.row.toQueue', { count })}
              </Button>
            )}
            {/* «To printer» opens the file itself — never for a plate the caller may
                not open, planned or added by hand (WS-13 E1 CL2 / CL6). */}
            {canPrint && anyOpenable && (
              <Button
                size="sm"
                variant="secondary"
                className="whitespace-nowrap"
                data-testid={`plan-row-${lineId}-${row.plate_id}-printer`}
                onClick={() => (hasAlternatives ? setPickingPrinter(true) : setPrinting({ plate }))}
              >
                {t('orders.plan.row.toPrinter')}
              </Button>
            )}
            {offersPanel && (
              <Button
                size="sm"
                variant="ghost"
                className="whitespace-nowrap"
                aria-expanded={panelOpen}
                data-testid={`plan-row-${lineId}-${row.plate_id}-split`}
                onClick={() => setSplitting((open) => !open)}
              >
                {toggleLabel}
              </Button>
            )}
          </div>

          {pickingPrinter && (
            <PlanPrinterDialog
              row={row}
              plate={plate}
              onClose={() => setPickingPrinter(false)}
              onNext={(target, printerId) => {
                setPickingPrinter(false);
                setPrinting({ plate: target, printerId });
              }}
            />
          )}

          {printing && (
            <PrintModal
              mode="add-to-queue"
              libraryFileId={printing.plate.library_file_id}
              // Only an openable plate gets here, so this is its file name.
              archiveName={plateName(printing.plate, hiddenLabel)}
              preselectedPlateId={printing.plate.plate_index || undefined}
              projectId={order.id}
              projectLineId={lineId}
              // Pinned, not hidden: the operator named the machine in the printer
              // dialog, and the print dialog should still say which one it is.
              initialSelectedPrinterIds={printing.printerId == null ? undefined : [printing.printerId]}
              lockPrinterSelection={printing.printerId != null}
              // Routing, not dispatching: the modal is opened on the printer leg and
              // kept there, because "to printer…" already answered its only question.
              initialDispatchMode="specific"
              lockDispatchMode
              onClose={() => setPrinting(null)}
              onSuccess={() => {
                setPrinting(null);
                onQueued();
              }}
            />
          )}
        </td>
      </tr>

      {/* One number per file, and they must add up to the row's count — the split
          moves prints between machines, it does not add or drop any. Everything
          starts on the file the row is showing, so opening this and closing it
          again changes nothing. Closing hides the panel and keeps the split. */}
      {panelOpen && (
        <tr>
          <td colSpan={5} className="bg-bambu-dark-tertiary/30 px-3 py-2">
            <div
              className="flex flex-wrap items-end gap-3.5 py-1.5 text-xs"
              data-testid={`plan-row-${lineId}-${row.plate_id}-split-panel`}
            >
              {canQueue
                ? options.map((option) => (
                    <label key={option.plate_id} className="flex flex-col gap-1 text-bambu-gray-light">
                      <span className="[overflow-wrap:anywhere]">
                        {plateName(option, hiddenLabel)}
                        {option.printer_model && (
                          <>
                            {' '}
                            <span className={MODEL_CHIP}>{option.printer_model}</span>
                          </>
                        )}
                      </span>
                      <input
                        type="number"
                        min={0}
                        data-testid={`plan-row-${lineId}-${row.plate_id}-split-${option.plate_id}`}
                        value={currentSplit[option.plate_id] ?? 0}
                        onChange={(e) =>
                          onSplit({
                            ...currentSplit,
                            [option.plate_id]: parseCount(e.currentTarget.value, currentSplit[option.plate_id] ?? 0),
                          })
                        }
                        className="w-24 px-2 py-1 text-right tabular-nums bg-bambu-dark border border-bambu-dark-tertiary rounded text-white focus:border-bambu-green focus:outline-none"
                      />
                      {/* The farm's number stands under its own file: a list labelled by
                          model reads nothing when two files are for the same model. */}
                      {proposal != null && (
                        <span
                          className="text-bambu-gray tabular-nums"
                          data-testid={`plan-row-${lineId}-${row.plate_id}-proposal-${option.plate_id}`}
                        >
                          {t('orders.plan.row.byFarm', { split: proposal[option.plate_id] ?? 0 })}
                        </span>
                      )}
                    </label>
                  ))
                : proposal != null &&
                  options.map((option) => (
                    <span key={option.plate_id} className="text-bambu-gray-light">
                      {plateName(option, hiddenLabel)}
                      {option.printer_model && (
                        <>
                          {' '}
                          <span className={MODEL_CHIP}>{option.printer_model}</span>
                        </>
                      )}
                      {` — ${proposal[option.plate_id] ?? 0}`}
                    </span>
                  ))}
              {canQueue && proposal != null && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="whitespace-nowrap"
                  data-testid={`plan-row-${lineId}-${row.plate_id}-apply-farm`}
                  onClick={() => onSplit({ ...proposal })}
                >
                  {t('orders.plan.row.applyFarmSplit')}
                </Button>
              )}
              {canQueue && splitOff && (
                <p className="text-amber-700 dark:text-amber-400" data-testid={`plan-row-${lineId}-${row.plate_id}-split-error`}>
                  {t('orders.plan.split.sum', { count })}
                </p>
              )}
              {canQueue && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="whitespace-nowrap"
                  data-testid={`plan-row-${lineId}-${row.plate_id}-split-apply`}
                  disabled={busy || atZero || tooMany || splitOff}
                  onClick={onEnqueue}
                >
                  {t('orders.plan.split.apply')}
                </Button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
