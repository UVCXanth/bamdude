import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { api, WAYBILL_MAX } from '../../api/client';
import { useInnerEscape } from '../../hooks/useInnerEscape';
import { Button } from '../Button';

const ICON_BTN = 'p-1 rounded text-bambu-gray hover:text-white hover:bg-bambu-dark transition-colors';

/**
 * A dispatch note's waybill — the one thing besides its note that changes after the issue
 * (WS-13 E12 J03, R08): «Waybill N» or «No waybill», and a pencil (`stock:move`) that
 * opens a field. The same editor stands in the notes' tables and on the document page.
 *
 * The full cycle: the draft is taken once, when the editing starts — a re-read of the list
 * or the document under it does not overwrite it; Enter or «Save» sends ONE `PATCH`
 * (synchronous `sent`), an unchanged trimmed text sends nothing and closes, an empty one
 * sends `null`; under the request the field is read-only and its buttons `aria-disabled`
 * (the focus stays in the editor, Escape does nothing); a refusal is said under the field
 * in the system language with the text kept and the cursor in it; a success refreshes the
 * lists and the document, closes the editor and gives the focus to the pencil — and
 * `onSaved` hands the pencil to a watch for the row leaving (a search by the old waybill).
 * Escape (`useInnerEscape`) and «Cancel» close the editor only — and never while a save is on
 * its way: they ask the same synchronous `sent` the press took (Codex E12-V02), so a refusal
 * always finds its text and says why.
 *
 * The session — draft, saved value, refusal, request — belongs to ONE note (Codex E12-V01):
 * another note (the document page stays mounted from one note to the next) starts a new
 * session, and the old request's answer has no session left to write into. A re-read of the
 * SAME note still never overwrites the draft.
 */
export function WaybillEditor(props: Parameters<typeof WaybillSession>[0]) {
  return <WaybillSession key={props.noteId} {...props} />;
}

function WaybillSession({
  noteId,
  waybill,
  canEdit,
  onSaved,
}: {
  noteId: number;
  waybill: string | null;
  canEdit: boolean;
  /** After a save, with the pencil the focus went to — the list watches its row. */
  onSaved?: (pencil: HTMLButtonElement | null) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const errorId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  // A saved waybill is what the row says at once — until the list or the document answers
  // with anything else for it (final review M11).
  const [saved, setSaved] = useState<{ value: string | null; over: string | null } | null>(null);
  const shown = saved && saved.over === waybill ? saved.value : waybill;
  useEffect(() => {
    if (saved && waybill !== saved.over) setSaved(null);
  }, [waybill, saved]);
  const [error, setError] = useState<string | null>(null);
  // Where the focus goes once the editor is gone, and whether a save closed it.
  const [after, setAfter] = useState<'pencil' | 'saved' | null>(null);
  const sent = useRef(false);
  const layer = useRef<HTMLSpanElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const pencil = useRef<HTMLButtonElement>(null);

  const save = useMutation({
    mutationFn: (value: string | null) => api.updateStockIssue(noteId, { waybill: value }),
    onSuccess: (_row, value) => {
      sent.current = false;
      setSaved({ value, over: waybill });
      void queryClient.invalidateQueries({ queryKey: ['dispatch-notes'] });
      void queryClient.invalidateQueries({ queryKey: ['dispatch-note', noteId] });
      setDraft(null);
      setError(null);
      setAfter('saved');
    },
    onError: (e: Error) => {
      sent.current = false;
      setError(e.message);
      field.current?.focus();
    },
  });
  const pending = save.isPending;
  const editing = draft !== null;

  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (editing || after === null) return;
    pencil.current?.focus();
    if (after === 'saved') onSaved?.(pencil.current);
    setAfter(null);
    // The close is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, after]);

  const close = () => {
    // Under a save nothing closes the editor — not even in the frame of the press (V02).
    if (sent.current) return;
    setDraft(null);
    setError(null);
    setAfter('pencil');
  };
  useInnerEscape(layer, editing, () => {
    if (!pending) close();
  });

  const submit = () => {
    if (sent.current || pending || draft === null) return;
    const next = draft.trim();
    if (next === (shown ?? '').trim()) {
      close();
      return;
    }
    sent.current = true;
    setError(null);
    save.mutate(next || null);
  };

  if (!editing) {
    return (
      <span className="flex items-center gap-1 text-xs text-bambu-gray">
        <span className="tabular-nums">
          {shown ? t('stock.dispatchNote.waybill', { waybill: shown }) : t('stock.notes.noWaybill')}
        </span>
        {canEdit && (
          <button
            ref={pencil}
            type="button"
            onClick={() => {
              setError(null);
              setDraft(shown ?? '');
            }}
            aria-label={t('stock.notes.editWaybill')}
            title={t('stock.notes.editWaybill')}
            className={ICON_BTN}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </span>
    );
  }

  return (
    <span ref={layer} className="flex flex-col gap-1">
      <span className="flex items-center gap-1">
        <input
          ref={field}
          value={draft}
          maxLength={WAYBILL_MAX}
          readOnly={pending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          aria-label={t('stock.notes.waybill')}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="w-36 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-sm text-white tabular-nums"
        />
        <Button size="sm" onClick={submit} aria-disabled={pending || undefined}>
          {t('common.save')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (!pending) close();
          }}
          aria-disabled={pending || undefined}
        >
          {t('common.cancel')}
        </Button>
      </span>
      {error && (
        <span id={errorId} role="alert" className="text-xs text-red-500">
          {error}
        </span>
      )}
    </span>
  );
}
