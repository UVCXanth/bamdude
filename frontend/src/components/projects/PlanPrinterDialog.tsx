import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { PlanRow as PlanRowData } from '../../api/client';
import { normalizeModelName } from '../../utils/printer';
import { modelCompatibility } from '../../utils/modelCompatibility';
import { Button } from '../Button';
import { Select } from '../Select';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { plateName, plateOptions, type ChosenPlate } from './planMath';

interface PlanPrinterDialogProps {
  row: PlanRowData;
  /** The plate the row is set to print — its own, or the alternative chosen. */
  plate: ChosenPlate;
  onClose: () => void;
  /** The plate this printer gets and the printer — `PrintModal` opens on them. */
  onNext: (plate: ChosenPlate, printerId: number) => void;
}

/**
 * «To printer» for a row that stands for SEVERAL files (WS-13 E4 E09, F09).
 *
 * ⚠️ **The printer is asked FIRST, and only here.** `PrintModal` owns its own printer
 * selector and reports no choice back, so there is no way to swap the file it was
 * mounted with once a machine is picked inside it — and mounting it with the wrong
 * file is exactly the bug the alternatives exist to fix. A row with one file opens
 * `PrintModal` straight away.
 *
 * ⚠️ **Unknown is not empty (R09).** The printer list and the model matrix are read
 * asynchronously: while they are read the dialog says so and cannot go on; a failed
 * read is a sentence and a retry; «no active printer of this model» only follows a
 * successful read. And the choice is checked AGAIN when «Next» is pressed, over the
 * data as it is then — a printer archived or parked meanwhile, or a file that became
 * one the reader may not open, stops here with a sentence rather than opening a
 * print dialog on it.
 */
export function PlanPrinterDialog({ row, plate, onClose, onNext }: PlanPrinterDialogProps) {
  const { t } = useTranslation();
  const hiddenLabel = t('products.plates.hiddenFile');
  const options = useMemo(() => plateOptions(row), [row]);

  const printersQuery = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters });
  const { data: modelMatrix } = useQuery({
    queryKey: ['modelCompatibility'],
    queryFn: api.getModelCompatibility,
    staleTime: 60 * 60 * 1000,
  });
  const allPrinters = printersQuery.data;
  const statusQueries = useQueries({
    queries: (allPrinters ?? []).map((printer) => ({
      queryKey: ['printerStatus', printer.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.getPrinterStatus(printer.id, signal),
      staleTime: 5000,
    })),
  });
  const effectiveModel = (printerId: number, model: string | null) =>
    statusQueries[(allPrinters ?? []).findIndex((printer) => printer.id === printerId)]?.data?.effective_model || model;

  // ⚠️ Parked printers are not offered: Maintenance Mode (`is_active === false`) is
  // an axis of its own — archived ones never arrive, `getPrinters` leaves them out.
  // ⚠️ And only the MODELS the row's files were sliced for, normalised on both sides
  // the way `fileForPrinter` compares them. A row whose files carry no model filters
  // nothing: when nothing is known, every printer beats none.
  const models = useMemo(
    () => new Set(options.map((o) => normalizeModelName(o.printer_model).toLowerCase()).filter(Boolean)),
    [options],
  );
  const printers = useMemo(() => {
    const active = (allPrinters ?? []).filter((p) => p.is_active);
    if (models.size === 0) return active;
    return active.filter((p) =>
      options.some((option) =>
        ['exact', 'compatible'].includes(
          modelCompatibility(option.printer_model, effectiveModel(p.id, p.model), modelMatrix?.models),
        ),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- status queries determine live effective models
  }, [allPrinters, models, options, modelMatrix, statusQueries]);

  /** The file this print should use, given the printer it is going to.
   *
   *  ⚠️ EXACTLY one match, or the row's own choice stands. Two files claiming the
   *  same model is a library the operator has to sort out, and picking one of them
   *  for them would send a print they never chose. Both sides through the same
   *  normaliser: a printer row says "Bambu Lab X1 Carbon" where the 3MF says "X1C". */
  const fileForPrinter = (model: string | null): ChosenPlate => {
    const wanted = normalizeModelName(model).toLowerCase();
    if (!wanted) return plate;
    const matches = options.filter((o) => normalizeModelName(o.printer_model).toLowerCase() === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return plate;
    const compatible = options.filter(
      (option) => modelCompatibility(option.printer_model, model, modelMatrix?.models) === 'compatible',
    );
    return compatible.length === 1 ? compatible[0] : plate;
  };
  const targetFor = (printerId: number) => {
    const printer = printers.find((p) => p.id === printerId);
    return printer ? fileForPrinter(effectiveModel(printer.id, printer.model)) : null;
  };

  // The first printer whose file the reader may open, as the dialog opens on it.
  const [picked, setPicked] = useState<number | null>(null);
  const defaultPick = printers.find((p) => !fileForPrinter(effectiveModel(p.id, p.model)).hidden)?.id ?? null;
  const selected = picked ?? defaultPick;

  /** Why the current choice cannot go on — asked on every render and again on «Next». */
  const refusal = (printerId: number | null): string | null => {
    if (printerId == null) return null;
    const target = targetFor(printerId);
    if (target == null) return t('orders.plan.printer.gone');
    if (target.hidden) return t('orders.plan.printer.hiddenFile');
    return null;
  };
  const ready = printersQuery.data !== undefined;
  const blocked = selected != null ? refusal(selected) : null;
  const canGo = ready && selected != null && blocked == null;

  const next = () => {
    if (selected == null) return;
    // ⚠️ Checked again over the data as it is NOW, not as it was when the button
    // was drawn: a refetch between the two is exactly what this guards against.
    if (refusal(selected) != null) return;
    const target = targetFor(selected);
    if (target == null || target.hidden) return;
    onNext(target, selected);
  };

  const modelNames = [...new Set(options.map((o) => o.printer_model).filter((m): m is string => !!m))];
  const subtitle = `${plateName(plate, hiddenLabel)} · ${
    plate.plate_index === 0 ? t('orders.plan.row.wholeFile') : t('orders.plan.row.plate', { n: plate.plate_index })
  }`;

  return (
    <WorkshopDialog
      title={t('orders.plan.printer.title')}
      subtitle={subtitle}
      size="sm"
      onClose={onClose}
      error={ready && blocked ? blocked : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('orders.plan.printer.cancel')}
          </Button>
          <Button onClick={next} disabled={!canGo}>
            {t('orders.plan.printer.next')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {printersQuery.isPending ? (
          <p className="text-sm text-bambu-gray">{t('orders.plan.printer.loading')}</p>
        ) : printersQuery.isError && !allPrinters ? (
          <div className="flex items-center gap-3 flex-wrap text-sm">
            <p className="text-red-400">{t('orders.plan.printer.failed')}</p>
            <Button size="sm" variant="secondary" onClick={() => void printersQuery.refetch()}>
              {t('orders.plan.printer.retry')}
            </Button>
          </div>
        ) : printers.length === 0 ? (
          <p className="text-sm text-bambu-gray">{t('orders.plan.row.noPrinterOfModel')}</p>
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor="plan-printer-pick" className="text-sm text-bambu-gray-light">
              {t('orders.plan.printer.printer')}
            </label>
            <Select
              id="plan-printer-pick"
              className="w-full"
              value={selected ?? ''}
              onChange={(e) => setPicked(Number(e.currentTarget.value))}
            >
              {printers.map((printer) => {
                const closed = fileForPrinter(effectiveModel(printer.id, printer.model)).hidden;
                const name = printer.model ? `${printer.name} (${printer.model})` : printer.name;
                return (
                  <option key={printer.id} value={printer.id} disabled={closed}>
                    {closed ? `${name} — ${hiddenLabel}` : name}
                  </option>
                );
              })}
            </Select>
          </div>
        )}
        <p className="text-xs leading-[18px] text-bambu-gray">
          {t('orders.plan.printer.hint', { models: modelNames.join(' / ') || '—' })}
        </p>
      </div>
    </WorkshopDialog>
  );
}
