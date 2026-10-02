import { useEffect, useId, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '../../Button';
import { WorkshopDialog } from '../../workshop/WorkshopDialog';
import type { ProductRef } from './productRef';

export type ProductConfirmKind = 'delete' | 'promote';

/**
 * The two confirmations of a product (WS-13 E8 F06, F07): the product named, what THIS
 * action does to it, a dismiss and a primary named for the action. The request is the
 * host's (`send`); a refusal stays in the dialog with the server's sentence, translated
 * at the boundary, and the focus stays on the button that sent it (F09). While the
 * request runs nothing sends it again or closes the dialog — buttons, Escape, the X.
 */
export function ProductConfirm({
  kind,
  product,
  send,
  onClose,
}: {
  kind: ProductConfirmKind;
  product: ProductRef;
  /** The write and everything after its success; it rejects with the refusal. */
  send: () => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // A second click in the same tick sees `isPending` still false — the ref is what makes
  // «one click, one request» hold (E6 I4.6); a refusal re-arms it. `sending` is set by
  // the click itself: TanStack reports `isPending` a macrotask later, and an Escape in
  // between must not close a dialog whose request is already on its way (F09).
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

  useEffect(() => {
    if (write.isError) document.getElementById(primaryId)?.focus();
  }, [write.isError, write.error, primaryId]);

  const body =
    kind === 'delete' ? (
      <p className="text-sm text-bambu-gray-light">{t('products.confirm.deleteBody')}</p>
    ) : (
      <p className="text-sm text-bambu-gray-light">
        {t('products.confirm.promoteBody')}{' '}
        {t(product.is_active ? 'products.confirm.promoteActive' : 'products.confirm.promoteHidden')}
      </p>
    );

  return (
    <WorkshopDialog
      size="sm"
      onClose={onClose}
      title={t(kind === 'delete' ? 'products.confirm.deleteTitle' : 'products.confirm.promoteTitle')}
      subtitle={`${product.code} · ${product.name}`}
      pending={busy}
      error={write.isError ? (write.error as Error).message : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            id={primaryId}
            variant={kind === 'delete' ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() => {
              if (sent.current) return;
              sent.current = true;
              setSending(true);
              write.mutate();
            }}
          >
            {t(kind === 'delete' ? 'common.delete' : 'products.confirm.promoteYes')}
            {busy && '…'}
          </Button>
        </>
      }
    >
      {body}
    </WorkshopDialog>
  );
}
