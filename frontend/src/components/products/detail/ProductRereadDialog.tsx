import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { CardNote, Product } from '../../../api/client';
import { useProductFileGroups } from '../../../hooks/useProductFileGroups';
import { invalidateOrderViews, invalidateProductFiles } from '../../../utils/queryInvalidation';
import { Button } from '../../Button';
import { LoadFailedNote } from '../../workshop/LoadFailedNote';
import { WorkshopDialog } from '../../workshop/WorkshopDialog';
import { cardNoteText, cardNotesText } from '../cardNotes';
import { ModelChip } from './ModelChip';

/** A note that nothing was read — the product is as it was, and the dialog says why. */
const NOTHING_READ = new Set(['file_missing', 'unreadable']);
/** The card fields a re-read fills when they are empty (F01). */
const FILLABLE = ['description', 'designer', 'license', 'design_id'] as const;
/** The notes the result step counts itself; every other note is said as its sentence. */
const COUNTED = new Set(['filled_field', 'replaced_files', 'imported_files']);

/**
 * Re-reading a product's card from one of its files (WS-13 E9 B03, R02, R08).
 *
 * The files are `GET /products/{id}/files` — the same key as the «Plates and files» tab —
 * narrowed to the 3MF containers the reader may see (`is_3mf`, `!hidden`): sliced or not,
 * a 3MF carries the card; STL, STEP and raw G-code do not, and a file without access is
 * not offered (its name is not the reader's to learn). `is_3mf` is the server's, never
 * `sliced_any` or `plan_eligible`.
 *
 * The only file there is starts chosen; of several, none — «Re-read» waits for a choice.
 * A re-read of the list that drops the chosen file clears the choice and says so.
 *
 * Before the request it says which EMPTY fields the file may fill — a filled one is not
 * named — and that the file's attachments are replaced, hand-added ones not (WS-13 E10
 * F01; the server has no preview, K14). The request goes only on «Re-read». A note that
 * nothing could be read (`file_missing`, `unreadable`) changes nothing on the server: the
 * dialog stays with the note as its error. Otherwise the dialog becomes its result (F02)
 * — what was filled, replaced, added, skipped, in the reader's language (the notes are
 * CODES) — closed by «Done»; what a re-read moves is refreshed at once: the product and
 * the order cards (it can bring the first cover), and the files' plates.
 *
 * The dialog rules are B11's: one click, one request; nothing closes it while it runs; a
 * refusal stays with the server's sentence and the focus on «Re-read».
 */
export function ProductRereadDialog({
  product,
  onClose,
}: {
  product: Pick<Product, 'id' | 'code' | 'name' | 'description' | 'designer' | 'license' | 'design_id'>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const primaryId = useId();
  const doneId = useId();
  const [result, setResult] = useState<CardNote[] | null>(null);
  // The fields empty at the opening — what the file may fill.
  const [empty] = useState(() => FILLABLE.filter((field) => !(product[field] ?? '').trim()));
  const sent = useRef(false);
  const [sending, setSending] = useState(false);
  const [chosen, setChosen] = useState<number | null>(null);
  const [touched, setTouched] = useState(false);
  const [gone, setGone] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const files = useProductFileGroups(product.id);
  const candidates = (files.data?.files ?? []).filter((f) => f.is_3mf && !f.hidden);
  const ids = candidates.map((f) => f.library_file_id).join(',');

  useEffect(() => {
    if (!files.data) return;
    const listed = ids === '' ? [] : ids.split(',').map(Number);
    if (chosen != null && !listed.includes(chosen)) {
      // The operator now picks: a file chosen by itself and gone is not silently replaced
      // by the next lone one, under a hint that asks them to pick (E9 final review).
      setChosen(null);
      setGone(true);
      setTouched(true);
      return;
    }
    if (chosen == null && !touched && listed.length === 1) setChosen(listed[0]);
  }, [files.data, ids, chosen, touched]);

  const write = useMutation({
    mutationFn: (fileId: number) => api.rereadProductCard(product.id, fileId),
    onSuccess: (result) => {
      sent.current = false;
      setSending(false);
      if (result.notes.some((note) => NOTHING_READ.has(note.code))) {
        setReadError(cardNotesText(t, result.notes));
        return;
      }
      invalidateOrderViews(queryClient);
      invalidateProductFiles(queryClient, product.id);
      setResult(result.notes);
    },
    onError: () => {
      sent.current = false;
      setSending(false);
    },
  });
  const busy = sending || write.isPending;
  const error = write.isError ? (write.error as Error).message : readError;

  useEffect(() => {
    if (error) document.getElementById(primaryId)?.focus();
  }, [error, primaryId]);
  useEffect(() => {
    if (result) document.getElementById(doneId)?.focus();
  }, [result, doneId]);

  if (result) {
    const filled = result
      .filter((note) => note.code === 'filled_field')
      .map((note) => {
        const field = String(note.params?.field ?? '');
        return t(`products.card.fields.${field}`, { defaultValue: field });
      });
    const replaced = result
      .filter((note) => note.code === 'replaced_files')
      .reduce((sum, note) => sum + Number(note.params?.count ?? 0), 0);
    const added = result
      .filter((note) => note.code === 'imported_files')
      .map((note) => {
        const category = String(note.params?.category ?? '');
        return t('products.detail.reread.addedItem', {
          count: Number(note.params?.count ?? 0),
          category: t(`products.attachments.category.${category}`, { defaultValue: category }),
        });
      });
    const lines = [
      ...(filled.length > 0 ? [t('products.detail.reread.filled', { fields: filled.join(', ') })] : []),
      ...(replaced > 0 ? [t('products.detail.reread.replaced', { count: replaced })] : []),
      ...(added.length > 0 ? [t('products.detail.reread.added', { list: added.join(', ') })] : []),
      ...result.filter((note) => !COUNTED.has(note.code)).map((note) => cardNoteText(t, note)),
    ];
    return (
      <WorkshopDialog
        size="md"
        onClose={onClose}
        title={t('products.detail.reread.resultTitle')}
        subtitle={`${product.code} · ${product.name}`}
        footer={
          <Button id={doneId} onClick={onClose}>
            {t('products.detail.reread.done')}
          </Button>
        }
      >
        {lines.length > 0 ? (
          <ul className="space-y-1.5 text-sm text-bambu-gray-light">
            {lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-bambu-gray-light">{t('products.detail.reread.unchanged')}</p>
        )}
      </WorkshopDialog>
    );
  }

  let list;
  if (!files.data && files.isError) {
    list = <LoadFailedNote message={t('products.detail.reread.loadFailed')} onRetry={() => files.refetch()} />;
  } else if (!files.data) {
    list = <p className="text-sm text-bambu-gray">{t('products.detail.reread.loading')}</p>;
  } else if (candidates.length === 0) {
    list = <p className="text-sm text-bambu-gray">{t('products.detail.reread.empty')}</p>;
  } else {
    list = (
      <fieldset className="space-y-1">
        <legend className="sr-only">{t('products.detail.reread.files')}</legend>
        {candidates.map((f) => (
          <label
            key={f.library_file_id}
            className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-bambu-dark-tertiary/40 cursor-pointer"
          >
            <input
              type="radio"
              name="reread-file"
              className="mt-1 accent-bambu-green"
              checked={chosen === f.library_file_id}
              disabled={busy}
              onChange={() => {
                setTouched(true);
                setGone(false);
                setReadError(null);
                setChosen(f.library_file_id);
              }}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-white wrap-anywhere">{f.filename}</span>
              {f.folder_name && <span className="block text-xs text-bambu-gray wrap-anywhere">{f.folder_name}</span>}
            </span>
            {f.sliced_any ? (
              f.printer_model && <ModelChip model={f.printer_model} />
            ) : (
              <small className="text-xs text-amber-700 dark:text-amber-400">{t('products.row.unsliced')}</small>
            )}
          </label>
        ))}
      </fieldset>
    );
  }

  return (
    <WorkshopDialog
      size="md"
      onClose={onClose}
      title={t('products.detail.reread.title')}
      subtitle={`${product.code} · ${product.name}`}
      pending={busy}
      error={error ?? undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            id={primaryId}
            disabled={busy || chosen == null}
            onClick={() => {
              if (sent.current || chosen == null) return;
              sent.current = true;
              setSending(true);
              setReadError(null);
              write.mutate(chosen);
            }}
          >
            {t('products.detail.reread.submit')}
            {busy && '…'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-bambu-gray-light">
          {empty.length > 0
            ? t('products.detail.reread.fill', {
                fields: empty.map((field) => t(`products.detail.reread.fields.${field}`)).join(', '),
              })
            : t('products.detail.reread.nothingEmpty')}{' '}
          {t('products.detail.reread.attachments')}
        </p>
        {list}
        {gone && <p className="text-sm text-amber-700 dark:text-amber-400">{t('products.detail.reread.gone')}</p>}
      </div>
    </WorkshopDialog>
  );
}
