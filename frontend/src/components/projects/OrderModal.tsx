import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Ban, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { Order, OrderCreate, OrderUpdate, ProjectPriority, ProjectStatus } from '../../api/client';
import { Button } from '../Button';
import { WorkshopDialog } from '../workshop/WorkshopDialog';
import { WorkshopField, WorkshopFormGrid } from '../workshop/WorkshopFormGrid';
import { CustomerPicker } from '../pickers/CustomerPicker';
import { contactOption } from '../customers/contactFormat';
import { invalidateOrderViews } from '../../utils/queryInvalidation';
import { getCurrencySymbol } from '../../utils/currency';
import { getColorName } from '../../utils/colors';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useOrderDetail } from '../../hooks/useOrderDetail';
import { Select } from '../Select';
import { toOrderRef, type OrderRef } from './orderActions/orderRef';
import { useUiPreferences } from '../../hooks/useUiPreferences';

/** The mockup's nine card colours (WS-13 E6 C03), in its order. */
const ORDER_COLORS = ['#4eac48', '#5983b1', '#d0863c', '#b04a3f', '#858c55', '#8a8a8a', '#9a6fb0', '#3fa7a0', '#c9a23f'];

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none';

/**
 * The price field as a number, or `fallback` when it cannot be read as one.
 *
 * An empty field means "no price" and is a real `null`; anything else that
 * `Number()` cannot parse keeps whatever was there before, because `NaN`
 * serialises to `null` and would clear a price nobody meant to clear.
 *
 * ⚠️ **That middle case cannot be typed.** The field is `type="number"`, and a
 * browser reports an entry it cannot parse as the EMPTY STRING, never as the
 * characters on screen — so `12,50` in a comma-decimal locale arrives here as
 * `''`, which is a real null and does clear the price. The operator sees an
 * empty field and the answer matches it. The `fallback` is for a value that
 * never came through that input: autofill, a paste read before the browser
 * normalises it, or the day this becomes a text field.
 */
function readPrice(raw: string, fallback: number | null): number | null {
  if (raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The status a form may move to from `from` (WS-13 E6 C06, R01): a closed order only reopens. */
function statusOffered(from: ProjectStatus, to: ProjectStatus): boolean {
  return from === 'active' || to === from || to === 'active';
}

interface OrderModalProps {
  /** The full order (the detail hands it over), or null for a new order. */
  order?: Order | null;
  /** An order opened from a list: the form reads the full one by id (C07). */
  orderId?: number;
  defaultCustomerId?: number | null;
  onClose: () => void;
  /** The status chosen in the form, run AFTER the fields are saved — never sent as a field (C06). */
  onStatusAction?: (ref: OrderRef, next: ProjectStatus) => void;
}

/**
 * Create / edit an order (WS-13 E6 §C). Line editing lives on the order page, not
 * here — this form only ever touches the order's own fields.
 *
 * ⚠️ **One session, one base (C07, R03).** An order opened from a list is read in
 * full first; the FIRST usable answer becomes the session's base and its initial
 * draft, once. A background refetch of the same order changes neither — what was
 * typed stays, and the PATCH carries only what differs from that base.
 *
 * ⚠️ **The status is not a field (C06, R01).** «Save» sends the changed fields;
 * a different status then goes to the order action model (`onStatusAction`) — F06
 * for «completed», a confirmation for «cancelled» and for reopening — with the
 * order as the PATCH returned it. No door writes `completed`.
 */
export function OrderModal({ order, orderId, defaultCustomerId, onClose, onStatusAction }: OrderModalProps) {
  const { t } = useTranslation();
  const editing = order != null || orderId != null;
  const read = useOrderDetail(order ? null : (orderId ?? null));
  // The session's base: handed over, or the first usable read — taken once, while rendering.
  const [base, setBase] = useState<Order | null>(order ?? null);
  if (base == null && read.data) setBase(read.data);

  if (editing && base == null) {
    return (
      <WorkshopDialog
        onClose={onClose}
        title={t('orders.modal.editTitle')}
        size="lg"
        footer={
          <>
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="button" disabled>
              {t('orders.modal.save')}
            </Button>
          </>
        }
      >
        {read.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-600 dark:text-red-500">
            <span>
              {t('orders.modal.loadFailed')} {(read.error as Error)?.message}
            </span>
            <Button variant="secondary" size="sm" onClick={() => void read.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : (
          <div role="status" aria-busy className="space-y-3">
            <span className="sr-only">{t('common.loading')}</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 rounded-lg bg-bambu-dark-tertiary/60 animate-pulse" />
            ))}
          </div>
        )}
      </WorkshopDialog>
    );
  }

  return (
    <OrderForm
      base={base}
      defaultCustomerId={defaultCustomerId ?? null}
      onClose={onClose}
      onStatusAction={onStatusAction}
    />
  );
}

function OrderForm({
  base,
  defaultCustomerId,
  onClose,
  onStatusAction,
}: {
  base: Order | null;
  defaultCustomerId: number | null;
  onClose: () => void;
  onStatusAction?: (ref: OrderRef, next: ProjectStatus) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { user, hasPermission } = useAuth();
  const { data: settings } = useUiPreferences();

  const { data: assignees = [] } = useQuery({ queryKey: ['order-assignees'], queryFn: api.getOrderAssignees });

  const isEdit = base != null;
  const ids = {
    name: useId(),
    customer: useId(),
    contact: useId(),
    responsible: useId(),
    due: useId(),
    priority: useId(),
    price: useId(),
    tags: useId(),
    color: useId(),
    description: useId(),
    url: useId(),
    status: useId(),
  };
  // The cursor starts in the name, as the mockup's dialogs start in their first field. The
  // Modal focuses its panel in its own (child) effect; this one runs after it.
  const nameId = ids.name;
  useEffect(() => {
    document.getElementById(nameId)?.focus();
  }, [nameId]);

  // `due_date` arrives as a datetime; `<input type="date">` takes only `YYYY-MM-DD` —
  // normalised once here, so the seeded value and the diff compare like with like.
  const initial = {
    name: base?.name ?? '',
    customerId: base ? (base.customer_id ?? null) : defaultCustomerId,
    contactId: base ? (base.contact_id ?? null) : null,
    responsibleId: base ? (base.responsible_id ?? null) : null,
    description: base?.description ?? '',
    color: base ? (base.color ?? null) : ORDER_COLORS[0],
    tags: base?.tags ?? null,
    dueDate: base?.due_date?.slice(0, 10) ?? null,
    priority: (base?.priority ?? 'normal') as ProjectPriority,
    price: base?.price ?? null,
    url: base?.url ?? '',
    status: (base?.status ?? 'active') as ProjectStatus,
  };

  const [name, setName] = useState(initial.name);
  const [customerId, setCustomerId] = useState<number | null>(initial.customerId);
  // `undefined` = «the main contact of whichever customer is chosen»; a number or
  // null is the operator's own pick. Choosing a customer resets it to the main one.
  const [contactChoice, setContactChoice] = useState<number | null | undefined>(base ? initial.contactId : undefined);
  // The chosen customer's contacts as the form picks one — name and role, never the
  // directory's phones and addresses (WS-13 E13 R12). An order's own contact the list does not
  // offer (gone since) stays chosen, by the name the order carries.
  const { data: contactOptions = [], isLoading: contactsLoading } = useQuery({
    queryKey: ['customer-contact-options', customerId],
    queryFn: () => api.getContactOptions(customerId as number),
    enabled: customerId != null,
  });
  const keptContact =
    base?.contact_id != null && customerId === base.customer_id && !contactOptions.some((c) => c.id === base.contact_id)
      ? { id: base.contact_id, code: base.contact?.code ?? '', name: base.contact?.name ?? null, role: base.contact?.role ?? null }
      : null;
  const contactsOf = keptContact ? [...contactOptions, keptContact] : contactOptions;
  const contactId = contactChoice === undefined ? (contactsOf[0]?.id ?? null) : contactChoice;
  // A new order is the signed-in user's unless another is chosen; `undefined` means «not
  // chosen yet», so the field never flashes «Not assigned» before `/auth/me` answers.
  const [responsibleChoice, setResponsibleChoice] = useState<number | null | undefined>(
    base ? initial.responsibleId : undefined,
  );
  const responsibleId = responsibleChoice === undefined ? (user?.id ?? null) : responsibleChoice;
  // A responsible user deactivated since stays a choice, under the name the order carries.
  const keepsGoneResponsible = base?.responsible_id != null && !assignees.some((u) => u.id === base.responsible_id);
  const [description, setDescription] = useState(initial.description);
  const [color, setColor] = useState<string | null>(initial.color);
  const [tags, setTags] = useState(initial.tags ?? '');
  const [dueDate, setDueDate] = useState(initial.dueDate ?? '');
  const [priority, setPriority] = useState<ProjectPriority>(initial.priority);
  const [price, setPrice] = useState(initial.price != null ? String(initial.price) : '');
  const [url, setUrl] = useState(initial.url);
  const [status, setStatus] = useState<ProjectStatus>(initial.status);

  // A colour from outside the palette is one more, chosen swatch — saving must not lose it.
  const swatches = [...ORDER_COLORS];
  if (initial.color && !ORDER_COLORS.includes(initial.color.toLowerCase())) swatches.push(initial.color);
  // A colour the catalogue does not hold gets a coarse family name, and two of the palette's
  // fall into one («Orange»): a name shared by several swatches carries the hex that differs.
  const swatchNames = swatches.map((hex) => getColorName(hex));
  const swatchLabel = (hex: string, index: number) =>
    swatchNames.filter((n) => n === swatchNames[index]).length > 1
      ? `${swatchNames[index]} (${hex.toUpperCase()})`
      : swatchNames[index];

  /** The fields that differ from the session's base — the status is not one of them. */
  function changedFields(): OrderUpdate {
    const data: OrderUpdate = {};
    if (name.trim() !== initial.name) data.name = name.trim();
    if (customerId !== initial.customerId) data.customer_id = customerId;
    if (contactId !== initial.contactId) data.contact_id = contactId;
    if (responsibleId !== initial.responsibleId) data.responsible_id = responsibleId;
    const normDescription = description.trim() === '' ? null : description.trim();
    if (normDescription !== (initial.description === '' ? null : initial.description)) data.description = normDescription;
    if (color !== initial.color) data.color = color;
    const normTags = tags.trim() === '' ? null : tags.trim();
    if (normTags !== initial.tags) data.tags = normTags;
    const normDueDate = dueDate === '' ? null : dueDate;
    if (normDueDate !== initial.dueDate) data.due_date = normDueDate;
    if (priority !== initial.priority) data.priority = priority;
    // An unparseable value counts as "no change" — see `readPrice`.
    const normPrice = readPrice(price, initial.price);
    if (normPrice !== initial.price) data.price = normPrice;
    const normUrl = url.trim() === '' ? null : url.trim();
    if (normUrl !== (initial.url === '' ? null : initial.url)) data.url = normUrl;
    return data;
  }

  const statusChange = isEdit && status !== initial.status ? status : null;

  /** After the fields: close, then hand the order as it now is to the status step (C06). */
  function finish(saved: Order) {
    onClose();
    if (statusChange) onStatusAction?.(toOrderRef(saved), statusChange);
  }

  const mutation = useMutation({
    mutationFn: (data: OrderUpdate | OrderCreate) =>
      base ? api.updateOrder(base.id, data as OrderUpdate) : api.createOrder(data as OrderCreate),
    onSuccess: (saved) => {
      // ⚠️ Prefixes throughout: an order can move between customers, so the customer
      // it LEFT is stale as well as the one it landed on.
      invalidateOrderViews(queryClient, { orderId: saved.id });
      if (base) {
        showToast(t('orders.toast.saved'));
        finish(saved);
        return;
      }
      showToast(t('orders.toast.created'));
      onClose();
      // The new order opens at once, from wherever it was made (C09, the mockup's `order-save`).
      navigate(`/projects/${saved.id}`);
    },
  });

  // A second press in the same tick sees `isPending` still false — the ref makes «one
  // press, one request» hold; a refusal re-arms it.
  const sent = useRef(false);
  const formId = useId();
  const submitId = `${formId}-submit`;
  // After a refusal the fields are live again: focus goes back to the button that sent
  // it, never to BODY (C08; the E2 finding).
  useEffect(() => {
    if (mutation.isError) {
      sent.current = false;
      document.getElementById(submitId)?.focus();
    }
  }, [mutation.isError, mutation.error, submitId]);

  // A customer just chosen takes its main contact — once its contacts have answered, or the
  // order would be sent with none while they are on the way.
  const contactPending = customerId != null && contactChoice === undefined && contactsLoading;
  const canSubmit = name.trim() !== '' && !mutation.isPending && !contactPending;

  function submit() {
    if (!canSubmit || sent.current) return;
    if (base) {
      const data = changedFields();
      if (Object.keys(data).length === 0) {
        // Nothing to save: the status step alone, with the order the form was opened on.
        finish(base);
        return;
      }
      sent.current = true;
      mutation.mutate(data);
      return;
    }
    sent.current = true;
    mutation.mutate({
      name: name.trim(),
      customer_id: customerId,
      contact_id: contactId,
      responsible_id: responsibleId,
      description: description.trim() === '' ? null : description.trim(),
      color,
      tags: tags.trim() === '' ? null : tags.trim(),
      due_date: dueDate === '' ? null : dueDate,
      priority,
      price: readPrice(price, null),
      url: url.trim() === '' ? null : url.trim(),
    });
  }

  const pending = mutation.isPending;
  const currency = getCurrencySymbol(settings?.currency || 'USD');

  return (
    <WorkshopDialog
      onClose={onClose}
      title={isEdit ? t('orders.modal.editTitle') : t('orders.modal.createTitle')}
      subtitle={isEdit ? base.code : t('orders.modal.createSubtitle')}
      size="lg"
      pending={pending}
      error={mutation.isError ? (mutation.error as Error).message : undefined}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button id={submitId} type="submit" form={formId} disabled={!canSubmit}>
            {pending && <Loader2 className="w-4 h-4 animate-spin" />}
            {pending
              ? isEdit
                ? t('orders.modal.saving')
                : t('orders.modal.creating')
              : isEdit
                ? t('orders.modal.save')
                : t('orders.modal.create')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <WorkshopFormGrid>
          <WorkshopField label={t('orders.modal.name')} htmlFor={ids.name} full>
            <input
              id={ids.name}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('orders.modal.namePlaceholder')}
              maxLength={255}
              className={FIELD_CLASS}
              disabled={pending}
              required
            />
          </WorkshopField>

          <WorkshopField label={t('orders.modal.customer')} htmlFor={ids.customer}>
            <CustomerPicker
              id={ids.customer}
              value={customerId}
              onChange={(id) => {
                setCustomerId(id);
                setContactChoice(undefined);
              }}
              disabled={pending}
              // A new customer is created by `POST /customers`, which asks `customers:create`
              // (WS-13 E13 G01) — an editor of orders without it is not offered one.
              allowCreate={hasPermission('customers:create')}
            />
          </WorkshopField>

          <WorkshopField label={t('orders.modal.responsible')} htmlFor={ids.responsible}>
            <Select
              id={ids.responsible}
              className="w-full"
              value={responsibleId ?? ''}
              disabled={pending}
              onChange={(e) => setResponsibleChoice(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">{t('orders.modal.noResponsible')}</option>
              {assignees.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
              {keepsGoneResponsible && base?.responsible_id != null && (
                <option value={base.responsible_id}>{base.responsible_name ?? `#${base.responsible_id}`}</option>
              )}
            </Select>
          </WorkshopField>

          {/* Under the customer, only once there is one (E08: the app's own addition). */}
          {customerId != null && (
            <>
              <WorkshopField label={t('orders.modal.contact')} htmlFor={ids.contact}>
                <Select
                  id={ids.contact}
                  className="w-full"
                  value={contactId ?? ''}
                  disabled={pending || contactsOf.length === 0}
                  onChange={(e) => setContactChoice(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">{t('orders.modal.noContact')}</option>
                  {contactsOf.map((c) => (
                    <option key={c.id} value={c.id}>
                      {contactOption(c)}
                    </option>
                  ))}
                </Select>
              </WorkshopField>
              <div aria-hidden className="max-[761px]:hidden" />
            </>
          )}

          <WorkshopField label={t('orders.modal.dueDate')} htmlFor={ids.due}>
            <input
              id={ids.due}
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className={FIELD_CLASS}
              disabled={pending}
            />
          </WorkshopField>

          <WorkshopField label={t('orders.modal.priority')} htmlFor={ids.priority}>
            <Select
              className="w-full"
              id={ids.priority}
              value={priority}
              onChange={(e) => setPriority(e.target.value as ProjectPriority)}
              disabled={pending}
            >
              {(['low', 'normal', 'high', 'urgent'] as const).map((p) => (
                <option key={p} value={p}>
                  {t(`orders.priority.${p}`)}
                </option>
              ))}
            </Select>
          </WorkshopField>

          <WorkshopField label={t('orders.modal.price', { currency })} htmlFor={ids.price}>
            <input
              id={ids.price}
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className={FIELD_CLASS}
              disabled={pending}
            />
          </WorkshopField>

          <WorkshopField label={t('orders.modal.tags')} htmlFor={ids.tags}>
            <input
              id={ids.tags}
              type="text"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder={t('orders.modal.tagsPlaceholder')}
              className={FIELD_CLASS}
              disabled={pending}
            />
          </WorkshopField>

          <div className="col-span-full flex min-w-0 flex-col gap-1">
            <label id={ids.color} className="text-sm text-bambu-gray-light">
              {t('orders.modal.color')}
            </label>
            <div role="radiogroup" aria-labelledby={ids.color} className="flex flex-wrap gap-2">
              <ColorSwatch
                value={null}
                checked={color === null}
                name={`${formId}-color`}
                label={t('orders.modal.noColor')}
                disabled={pending}
                onChoose={() => setColor(null)}
              />
              {swatches.map((hex, index) => (
                <ColorSwatch
                  key={hex}
                  value={hex}
                  checked={color?.toLowerCase() === hex.toLowerCase()}
                  name={`${formId}-color`}
                  label={swatchLabel(hex, index)}
                  disabled={pending}
                  onChoose={() => setColor(hex)}
                />
              ))}
            </div>
          </div>

          <WorkshopField label={t('orders.modal.description')} htmlFor={ids.description} full>
            <textarea
              id={ids.description}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={FIELD_CLASS}
              disabled={pending}
            />
          </WorkshopField>

          <WorkshopField label={t('orders.modal.url')} htmlFor={ids.url} full>
            <input
              id={ids.url}
              type="url"
              maxLength={2048}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('orders.modal.urlPlaceholder')}
              className={FIELD_CLASS}
              disabled={pending}
            />
          </WorkshopField>

          {isEdit && (
            <WorkshopField
              label={t('orders.modal.status')}
              htmlFor={ids.status}
              hint={
                statusChange
                  ? t('orders.modal.statusTwoSteps')
                  : initial.status !== 'active'
                    ? t('orders.modal.statusLocked')
                    : undefined
              }
            >
              <Select
                className="w-full"
                id={ids.status}
                value={status}
                aria-describedby={statusChange || initial.status !== 'active' ? `${ids.status}-hint` : undefined}
                onChange={(e) => setStatus(e.target.value as ProjectStatus)}
                disabled={pending}
              >
                {(['active', 'completed', 'cancelled'] as const).map((s) => (
                  <option key={s} value={s} disabled={!statusOffered(initial.status, s)}>
                    {t(`orders.status.${s}`)}
                  </option>
                ))}
              </Select>
            </WorkshopField>
          )}
        </WorkshopFormGrid>
      </form>
    </WorkshopDialog>
  );
}

/**
 * One swatch of the card colour (C03): a native radio — so the group is named, arrows
 * move the choice and the state is announced — visually hidden inside a 24×24 swatch
 * with a 2 px border; the chosen one gets the text-colour border and a ring.
 */
function ColorSwatch({
  value,
  checked,
  name,
  label,
  disabled,
  onChoose,
}: {
  value: string | null;
  checked: boolean;
  name: string;
  label: string;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <label title={label} className="relative inline-flex cursor-pointer">
      <input
        type="radio"
        name={name}
        value={value ?? ''}
        checked={checked}
        onChange={onChoose}
        disabled={disabled}
        aria-label={label}
        className="peer sr-only"
      />
      {/* The chosen frame is the theme's text colour (`text-white` follows the theme), so it
          shows on the light panel too — a white frame vanished there. */}
      <span
        aria-hidden
        className={`flex h-6 w-6 items-center justify-center rounded-md border-2 text-white peer-focus-visible:ring-2 peer-focus-visible:ring-bambu-green peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bambu-dark-secondary ${
          checked ? 'border-current ring-2 ring-current/40' : 'border-transparent'
        } ${value == null ? 'bg-bambu-dark' : ''}`}
        style={value != null ? { backgroundColor: value } : undefined}
      >
        {value == null && <Ban className="h-4 w-4 text-bambu-gray" />}
      </span>
    </label>
  );
}
