import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '../Button';
import { WorkshopDialog, type WorkshopDialogSize } from './WorkshopDialog';

/**
 * The Workshop's one confirmation (WS-13 E9 B11) — the rules E6 and E8 already keep for
 * an order's and a product's confirmations, in one place:
 * - the entity named (`title`, `subtitle`) and what THIS action does to it (`body`);
 * - one click, one request: a second click in the same tick sees TanStack's `isPending`
 *   still false, so a ref holds it, and `sending` is set by the click itself — `isPending`
 *   arrives a macrotask later, and an Escape in between must not close a dialog whose
 *   request is already on its way;
 * - while the request runs nothing closes the dialog — Escape, the X, «Cancel» — and the
 *   primary says so («…»);
 * - a refusal stays in the dialog with the server's sentence (translated at the boundary)
 *   and the focus on the button that sent it; it may be sent again;
 * - a success closes it. What the success invalidates is `send`'s; where the focus goes
 *   when the trigger left with its row is the caller's (`useFocusWhenRowLeaves`).
 */
export function ActionConfirm({
  title,
  subtitle,
  body,
  primaryLabel,
  cancelLabel,
  danger = false,
  send,
  onClose,
  size = 'sm',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  body: ReactNode;
  primaryLabel: string;
  /** The way back, where «Cancel» says less than the action's own word (discarding a draft: «Stay»). */
  cancelLabel?: string;
  danger?: boolean;
  /** The write and everything after its success; it rejects with the refusal. */
  send: () => Promise<unknown>;
  onClose: () => void;
  size?: WorkshopDialogSize;
}) {
  const { t } = useTranslation();
  const sent = useRef(false);
  const [sending, setSending] = useState(false);
  const primaryId = useId();
  const write = useMutation({
    mutationFn: send,
    onSuccess: () => onClose(),
    onError: () => {
      sent.current = false;
      setSending(false);
    },
  });
  const busy = sending || write.isPending;
  // Escape, the X and «Cancel» ask the ref the click set: `busy` reaches them only with the
  // next render, and an Escape in the same frame would close a dialog whose request is on
  // its way (J; Codex E10-V01). The success closes through `onClose` itself.
  const close = () => {
    if (sent.current) return;
    onClose();
  };

  useEffect(() => {
    if (write.isError) document.getElementById(primaryId)?.focus();
  }, [write.isError, write.error, primaryId]);

  return (
    <WorkshopDialog
      size={size}
      onClose={close}
      title={title}
      subtitle={subtitle}
      pending={busy}
      error={write.isError ? (write.error as Error).message : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            id={primaryId}
            variant={danger ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => {
              if (sent.current) return;
              sent.current = true;
              setSending(true);
              write.mutate();
            }}
          >
            {primaryLabel}
            {busy && '…'}
          </Button>
        </>
      }
    >
      {body}
    </WorkshopDialog>
  );
}
