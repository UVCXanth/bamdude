import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { Product } from '../../../api/client';
import { useToast } from '../../../contexts/ToastContext';
import { useProductFileGroups } from '../../../hooks/useProductFileGroups';
import { invalidateOrderViews, invalidateProductFiles } from '../../../utils/queryInvalidation';
import { Button } from '../../Button';
import { LoadFailedNote } from '../../workshop/LoadFailedNote';
import { WorkshopDialog } from '../../workshop/WorkshopDialog';
import { cardNotesText } from '../cardNotes';
import { ModelChip } from './ModelChip';

/** A note that nothing was read — the product is as it was, and the dialog says why. */
const NOTHING_READ = new Set(['file_missing', 'unreadable']);

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
 * The request goes only on «Re-read». A note that nothing could be read (`file_missing`,
 * `unreadable`) changes nothing on the server: the dialog stays with the note as its
 * error. Otherwise it closes, the notes go to a toast (they are CODES — only this layer
 * knows the reader's language), and what a re-read moves is refreshed: the product and
 * the order cards (it can bring the first cover), and the files' plates.
 *
 * The dialog rules are B11's: one click, one request; nothing closes it while it runs; a
 * refusal stays with the server's sentence and the focus on «Re-read».
 */
export function ProductRereadDialog({
  product,
  onClose,
}: {
  product: Pick<Product, 'id' | 'code' | 'name'>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const primaryId = useId();
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
      showToast(cardNotesText(t, result.notes));
      onClose();
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
        <p className="text-sm text-bambu-gray-light">{t('products.detail.reread.body')}</p>
        {list}
        {gone && <p className="text-sm text-amber-700 dark:text-amber-400">{t('products.detail.reread.gone')}</p>}
      </div>
    </WorkshopDialog>
  );
}
