import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, Save } from 'lucide-react';
import { api } from '../../api/client';
import type { Order } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { RichTextEditor } from '../RichTextEditor';
import { invalidateOrderViews } from '../../utils/queryInvalidation';

interface OrderNotesProps {
  order: Order;
  canEdit: boolean;
}

/** The notes as compared: trimmed, and the editor's empty document is no text at all —
 *  so an order without notes does not turn «changed» the moment its editor appears. */
function normalize(html: string | null | undefined): string {
  const text = (html ?? '').trim();
  return text === '<p></p>' ? '' : text;
}

/**
 * Free-form notes on the order (WS-13 E4 G03).
 *
 * The editor is open from the start for somebody who may change the order; a
 * reader sees the notes. «Save notes» is off until something changed and while a
 * save is in flight; «Discard changes» shows only with a change.
 *
 * ⚠️ **The synchronisation contract (R04).** `RichTextEditor` reads `content` only
 * when it is CREATED, so a new prop does not change the visible text. Resetting the
 * visible editor is therefore a remount, by `key` — local to this component; the
 * editor's API for its other users is unchanged.
 * - The **baseline** is the saved text changes are measured against.
 * - A background re-read (`order.notes` changed): a clean editor takes the new text
 *   (baseline + remount); a dirty one takes only the new baseline — what the
 *   operator typed is never overwritten.
 * - «Discard changes»: the draft becomes the baseline, and the editor is remounted.
 * - A successful save makes the SENT text the baseline, whatever the next read says;
 *   text typed while it was in flight stays a change. A refusal is a toast, and both
 *   the draft and the baseline stay where they were.
 *
 * ⚠️ **Rendered through `DOMPurify.sanitize`** for a reader: the field round-trips
 * through the API, so what comes back is not necessarily what this build put there.
 */
export function OrderNotes({ order, canEdit }: OrderNotesProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const [baseline, setBaseline] = useState(() => normalize(order.notes));
  const [draft, setDraft] = useState(() => normalize(order.notes));
  const [version, setVersion] = useState(0);

  // What the last effect saw of the server, and the current draft and baseline for it
  // to judge «clean» by — refs, so the effect runs on the server's text alone.
  const seen = useRef(normalize(order.notes));
  const draftRef = useRef(draft);
  const baselineRef = useRef(baseline);
  draftRef.current = draft;
  baselineRef.current = baseline;

  useEffect(() => {
    const server = normalize(order.notes);
    if (server === seen.current) return;
    seen.current = server;
    const clean = normalize(draftRef.current) === baselineRef.current;
    setBaseline(server);
    if (clean) {
      setDraft(server);
      setVersion((v) => v + 1);
    }
  }, [order.notes]);

  const save = useMutation({
    mutationFn: (notes: string) => api.updateOrder(order.id, { notes }),
    onSuccess: (_saved, sent) => {
      setBaseline(sent);
      invalidateOrderViews(queryClient, { orderId: order.id });
    },
    onError: (e: Error) => showToast(e.message, 'error'),
  });

  if (!canEdit) {
    // A stored empty document is no notes, as for the editor (final review M11).
    const notes = normalize(order.notes);
    return (
      <section className="space-y-3">
        {notes ? (
          <div
            className="prose prose-invert prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(notes) }}
          />
        ) : (
          <p className="text-sm text-bambu-gray">{t('orders.notes.empty')}</p>
        )}
      </section>
    );
  }

  const dirty = normalize(draft) !== baseline;

  return (
    // No heading of its own — the «Notes» tab names it (WS-13 E3 F05).
    <section className="space-y-3">
      <RichTextEditor
        key={version}
        content={draft}
        onChange={setDraft}
        placeholder={t('orders.notes.placeholder')}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => save.mutate(normalize(draft))} disabled={!dirty || save.isPending}>
          {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {t('orders.notes.save')}
        </Button>
        {dirty && (
          <Button
            variant="secondary"
            size="sm"
            disabled={save.isPending}
            onClick={() => {
              setDraft(baseline);
              setVersion((v) => v + 1);
            }}
          >
            {t('orders.notes.discard')}
          </Button>
        )}
      </div>
    </section>
  );
}
