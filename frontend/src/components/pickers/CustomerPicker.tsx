import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { api, ApiError } from '../../api/client';
import type { CustomerOption } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { Select } from '../Select';
import { LoadFailedNote } from '../workshop/LoadFailedNote';

const FIELD_CLASS =
  'w-full px-3 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white focus:border-bambu-green focus:outline-none';
/** Sentinel `<option>` value that swaps the select for the inline create form. */
const NEW_CUSTOMER = '__new__';

interface CustomerPickerProps {
  value: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
  allowCreate?: boolean;
  /** For a `<label htmlFor>` outside the picker. */
  id?: string;
}

type Choosing = 'idle' | 'reading' | 'gone' | 'failed';

/** `<select>` over customers, with a "new customer…" option that swaps to an
 *  inline name field + create button rather than opening a separate modal.
 *
 *  A name another customer already has is a warning (WS-13 E11 F12, A01, R01): the
 *  server's sentence and two answers — «Choose it» (the namesake, once a FRESH read of the
 *  list shows it, past the app's minute of staleTime) or «Create another» (the same name,
 *  knowingly). The warning belongs to the name it answered: changing the name takes it
 *  away. While its request runs the field, Create, × and Escape do nothing, decided in the
 *  same frame (`sent`), so a late answer never changes a choice that was given up — and a
 *  read for «Choose it» counts only for the question it was asked for: ×, Escape or another
 *  name give it up (`generation`), and nothing creates while it runs (`reading`).
 *
 *  ⚠️ Busy controls are `aria-disabled`, not `disabled`: a disabled button drops the focus
 *  to <body>, where the next Escape reaches the modal stack and closes the order form this
 *  picker lives in, draft and all. The guards are the refs; Escape stops at the picker. */
export function CustomerPicker({ value, onChange, disabled, allowCreate, id }: CustomerPickerProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [warned, setWarned] = useState<{ name: string; message: string; namesake: number | null } | null>(null);
  const [choosing, setChoosing] = useState<Choosing>('idle');
  // Customers this picker created — offered even when the list was never read (Codex E11-V03).
  const [created, setCreated] = useState<CustomerOption[]>([]);
  const sent = useRef(false);
  const reading = useRef(false);
  const generation = useRef(0);
  const nameNow = useRef(name);
  nameNow.current = name;

  // The option list, not the directory (WS-13 E13 R12): naming a customer is not reading its contacts.
  const customersQuery = useQuery({ queryKey: ['customer-options'], queryFn: api.getCustomerOptions });
  const read = customersQuery.data;
  // A current answer is the whole list; otherwise what is known — the last answer plus what
  // this picker created — and the failed read says so with its retry.
  const current = customersQuery.status === 'success' && !customersQuery.isFetching;
  const customers = current
    ? (read ?? [])
    : [...(read ?? []), ...created.filter((c) => !read?.some((r) => r.id === c.id))];

  const leave = () => {
    generation.current += 1;
    reading.current = false;
    setCreating(false);
    setName('');
    setWarned(null);
    setChoosing('idle');
  };

  const createMutation = useMutation({
    mutationFn: ({ customerName, knowingly }: { customerName: string; knowingly: boolean }) =>
      api.createCustomer(knowingly ? { name: customerName, allow_duplicate_name: true } : { name: customerName }),
    onSuccess: (made) => {
      sent.current = false;
      // The select shows the new customer at once — not «no customer» until (or unless)
      // the list is read again — and without calling a list of one the whole list.
      const option: CustomerOption = { id: made.id, code: made.code, name: made.name };
      setCreated((known) => (known.some((c) => c.id === made.id) ? known : [...known, option]));
      queryClient.setQueryData<CustomerOption[]>(['customer-options'], (old) =>
        old && !old.some((c) => c.id === made.id) ? [...old, option] : old,
      );
      queryClient.invalidateQueries({ queryKey: ['customer-options'] });
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      onChange(made.id);
      leave();
    },
    onError: (e: Error, { customerName }) => {
      sent.current = false;
      if (e instanceof ApiError && e.code === 'name_taken') {
        // Only for the name still in the field; a stale answer is not shown.
        if (customerName === nameNow.current.trim()) {
          setWarned({ name: customerName, message: e.message, namesake: e.refs?.customer ?? null });
          setChoosing('idle');
        }
        return;
      }
      showToast(e.message, 'error');
    },
  });
  const pending = createMutation.isPending;
  const busy = pending || choosing === 'reading';

  const send = (knowingly: boolean) => {
    const customerName = name.trim();
    if (sent.current || reading.current || !customerName) return;
    sent.current = true;
    createMutation.mutate({ customerName, knowingly });
  };

  const cancelCreate = () => {
    if (sent.current) return;
    leave();
  };

  /** The namesake, once a fresh read of the list shows it — never a hidden id in a select. */
  const chooseIt = async () => {
    const namesake = warned?.namesake;
    if (namesake == null || reading.current || sent.current) return;
    const asked = generation.current;
    reading.current = true;
    setChoosing('reading');
    try {
      const list = await queryClient.fetchQuery({
        queryKey: ['customer-options'],
        queryFn: api.getCustomerOptions,
        // ⚠️ The app keeps every query fresh for a minute: a default fetch would answer
        // from the cache that does not know the namesake (Codex E11 r2 note 1).
        staleTime: 0,
        retry: false,
      });
      // Given up while it was read (×, Escape, another name): it answers nothing.
      if (asked !== generation.current) return;
      if (list.some((c) => c.id === namesake)) {
        onChange(namesake);
        leave();
      } else {
        setChoosing('gone');
      }
    } catch {
      if (asked === generation.current) setChoosing('failed');
    } finally {
      if (asked === generation.current) reading.current = false;
    }
  };

  if (creating) {
    return (
      // ⚠️ `stopPropagation` is the point: the modals this picker lives in close themselves
      // on a `window` keydown, so an unguarded Escape here — in the field or on one of its
      // buttons — would throw away the whole order the user was editing instead of
      // stepping back out of the create field.
      <div
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          cancelCreate();
        }}
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => {
              if (sent.current) return;
              setName(e.target.value);
              // A changed name is a new question: the warning was about another one, and a
              // read for it answers nothing now.
              if (warned && e.target.value.trim() !== warned.name) {
                generation.current += 1;
                reading.current = false;
                setWarned(null);
                setChoosing('idle');
              }
            }}
            placeholder={t('pickers.newCustomerName')}
            className={FIELD_CLASS}
            disabled={disabled}
            readOnly={pending}
            autoFocus
          />
          <button
            type="button"
            onClick={() => send(false)}
            disabled={disabled || !name.trim()}
            aria-disabled={busy || undefined}
            className="px-3 py-2 rounded-lg text-sm bg-bambu-green/20 text-bambu-green hover:bg-bambu-green/30 transition-colors whitespace-nowrap aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
          >
            {t('pickers.create')}
          </button>
          {/* Picking "new customer…" by accident used to be a one-way door: the
              select was gone and only creating a customer brought it back. */}
          <button
            type="button"
            onClick={cancelCreate}
            aria-disabled={pending || undefined}
            aria-label={t('pickers.cancelCreate')}
            title={t('pickers.cancelCreate')}
            className="px-2 py-2 rounded-lg text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary transition-colors aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {warned && (
          <div className="mt-1.5 space-y-1.5 text-xs">
            <p className="text-status-warning">{warned.message}</p>
            {choosing === 'gone' && <p className="text-bambu-gray">{t('pickers.namesakeGone')}</p>}
            {choosing === 'failed' && (
              <LoadFailedNote message={t('pickers.namesakeReadFailed')} onRetry={() => void chooseIt()} />
            )}
            <div className="flex flex-wrap gap-2">
              {choosing !== 'gone' && warned.namesake != null && (
                <button
                  type="button"
                  onClick={() => void chooseIt()}
                  disabled={disabled}
                  aria-disabled={busy || undefined}
                  className="px-2.5 py-1 rounded-lg bg-bambu-dark-tertiary text-white hover:bg-bambu-dark disabled:opacity-50 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
                >
                  {t('pickers.namesakeChoose')}
                </button>
              )}
              <button
                type="button"
                onClick={() => send(true)}
                disabled={disabled}
                aria-disabled={busy || undefined}
                className="px-2.5 py-1 rounded-lg bg-bambu-green/20 text-bambu-green hover:bg-bambu-green/30 disabled:opacity-50 aria-disabled:opacity-50 aria-disabled:cursor-not-allowed"
              >
                {t('pickers.namesakeCreate')}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <Select
        id={id}
        className="w-full"
        value={value ?? ''}
        onChange={(e) => {
          if (e.target.value === NEW_CUSTOMER) {
            setCreating(true);
            return;
          }
          onChange(e.target.value ? Number(e.target.value) : null);
        }}
        disabled={disabled}
      >
        <option value="">{t('pickers.noCustomer')}</option>
        {customers.map((c) => (
          <option key={c.id} value={c.id}>
            {`${c.code} · ${c.name}`}
          </option>
        ))}
        {allowCreate && <option value={NEW_CUSTOMER}>{t('pickers.newCustomer')}</option>}
      </Select>
      {/* A list that could not be read is not an empty one. */}
      {customersQuery.isError && !read && (
        <LoadFailedNote
          className="mt-1.5 text-xs"
          message={t('pickers.customersReadFailed')}
          onRetry={() => void customersQuery.refetch()}
        />
      )}
    </div>
  );
}
