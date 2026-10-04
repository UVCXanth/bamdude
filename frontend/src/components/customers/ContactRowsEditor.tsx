import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpToLine, Plus, X } from 'lucide-react';
import type { DeliveryMethod } from '../../api/client';
import { useDeliveryMethods } from '../../hooks/useDeliveryMethods';
import { Button } from '../Button';
import { Select } from '../Select';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { DeliveryMethodsModal } from './DeliveryMethodsModal';
import { emptyDraft, isBlankDraft, isBlankLinked, methodIsGone, type ContactDraft } from './contactDrafts';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';
const LABEL_CLASS = 'block text-xs text-bambu-gray mb-1';
// The contact columns are 255 characters (models/customer.py, CustomerContactIn).
const FIELD_MAX = 255;
// ≤ 760 every field takes the one column; the remove button stays right of the first.
const FIELD_CELL = 'min-w-0 max-[761px]:col-start-1 max-[761px]:col-span-1';

type TextField = 'name' | 'role' | 'phone' | 'email' | 'city' | 'deliveryDetails' | 'note';
type InputField = Exclude<TextField, 'note'>;

interface RowProps {
  draft: ContactDraft;
  index: number;
  main: boolean;
  disabled?: boolean;
  confirming: boolean;
  focusOnMount: boolean;
  canManageMethods: boolean;
  /** Methods made in the reference during this form — offered beside the list (V03). */
  created: DeliveryMethod[];
  onField: (field: TextField, value: string) => void;
  onMethod: (id: number | null, name: string | null) => void;
  onMakeMain: () => void;
  onRemove: () => void;
  onKeep: () => void;
  onManage: () => void;
}

function ContactRow({
  draft,
  index,
  main,
  disabled,
  confirming,
  focusOnMount,
  canManageMethods,
  created,
  onField,
  onMethod,
  onMakeMain,
  onRemove,
  onKeep,
  onManage,
}: RowProps) {
  const { t } = useTranslation();
  const base = useId();
  const methods = useDeliveryMethods();
  // A current answer of the reference is the whole list. Anything else — still read, failed,
  // never read — is what is known: the last answer plus the methods this form made (Codex
  // E11-V03). It is never taken for the whole reference: only `methodIsGone`, which asks a
  // current answer alone, may call a contact's method gone.
  const current = methods.status === 'success' && !methods.isFetching;
  const read = methods.data ?? [];
  const list = current ? read : [...read, ...created.filter((m) => !read.some((r) => r.id === m.id))];
  const gone = methodIsGone(draft, methods);
  const known = draft.deliveryMethodId != null && list.some((m) => m.id === draft.deliveryMethodId);
  // The note is a field of its own only when there is one, or it is asked for (F20).
  const [noteOpen, setNoteOpen] = useState(draft.note !== '');
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // «+ Note» opens the field and puts the cursor in it, once it is there.
  const focusNote = useRef(false);
  useEffect(() => {
    if (noteOpen && focusNote.current) {
      focusNote.current = false;
      noteRef.current?.focus();
    }
  }, [noteOpen]);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOnMount) nameRef.current?.focus();
    // Once, when the row is added (F03).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const text = (field: InputField, labelKey: string, type = 'text', span = '') => (
    <div className={`${FIELD_CELL} ${span}`}>
      <label className={LABEL_CLASS} htmlFor={`${base}-${field}`}>
        {t(labelKey)}
      </label>
      <input
        id={`${base}-${field}`}
        ref={field === 'name' ? nameRef : undefined}
        type={type}
        value={draft[field]}
        maxLength={FIELD_MAX}
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
      className="pb-2 border-b border-bambu-dark-tertiary space-y-2"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-bambu-gray">
        <span id={`${base}-title`}>{t('customers.contacts.row', { n: index + 1 })}</span>
        {draft.code && <span className="text-bambu-gray/80">{draft.code}</span>}
        {main && (
          <span className="px-1.5 py-0.5 rounded text-[10px] bg-bambu-green/15 text-bambu-green">
            {t('customers.contacts.main')}
          </span>
        )}
        {!main && !isBlankDraft(draft) && !confirming && (
          <button
            type="button"
            onClick={onMakeMain}
            disabled={disabled}
            className="inline-flex items-center gap-1 text-bambu-green hover:underline disabled:opacity-50"
          >
            <ArrowUpToLine className="w-3.5 h-3.5" aria-hidden />
            {t('customers.contacts.makeMain')}
          </button>
        )}
      </div>
      {/* Top-aligned: a row's labels stay on one line however tall the method's cell grows
          under its select; the × and «+ Note» sit at their row's foot, beside the fields. */}
      <div className="grid gap-2 items-start grid-cols-[repeat(3,minmax(0,1fr))_auto] max-[761px]:grid-cols-[minmax(0,1fr)_auto]">
        {text('name', 'customers.contacts.name')}
        {text('role', 'customers.contacts.role')}
        {text('phone', 'customers.contacts.phone', 'tel')}
        {/* After the phone in the DOM, so Tab reaches it where it is drawn — the end of the
            first line (its grid place is explicit). */}
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled || confirming}
          aria-label={t('customers.contacts.remove')}
          title={t('customers.contacts.remove')}
          className="col-start-4 row-start-1 self-end max-[761px]:col-start-2 p-2 rounded-lg text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary disabled:opacity-50"
        >
          <X className="w-4 h-4" />
        </button>
        {text('email', 'customers.contacts.email', 'email')}
        {text('city', 'customers.contacts.city')}
        <div className={FIELD_CELL}>
          <label className={LABEL_CLASS} htmlFor={`${base}-method`}>
            {t('customers.delivery.method')}
          </label>
          <Select
            id={`${base}-method`}
            className="w-full"
            value={draft.deliveryMethodId ?? ''}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : null;
              onMethod(id, list.find((m) => m.id === id)?.name ?? null);
            }}
            aria-describedby={gone ? `${base}-method-hint` : undefined}
            aria-invalid={gone || undefined}
            disabled={disabled}
          >
            <option value="">{t('customers.delivery.none')}</option>
            {/* The chosen method while the reference is read, failed, or no longer has it:
                never swapped for the first option, never shown as «none» (F13). */}
            {draft.deliveryMethodId != null && !known && (
              <option value={draft.deliveryMethodId}>
                {`${draft.deliveryMethodName ?? t('customers.delivery.unknownMethod', { id: draft.deliveryMethodId })}${
                  gone ? ` ${t('customers.delivery.gone')}` : ''
                }`}
              </option>
            )}
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          {gone && (
            <p id={`${base}-method-hint`} className="mt-1 text-xs text-status-warning">
              {t('customers.delivery.goneHint')}
            </p>
          )}
          {methods.isError && !methods.data && (
            <LoadFailedNote
              role="status"
              className="mt-1 text-xs"
              message={t('customers.delivery.loadFailed')}
              onRetry={() => methods.refetch()}
            />
          )}
          {canManageMethods && (
            <button type="button" onClick={onManage} className="mt-1 text-xs text-bambu-green hover:underline" disabled={disabled}>
              {t('customers.delivery.manage')}
            </button>
          )}
        </div>
        {text('deliveryDetails', 'customers.delivery.details', 'text', 'col-span-2')}
        {!noteOpen && (
          <div className={`${FIELD_CELL} self-end`}>
            <button
              type="button"
              onClick={() => {
                focusNote.current = true;
                setNoteOpen(true);
              }}
              disabled={disabled}
              className="py-2 text-xs text-bambu-green hover:underline disabled:opacity-50"
            >
              {t('customers.contacts.addNote')}
            </button>
          </div>
        )}
        {noteOpen && (
          // Several lines: the old free-text contact moves here whole when it could not be split.
          <div className={`${FIELD_CELL} col-span-3`}>
            <label className={LABEL_CLASS} htmlFor={`${base}-note`}>
              {t('customers.contacts.note')}
            </label>
            <textarea
              id={`${base}-note`}
              ref={noteRef}
              rows={2}
              value={draft.note}
              onChange={(e) => onField('note', e.target.value)}
              className={`${FIELD_CLASS} resize-y`}
              disabled={disabled}
            />
          </div>
        )}
      </div>
      {isBlankLinked(draft) && !confirming && (
        <p className="text-xs text-status-warning">{t('customers.contacts.blankLinked', { count: draft.ordersCount })}</p>
      )}
      {confirming && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
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
      )}
    </div>
  );
}

/**
 * The customer form's contacts (WS-13 E11 F03–F07; spec workshop-customers, rule 19), in the
 * mockup's `.m-contactrow` grid: three columns and the remove button in a fourth, one column
 * at 760 and narrower. The first row that will be SENT is the main contact (F05) — an empty
 * row above it is not; «Make main» moves a row to the top. A contact orders name is removed
 * only after a second click that says what happens to them; emptying such a row field by
 * field would drop it all the same, so it holds the save (in `CustomerModal`). The delivery
 * reference opens over the form only for somebody who may change it (`customers:update`, R03).
 */
export function ContactRowsEditor({
  drafts,
  onChange,
  disabled,
  canManageMethods,
}: {
  drafts: ContactDraft[];
  onChange: (next: ContactDraft[]) => void;
  disabled?: boolean;
  canManageMethods: boolean;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [created, setCreated] = useState<DeliveryMethod[]>([]);
  const methods = useDeliveryMethods();
  const patch = (key: string, change: Partial<ContactDraft>) =>
    onChange(drafts.map((d) => (d.key === key ? { ...d, ...change } : d)));
  const remove = (key: string) => {
    setConfirming(null);
    onChange(drafts.filter((d) => d.key !== key));
  };
  const mainKey = drafts.find((d) => !isBlankDraft(d))?.key;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <b className="text-sm font-semibold text-white">{t('customers.contacts.title')}</b>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            const next = emptyDraft();
            setAdded(next.key);
            onChange([...drafts, next]);
          }}
          disabled={disabled}
        >
          <Plus className="w-4 h-4" />
          {t('customers.contacts.add')}
        </Button>
      </div>
      <p className="text-xs text-bambu-gray">{t('customers.contacts.mainHint')}</p>
      {/* A failed RE-read keeps the options it had — said once for every row, with a retry
          (Codex E11-V04); a reference never read says so in each row's select instead. */}
      {methods.isError && methods.data && <RefreshFailedNote onRetry={() => void methods.refetch()} />}
      <div className="grid gap-2">
        {drafts.map((d, index) => (
          <ContactRow
            key={d.key}
            draft={d}
            index={index}
            main={d.key === mainKey}
            disabled={disabled}
            confirming={confirming === d.key}
            focusOnMount={d.key === added}
            canManageMethods={canManageMethods}
            created={created}
            onField={(field, value) => patch(d.key, { [field]: value })}
            onMethod={(id, name) => patch(d.key, { deliveryMethodId: id, deliveryMethodName: name })}
            onMakeMain={() => onChange([d, ...drafts.filter((x) => x.key !== d.key)])}
            onRemove={() => (d.ordersCount > 0 && confirming !== d.key ? setConfirming(d.key) : remove(d.key))}
            onKeep={() => setConfirming(null)}
            onManage={() => setManaging(true)}
          />
        ))}
      </div>
      {managing && (
        <DeliveryMethodsModal
          onClose={() => setManaging(false)}
          onCreated={(method) => setCreated((known) => (known.some((m) => m.id === method.id) ? known : [...known, method]))}
        />
      )}
    </div>
  );
}
