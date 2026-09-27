import { useTranslation } from 'react-i18next';
import type { FulfilmentRecipient } from '../../../api/client';
import { useDeliveryMethods } from '../../../hooks/useDeliveryMethods';
import { Select } from '../../Select';

const FIELD_CLS = 'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white';

/**
 * Who takes the goods (spec workshop-order-issue, rules 1 and 27): name, phone, a
 * delivery method off the directory and its details — copied into the issue as
 * text, so a later edit of the contact or the directory does not rewrite it. The
 * issue dialog and the stock page's manual issue both ask it this way.
 */
export function RecipientFields({
  value,
  onChange,
}: {
  value: FulfilmentRecipient;
  onChange: (next: FulfilmentRecipient) => void;
}) {
  const { t } = useTranslation();
  const { data: methods = [] } = useDeliveryMethods();
  const names = methods.map((m) => m.name);
  // A snapshot may name a method since renamed or removed: it stays pickable.
  if (value.delivery_method && !names.includes(value.delivery_method)) names.unshift(value.delivery_method);
  const set = (field: keyof FulfilmentRecipient, text: string) => onChange({ ...value, [field]: text || null });

  return (
    <>
      <label className="text-sm space-y-1">
        <span className="text-bambu-gray">{t('orders.fulfil.recipientName')}</span>
        <input
          value={value.name ?? ''}
          onChange={(e) => set('name', e.target.value)}
          aria-label={t('orders.fulfil.recipientName')}
          className={FIELD_CLS}
        />
      </label>
      <label className="text-sm space-y-1">
        <span className="text-bambu-gray">{t('orders.fulfil.phone')}</span>
        <input
          value={value.phone ?? ''}
          onChange={(e) => set('phone', e.target.value)}
          aria-label={t('orders.fulfil.phone')}
          className={FIELD_CLS}
        />
      </label>
      <label className="text-sm space-y-1">
        <span className="text-bambu-gray">{t('orders.fulfil.deliveryMethod')}</span>
        <Select
          value={value.delivery_method ?? ''}
          onChange={(e) => set('delivery_method', e.target.value)}
          aria-label={t('orders.fulfil.deliveryMethod')}
          className="w-full"
        >
          <option value="">{t('orders.fulfil.noMethod')}</option>
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
      </label>
      <label className="text-sm space-y-1">
        <span className="text-bambu-gray">{t('orders.fulfil.deliveryDetails')}</span>
        <input
          value={value.delivery_details ?? ''}
          onChange={(e) => set('delivery_details', e.target.value)}
          aria-label={t('orders.fulfil.deliveryDetails')}
          className={FIELD_CLS}
        />
      </label>
    </>
  );
}
