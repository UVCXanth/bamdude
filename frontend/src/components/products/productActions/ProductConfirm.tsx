import { useTranslation } from 'react-i18next';
import { ActionConfirm } from '../../workshop/ActionConfirm';
import type { ProductRef } from './productRef';

export type ProductConfirmKind = 'delete' | 'promote';

/**
 * The two confirmations of a product (WS-13 E8 F06, F07): the product named, what THIS
 * action does to it, a dismiss and a primary named for the action. The request is the
 * host's (`send`); a refusal stays in the dialog with the server's sentence, translated
 * at the boundary, and the focus stays on the button that sent it (F09). While the
 * request runs nothing sends it again or closes the dialog — buttons, Escape, the X.
 * Those rules are `ActionConfirm`'s (WS-13 E9 B11); this names the two product actions.
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
    <ActionConfirm
      title={t(kind === 'delete' ? 'products.confirm.deleteTitle' : 'products.confirm.promoteTitle')}
      subtitle={`${product.code} · ${product.name}`}
      body={body}
      primaryLabel={t(kind === 'delete' ? 'common.delete' : 'products.confirm.promoteYes')}
      danger={kind === 'delete'}
      send={send}
      onClose={onClose}
    />
  );
}
