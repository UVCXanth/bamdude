import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { api } from '../../api/client';
import type { DeliveryMethod } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useDeliveryMethods } from '../../hooks/useDeliveryMethods';
import { useInnerEscape } from '../../hooks/useInnerEscape';
import { Button } from '../Button';
import { ActionConfirm } from '../workshop/ActionConfirm';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { WorkshopDialog } from '../workshop/WorkshopDialog';

const FIELD_CLASS =
  'min-w-0 flex-1 px-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none aria-[invalid=true]:border-red-500';
const ICON_BUTTON = 'p-1 text-bambu-gray hover:text-white disabled:opacity-30';
// `delivery_methods.name` is 255 characters (schemas/delivery_method.py).
const NAME_MAX = 255;

/**
 * The delivery reference (WS-13 E11 G, F21; spec workshop-customers, rule 20) — opened from
 * a contact row, above the customer form.
 *
 * ⚠️ **A directory, not a form (G06, as the category manager — E10 K23).** Every add,
 * rename, move and delete is written at once by its own button; «Done» closes and undoes
 * nothing already done. A rename is explicit — the row's field, Enter or «Save», never on
 * losing focus; Escape or «Cancel» undo the row only, and the next Escape closes the
 * reference. A method contacts use cannot be deleted — the reason is on screen and
 * describes the button (the server answers 409 too); a free one is confirmed first.
 * Refusals stay where they happened; nothing is a toast. Every writer here takes
 * `projects:update` (G07) — without it the reference is read only.
 */
export function DeliveryMethodsModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('projects:update');
  const list = useDeliveryMethods();
  const uid = useId();
  const renameButtonId = (id: number) => `${uid}-rename-${id}`;
  const fieldId = `${uid}-field`;
  const addFieldId = `${uid}-add`;
  const rowErrorId = `${uid}-row-error`;
  const addErrorId = `${uid}-add-error`;

  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DeliveryMethod | null>(null);
  const editRow = useRef<HTMLFormElement>(null);
  // Where the focus goes when a row stops being edited: back to its «Rename».
  const returnTo = useRef<number | null>(null);
  // A delete takes its row — and the confirmation's opener — away: the focus goes to the add field.
  const deleted = useRef(false);

  // Contacts read a method's name through the join: the lists AND an open customer page
  // (`['customer', id]`) show it.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['delivery-methods'] }),
      queryClient.invalidateQueries({ queryKey: ['customers'] }),
      queryClient.invalidateQueries({ queryKey: ['customer'] }),
    ]);

  // ⚠️ Synchronous: one press, one request; nothing closes the reference under one.
  const renaming = useRef(false);
  const adding = useRef(false);
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.renameDeliveryMethod(id, name),
    onSuccess: async (_saved, { id }) => {
      // Held until the list has the new name, or the row would flash the old one.
      await refresh();
      renaming.current = false;
      returnTo.current = id;
      setEditing(null);
      setRowError(null);
    },
    onError: (e: Error) => {
      renaming.current = false;
      setRowError(e.message);
    },
  });
  const create = useMutation({
    mutationFn: (name: string) => api.createDeliveryMethod(name),
    onSuccess: (created) => {
      adding.current = false;
      setDraft('');
      setAddError(null);
      // Offered at once in every select (F07) — whatever the re-read below answers.
      queryClient.setQueryData<DeliveryMethod[]>(['delivery-methods'], (old) =>
        old && !old.some((m) => m.id === created.id) ? [...old, created] : old,
      );
      void refresh();
    },
    onError: (e: Error) => {
      adding.current = false;
      setAddError(e.message);
    },
  });
  const reorder = useMutation({
    mutationFn: (ids: number[]) => api.reorderDeliveryMethods(ids),
    // Pending until the list has the new order: the next move is computed from that list,
    // and one computed from the old order would undo this one.
    onSuccess: () => refresh(),
  });
  const pending = rename.isPending || create.isPending || reorder.isPending;

  // After a refusal the field is live again and takes the focus back to fix the name.
  useEffect(() => {
    if (rename.isError) document.getElementById(fieldId)?.focus();
  }, [rename.isError, rename.error, fieldId]);
  useEffect(() => {
    if (create.isError) document.getElementById(addFieldId)?.focus();
  }, [create.isError, create.error, addFieldId]);

  const startEdit = (method: DeliveryMethod) => {
    setRowError(null);
    setEditing({ id: method.id, value: method.name });
  };
  const cancelEdit = () => {
    if (renaming.current || !editing) return;
    returnTo.current = editing.id;
    setEditing(null);
    setRowError(null);
  };
  // Escape in the row's field undoes the row and stops there; the next one closes the reference.
  useInnerEscape(editRow, editing !== null && !rename.isPending, cancelEdit);

  useEffect(() => {
    if (editing) {
      document.getElementById(fieldId)?.focus();
    } else if (returnTo.current != null) {
      document.getElementById(renameButtonId(returnTo.current))?.focus();
      returnTo.current = null;
    }
    // Only when a row starts or stops being edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  const save = () => {
    if (!editing || renaming.current) return;
    const name = editing.value.trim();
    const current = list.data?.find((m) => m.id === editing.id);
    if (name === '' || name === current?.name) {
      cancelEdit();
      return;
    }
    renaming.current = true;
    rename.mutate({ id: editing.id, name });
  };
  const add = () => {
    const name = draft.trim();
    if (adding.current || name === '') return;
    adding.current = true;
    create.mutate(name);
  };
  const move = (methods: DeliveryMethod[], index: number, by: -1 | 1) => {
    const ids = methods.map((m) => m.id);
    const target = index + by;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate(ids);
  };
  const close = () => {
    if (renaming.current || adding.current || reorder.isPending) return;
    onClose();
  };
  useEffect(() => {
    if (deleting === null && deleted.current) {
      deleted.current = false;
      document.getElementById(addFieldId)?.focus();
    }
  }, [deleting, addFieldId]);

  const methods = list.data ?? [];
  let rows;
  if (!list.data && list.isError) {
    rows = <LoadFailedNote message={t('customers.delivery.loadFailed')} onRetry={() => list.refetch()} />;
  } else if (!list.data) {
    rows = (
      <div role="status" aria-busy className="space-y-2">
        <span className="sr-only">{t('common.loading')}</span>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 rounded-lg bg-bambu-dark-tertiary/60 animate-pulse" />
        ))}
      </div>
    );
  } else if (methods.length === 0) {
    rows = <p className="text-sm text-bambu-gray">{t('customers.delivery.empty')}</p>;
  } else {
    rows = (
      <ul className="divide-y divide-bambu-dark-tertiary">
        {methods.map((method, index) => {
          const inUse = method.contacts_count > 0;
          const reasonId = `${uid}-in-use-${method.id}`;
          return (
            <li key={method.id} data-testid={`method-row-${method.name}`}>
              {editing?.id === method.id ? (
                <form
                  ref={editRow}
                  className="flex flex-wrap items-center gap-2 py-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    // ⚠️ This reference opens INSIDE the customer form: React delivers the
                    // submit along the component tree, so without this it saved the form too.
                    e.stopPropagation();
                    save();
                  }}
                >
                  <input
                    id={fieldId}
                    type="text"
                    value={editing.value}
                    maxLength={NAME_MAX}
                    onChange={(e) => {
                      setEditing({ id: method.id, value: e.target.value });
                      setRowError(null);
                    }}
                    aria-label={t('customers.delivery.name')}
                    aria-invalid={rowError !== null || undefined}
                    aria-describedby={rowError ? rowErrorId : undefined}
                    className={FIELD_CLASS}
                    disabled={rename.isPending}
                  />
                  <Button type="submit" size="sm" disabled={rename.isPending}>
                    {t('common.save')}
                    {rename.isPending && '…'}
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={cancelEdit} disabled={rename.isPending}>
                    {t('common.cancel')}
                  </Button>
                  {rowError && (
                    <p id={rowErrorId} className="w-full text-xs text-red-600 dark:text-red-400">
                      {rowError}
                    </p>
                  )}
                </form>
              ) : (
                <div className="py-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 break-words text-sm text-white">{method.name}</span>
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          aria-label={t('customers.delivery.moveUp', { name: method.name })}
                          disabled={index === 0 || pending}
                          onClick={() => move(methods, index, -1)}
                          className={ICON_BUTTON}
                        >
                          <ArrowUp className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          aria-label={t('customers.delivery.moveDown', { name: method.name })}
                          disabled={index === methods.length - 1 || pending}
                          onClick={() => move(methods, index, 1)}
                          className={ICON_BUTTON}
                        >
                          <ArrowDown className="w-4 h-4" />
                        </button>
                        <Button
                          id={renameButtonId(method.id)}
                          variant="ghost"
                          size="sm"
                          onClick={() => startEdit(method)}
                          disabled={pending}
                          aria-label={t('customers.delivery.rename', { name: method.name })}
                        >
                          {t('common.rename')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleting(method)}
                          disabled={inUse || pending}
                          aria-label={t('customers.delivery.delete', { name: method.name })}
                          aria-describedby={inUse ? reasonId : undefined}
                        >
                          {t('common.delete')}
                        </Button>
                      </>
                    )}
                  </div>
                  {/* Why it cannot go — on screen, not only in a title (E10-M8). */}
                  {inUse && (
                    <p id={reasonId} className="mt-0.5 text-xs text-bambu-gray">
                      {t('customers.delivery.inUse', { count: method.contacts_count })}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      <WorkshopDialog
        size="md"
        onClose={close}
        title={t('customers.delivery.manageTitle')}
        subtitle={t('customers.delivery.subtitle')}
        pending={rename.isPending || create.isPending || reorder.isPending}
        footer={
          <Button type="button" onClick={close} disabled={rename.isPending || create.isPending || reorder.isPending}>
            {t('customers.delivery.done')}
          </Button>
        }
      >
        <div className="space-y-3">
          {list.data && list.isError && <RefreshFailedNote onRetry={() => void list.refetch()} />}
          {/* A refused move is said where it was asked for — never silently (the list shows
              the server's order on its next read). */}
          {reorder.isError && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {(reorder.error as Error).message}
            </p>
          )}
          {rows}
          {canEdit && (
            <form
              className="space-y-1"
              onSubmit={(e) => {
                e.preventDefault();
                // ⚠️ See the rename's form: never the customer form's submit too.
                e.stopPropagation();
                add();
              }}
            >
              <div className="flex items-center gap-2">
                <input
                  id={addFieldId}
                  type="text"
                  value={draft}
                  maxLength={NAME_MAX}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setAddError(null);
                  }}
                  aria-label={t('customers.delivery.new')}
                  placeholder={t('customers.delivery.new')}
                  aria-invalid={addError !== null || undefined}
                  aria-describedby={addError ? addErrorId : undefined}
                  className={FIELD_CLASS}
                  disabled={create.isPending}
                />
                <Button type="submit" size="sm" disabled={!draft.trim() || create.isPending}>
                  <Plus className="w-4 h-4" />
                  {t('customers.delivery.add')}
                </Button>
              </div>
              {addError && (
                <p id={addErrorId} className="text-xs text-red-600 dark:text-red-400">
                  {addError}
                </p>
              )}
            </form>
          )}
        </div>
      </WorkshopDialog>

      {deleting && (
        <ActionConfirm
          title={t('customers.delivery.deleteTitle', { name: deleting.name })}
          body={t('customers.delivery.deleteBody')}
          primaryLabel={t('common.delete')}
          danger
          send={async () => {
            await api.deleteDeliveryMethod(deleting.id);
            await refresh();
            deleted.current = true;
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
