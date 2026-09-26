import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpToLine, Plus, X } from 'lucide-react';
import { useDeliveryMethods } from '../../hooks/useDeliveryMethods';
import { Button } from '../Button';
import { Select } from '../Select';
import { DeliveryMethodsModal } from './DeliveryMethodsModal';
import { emptyDraft, isBlankLinked, type ContactDraft } from './contactDrafts';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';
const LABEL_CLASS = 'block text-xs text-bambu-gray mb-1';

type TextField = 'name' | 'role' | 'phone' | 'email' | 'city' | 'deliveryDetails' | 'note';
type InputField = Exclude<TextField, 'note'>;

interface RowProps {
  draft: ContactDraft;
  index: number;
  disabled?: boolean;
  confirming: boolean;
  onField: (field: TextField, value: string) => void;
  onMethod: (id: number | null) => void;
  onMakeMain: () => void;
  onRemove: () => void;
  onKeep: () => void;
  onManage: () => void;
}

function ContactRow({ draft, index, disabled, confirming, onField, onMethod, onMakeMain, onRemove, onKeep, onManage }: RowProps) {
  const { t } = useTranslation();
  const base = useId();
  const { data: methods = [] } = useDeliveryMethods();
  const text = (field: InputField, labelKey: string, type = 'text', span = '') => (
    <div className={span}>
      <label className={LABEL_CLASS} htmlFor={`${base}-${field}`}>
        {t(labelKey)}
      </label>
      <input
        id={`${base}-${field}`}
        type={type}
        value={draft[field]}
        onChange={(e) => onField(field, e.target.value)}
        className={FIELD_CLASS}
        disabled={disabled}
      />
    </div>
  );

  return (
    // A group named «Contact N»: every row repeats «Make main» and «Remove contact»,
    // and a screen reader tells them apart by the group it enters.
    <div
      role="group"
      aria-labelledby={`${base}-title`}
      data-testid="contact-row"
      className="rounded-lg border border-bambu-dark-tertiary p-3 space-y-2"
    >
      <div className="flex items-center gap-2 text-xs text-bambu-gray">
        <span id={`${base}-title`}>{t('customers.contacts.row', { n: index + 1 })}</span>
        {index === 0 && (
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-bambu-green/15 text-bambu-green">
            {t('customers.contacts.main')}
          </span>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {text('name', 'customers.contacts.name')}
        {text('role', 'customers.contacts.role')}
        {text('phone', 'customers.contacts.phone', 'tel')}
        {text('email', 'customers.contacts.email', 'email')}
        {text('city', 'customers.contacts.city')}
        <div>
          <label className={LABEL_CLASS} htmlFor={`${base}-method`}>
            {t('customers.delivery.method')}
          </label>
          <Select
            id={`${base}-method`}
            className="w-full"
            value={draft.deliveryMethodId ?? ''}
            onChange={(e) => onMethod(e.target.value ? Number(e.target.value) : null)}
            disabled={disabled}
          >
            <option value="">{t('customers.delivery.none')}</option>
            {methods.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          <button type="button" onClick={onManage} className="mt-1 text-xs text-bambu-green hover:underline" disabled={disabled}>
            {t('customers.delivery.manage')}
          </button>
        </div>
        {text('deliveryDetails', 'customers.delivery.details', 'text', 'sm:col-span-3')}
        {/* Several lines: the old free-text contact moves here whole when it could not be split. */}
        <div className="sm:col-span-3">
          <label className={LABEL_CLASS} htmlFor={`${base}-note`}>
            {t('customers.contacts.note')}
          </label>
          <textarea
            id={`${base}-note`}
            rows={2}
            value={draft.note}
            onChange={(e) => onField('note', e.target.value)}
            className={`${FIELD_CLASS} resize-y`}
            disabled={disabled}
          />
        </div>
      </div>
      {isBlankLinked(draft) && !confirming && (
        <p className="text-xs text-status-warning">
          {t('customers.contacts.blankLinked', { count: draft.ordersCount })}
        </p>
      )}
      {confirming ? (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-status-warning">{t('customers.contacts.linkedWarning', { count: draft.ordersCount })}</span>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onKeep}>
              {t('customers.contacts.keep')}
            </Button>
            <Button type="button" variant="danger" onClick={onRemove}>
              {t('customers.contacts.removeAnyway')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          {index > 0 && (
            <Button type="button" variant="secondary" onClick={onMakeMain} disabled={disabled}>
              <ArrowUpToLine className="w-4 h-4" />
              {t('customers.contacts.makeMain')}
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={onRemove} disabled={disabled}>
            <X className="w-4 h-4" />
            {t('customers.contacts.remove')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The customer form's contacts (spec workshop-customers, rule 19). The first row
 * is the main contact; «Make main» moves a row to the top. A contact orders name
 * is removed only after a second click that says what happens to them — the
 * server clears their contact, the warning just says so first. Emptying such a
 * row field by field would drop it all the same, so it holds the save (in
 * `CustomerModal`) until it is filled in again or removed through that warning.
 */
export function ContactRowsEditor({
  drafts,
  onChange,
  disabled,
}: {
  drafts: ContactDraft[];
  onChange: (next: ContactDraft[]) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const patch = (key: string, change: Partial<ContactDraft>) =>
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...change } : d)));
  const remove = (key: string) => {
    setConfirming(null);
    onChange(drafts.filter((d) => d.key !== key));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white">{t('customers.contacts.title')}</span>
        <Button type="button" variant="secondary" onClick={() => onChange([...drafts, emptyDraft()])} disabled={disabled}>
          <Plus className="w-4 h-4" />
          {t('customers.contacts.add')}
        </Button>
      </div>
      <p className="text-xs text-bambu-gray">{t('customers.contacts.mainHint')}</p>
      {drafts.map((d, index) => (
        <ContactRow
          key={d.key}
          draft={d}
          index={index}
          disabled={disabled}
          confirming={confirming === d.key}
          onField={(field, value) => patch(d.key, { [field]: value })}
          onMethod={(id) => patch(d.key, { deliveryMethodId: id })}
          onMakeMain={() => onChange([d, ...drafts.filter((x) => x.key !== d.key)])}
          onRemove={() => (d.ordersCount > 0 && confirming !== d.key ? setConfirming(d.key) : remove(d.key))}
          onKeep={() => setConfirming(null)}
          onManage={() => setManaging(true)}
        />
      ))}
      {managing && <DeliveryMethodsModal onClose={() => setManaging(false)} />}
    </div>
  );
}
