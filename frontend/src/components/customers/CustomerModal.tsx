import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, CUSTOMER_KINDS } from '../../api/client';
import type { Customer, CustomerCreate, CustomerKind, CustomerUpdate } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useDeliveryMethods } from '../../hooks/useDeliveryMethods';
import { invalidateOrderViews } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { Select } from '../Select';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { WorkshopField, WorkshopFormGrid } from '../workshop/WorkshopFormGrid';
import { ContactRowsEditor } from './ContactRowsEditor';
import { draftFromContact, draftsToInput, emptyDraft, isBlankLinked, methodIsGone, type ContactDraft } from './contactDrafts';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none';
// `customers.name` is 255 characters (models/customer.py, CustomerCreate).
const NAME_MAX = 255;

interface CustomerModalProps {
  customer?: Customer | null;
  onClose: () => void;
}

const cleanNotes = (value: string) => (value.trim() === '' ? null : value.trim());
// The contacts as the request would carry them — what «did the contacts change» compares
// (Codex E11 r2 note 2): a method's display label is not in it, so a rename in the
// reference never adds the contacts to a PATCH.
const contactsPayload = (drafts: ContactDraft[]) => JSON.stringify(draftsToInput(drafts));

/**
 * Create / edit one customer (WS-13 E11 F, F20) — the mockup's form in a WorkshopDialog: the
 * name, the type, the contacts and the team note.
 *
 * - **One session (J E10):** the base is the customer at the opening; a background refresh
 *   never reseeds what is typed. An edit sends what changed since then — `contacts` only
 *   when the list as it would be sent differs (F09); with nothing changed nothing is sent.
 * - **A namesake is a warning (A01, R01):** the server's `name_taken` is said in the slot
 *   with its question and the primary becomes «Save anyway». The agreement belongs to the
 *   name that refusal answered: the next press sends the CURRENT draft with
 *   `allow_duplicate_name`, and changing the name, «Cancel» or a new opening takes it back.
 * - **Refusals** stay in the dialog in the server's words, the focus on the button that
 *   sent them; an empty name is said with the cursor back in the field. Nothing closes the
 *   dialog under a request, decided synchronously (`sent`, F10).
 * - A method the reference no longer has holds a save that sends contacts (F13); while the
 *   reference is read or failed nothing is judged — the server stays the guard.
 *
 * A new customer opens at once (F11); an edit closes with a toast. The saved record reaches
 * every list through `invalidateOrderViews` (`OrderListItem.customer_name` is denormalised).
 */
export function CustomerModal({ customer, onClose }: CustomerModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { hasPermission } = useAuth();
  const methods = useDeliveryMethods();
  const ids = { name: useId(), kind: useId(), notes: useId(), form: useId() };
  const submitId = `${ids.form}-submit`;

  // The session's base: the customer as the dialog opened on it.
  const [base] = useState(() => customer ?? null);
  const [baseContacts] = useState(() => (base ? contactsPayload(base.contacts.map(draftFromContact)) : ''));
  const [name, setName] = useState(base?.name ?? '');
  const [kind, setKind] = useState<CustomerKind>(base?.kind ?? 'company');
  const [drafts, setDrafts] = useState<ContactDraft[]>(() => (base ? base.contacts.map(draftFromContact) : [emptyDraft()]));
  const [notes, setNotes] = useState(base?.notes ?? '');
  const [localError, setLocalError] = useState<string | null>(null);
  // The name a `name_taken` refusal answered — the agreement belongs to it alone (R01).
  const [warned, setWarned] = useState<string | null>(null);
  const nameNow = useRef(name);
  nameNow.current = name;

  // The cursor starts in the name (F01).
  useEffect(() => {
    document.getElementById(ids.name)?.focus();
    // Once, at the opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mutation = useMutation({
    mutationFn: (data: CustomerCreate | CustomerUpdate) =>
      base ? api.updateCustomer(base.id, data as CustomerUpdate) : api.createCustomer(data as CustomerCreate),
    onSuccess: (saved) => {
      invalidateOrderViews(queryClient, { customerId: base?.id ?? saved.id });
      onClose();
      if (base) {
        showToast(t('customers.toast.saved'));
        return;
      }
      showToast(t('customers.toast.created'));
      navigate(`/customers/${saved.id}`);
    },
    onError: (e: Error, data) => {
      const asked = (data as { name?: string }).name;
      // Only a refusal of the name still in the field may be agreed to.
      if (e instanceof ApiError && e.code === 'name_taken' && asked !== undefined && asked === nameNow.current.trim()) {
        setWarned(asked);
      }
    },
  });

  // ⚠️ Synchronous (F10): a press and an Escape in the same tick see `isPending` still
  // false — the ref makes «one press, one request» and «no closing under a request» hold.
  const sent = useRef(false);
  useEffect(() => {
    if (mutation.isError) {
      sent.current = false;
      document.getElementById(submitId)?.focus();
    }
  }, [mutation.isError, mutation.error, submitId]);
  const close = () => {
    if (sent.current) return;
    onClose();
  };

  const pending = mutation.isPending;
  const trimmed = name.trim();
  const agreeing = warned !== null && warned === trimmed;
  const contactsChanged = !base || contactsPayload(drafts) !== baseContacts;
  const gone = drafts.some((d) => methodIsGone(d, methods));
  // A save that carries contacts may not drop an order's contact silently, nor name a
  // method the reference no longer has.
  const blocked = drafts.some(isBlankLinked) || (contactsChanged && gone);

  const changedFields = (): CustomerUpdate => {
    if (!base) return {};
    const data: CustomerUpdate = {};
    if (trimmed !== base.name) data.name = trimmed;
    if (kind !== base.kind) data.kind = kind;
    // Untouched is unchanged — a stored note with spaces around it is not a change.
    if (notes !== (base.notes ?? '') && cleanNotes(notes) !== (base.notes ?? null)) data.notes = cleanNotes(notes);
    if (contactsChanged) data.contacts = draftsToInput(drafts);
    return data;
  };

  function submit() {
    if (sent.current || pending || blocked) return;
    if (trimmed === '') {
      setLocalError(t('customers.modal.nameRequired'));
      document.getElementById(ids.name)?.focus();
      return;
    }
    setLocalError(null);
    let data: CustomerCreate | CustomerUpdate;
    if (base) {
      data = changedFields();
      if (Object.keys(data).length === 0) {
        onClose();
        return;
      }
    } else {
      data = { name: trimmed, kind, notes: cleanNotes(notes), contacts: draftsToInput(drafts) };
    }
    if (agreeing) data = { ...data, allow_duplicate_name: true };
    sent.current = true;
    mutation.mutate(data);
  }

  const onName = (value: string) => {
    setName(value);
    setLocalError(null);
    // A changed name is a new question: the agreement and its refusal go (R01).
    if (warned !== null && value.trim() !== warned) {
      setWarned(null);
      mutation.reset();
    }
  };

  const serverError = mutation.isError ? (mutation.error as Error).message : undefined;
  // The namesake question goes only under the namesake refusal — never under another one
  // that an agreed save ran into.
  const namesakeRefusal = mutation.error instanceof ApiError && mutation.error.code === 'name_taken';
  const error =
    localError ??
    (serverError !== undefined && agreeing && namesakeRefusal ? (
      <>
        {serverError}
        <br />
        {t('customers.modal.namesakeQuestion')}
      </>
    ) : (
      serverError
    ));

  return (
    <WorkshopDialog
      onClose={close}
      title={base ? t('customers.modal.editTitle') : t('customers.modal.createTitle')}
      subtitle={base ? base.code : undefined}
      size="lg"
      pending={pending}
      error={error}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button id={submitId} type="submit" form={ids.form} disabled={pending || blocked}>
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            {pending ? t('customers.modal.saving') : agreeing ? t('customers.modal.saveAnyway') : t('customers.modal.save')}
          </Button>
        </>
      }
    >
      {/* `noValidate`: every check this form has is said in the dialog's slot. */}
      <form
        id={ids.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <WorkshopFormGrid>
          <WorkshopField label={t('customers.modal.name')} htmlFor={ids.name} full>
            <input
              id={ids.name}
              type="text"
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => onName(e.target.value)}
              aria-invalid={localError !== null || undefined}
              className={FIELD_CLASS}
              disabled={pending}
            />
          </WorkshopField>
          <WorkshopField label={t('customers.modal.kind')} htmlFor={ids.kind}>
            <Select
              id={ids.kind}
              className="w-full"
              value={kind}
              onChange={(e) => setKind(e.target.value as CustomerKind)}
              disabled={pending}
            >
              {CUSTOMER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`customers.kind.${k}`)}
                </option>
              ))}
            </Select>
          </WorkshopField>
          <div className="col-span-full">
            <ContactRowsEditor
              drafts={drafts}
              onChange={setDrafts}
              disabled={pending}
              canManageMethods={hasPermission('projects:update')}
            />
          </div>
          <WorkshopField label={t('customers.modal.notes')} htmlFor={ids.notes} full>
            <textarea
              id={ids.notes}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={`${FIELD_CLASS} resize-y`}
              disabled={pending}
            />
          </WorkshopField>
        </WorkshopFormGrid>
      </form>
    </WorkshopDialog>
  );
}
