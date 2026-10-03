import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { api } from '../../api/client';
import type { ProductCategory } from '../../api/client';
import { useInnerEscape } from '../../hooks/useInnerEscape';
import { invalidateProductCatalog } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { ActionConfirm } from '../workshop/ActionConfirm';
import { LoadFailedNote } from '../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../workshop/RefreshFailedNote';
import { WorkshopDialog } from '../workshop/WorkshopDialog';

const FIELD_CLASS =
  'min-w-0 flex-1 px-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none aria-[invalid=true]:border-red-500';
const NAME_MAX = 128;

/**
 * The product category directory (WS-13 E10 H01–H05, F19a).
 *
 * ⚠️ **A directory, not a form (H05).** Every create, rename and delete is written
 * at once by its own button; a row's «Cancel» (or Escape in its field) undoes only
 * that row's unsaved name, and closing the manager undoes nothing already done — the
 * one exception to «nothing is written before the primary button».
 *
 * A rename is explicit — the row's field, Enter or «Save» — never on losing focus; the
 * id is kept, so every product shows the new name. A delete is confirmed with the number
 * of products it leaves uncategorized; the server never refuses one. Refusals stay
 * under their row; nothing is a toast.
 */
export function CategoryManagerDialog({
  onClose,
  onDeleted,
}: {
  onClose: () => void;
  /** Told which category went, so a page filtered by it can drop the filter. */
  onDeleted?: (id: number) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const uid = useId();
  const renameButtonId = (id: number) => `${uid}-rename-${id}`;
  const fieldId = `${uid}-field`;
  const rowErrorId = `${uid}-row-error`;
  const addErrorId = `${uid}-add-error`;

  const list = useQuery({ queryKey: ['product-categories'], queryFn: () => api.getProductCategories() });
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ProductCategory | null>(null);
  const editRow = useRef<HTMLFormElement>(null);
  // Where the focus goes when a row stops being edited: back to its «Rename».
  const returnTo = useRef<number | null>(null);

  // What a category change moves: the catalog (its rows, filters, counts) and an open product.
  const refresh = () => {
    invalidateProductCatalog(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['product'] });
  };

  // ⚠️ Synchronous: one press, one request; nothing closes the manager under one.
  const renaming = useRef(false);
  const adding = useRef(false);
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.renameProductCategory(id, name),
    onSuccess: (_saved, { id }) => {
      renaming.current = false;
      returnTo.current = id;
      setEditing(null);
      setRowError(null);
      refresh();
    },
    onError: (e: Error) => {
      renaming.current = false;
      setRowError(e.message);
    },
  });
  const create = useMutation({
    mutationFn: (name: string) => api.createProductCategory(name),
    onSuccess: () => {
      adding.current = false;
      setDraft('');
      setAddError(null);
      refresh();
    },
    onError: (e: Error) => {
      adding.current = false;
      setAddError(e.message);
    },
  });
  const pending = rename.isPending || create.isPending;

  const startEdit = (category: ProductCategory) => {
    setRowError(null);
    setEditing({ id: category.id, value: category.name });
  };
  const cancelEdit = () => {
    if (renaming.current || !editing) return;
    returnTo.current = editing.id;
    setEditing(null);
    setRowError(null);
  };
  // Escape in the row's field undoes the row and stops there; the next one closes the manager (H02).
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
    const current = list.data?.find((c) => c.id === editing.id);
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

  const close = () => {
    if (renaming.current || adding.current) return;
    onClose();
  };

  const categories = list.data ?? [];
  let rows;
  if (!list.data && list.isError) {
    rows = <LoadFailedNote message={t('products.categories.loadFailed')} onRetry={() => list.refetch()} />;
  } else if (!list.data) {
    rows = (
      <div role="status" aria-busy className="space-y-2">
        <span className="sr-only">{t('common.loading')}</span>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-9 rounded-lg bg-bambu-dark-tertiary/60 animate-pulse" />
        ))}
      </div>
    );
  } else if (categories.length === 0) {
    rows = <p className="text-sm text-bambu-gray">{t('products.categories.empty')}</p>;
  } else {
    rows = (
      <ul className="divide-y divide-bambu-dark-tertiary">
        {categories.map((category) => (
          <li key={category.id} data-testid={`category-row-${category.name}`}>
            {editing?.id === category.id ? (
              <form
                ref={editRow}
                className="flex flex-wrap items-center gap-2 py-2"
                onSubmit={(e) => {
                  e.preventDefault();
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
                    setEditing({ id: category.id, value: e.target.value });
                    setRowError(null);
                  }}
                  aria-label={t('products.categories.name')}
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
              <div className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-white">{category.name}</span>
                <small className="shrink-0 text-xs text-bambu-gray tabular-nums">
                  {t('products.categories.products', { count: category.products_count })}
                </small>
                <Button
                  id={renameButtonId(category.id)}
                  variant="ghost"
                  size="sm"
                  onClick={() => startEdit(category)}
                  disabled={pending}
                  aria-label={t('products.categories.rename', { name: category.name })}
                >
                  {t('common.rename')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleting(category)}
                  disabled={pending}
                  aria-label={t('products.categories.delete', { name: category.name })}
                >
                  {t('common.delete')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      <WorkshopDialog size="md" onClose={close} title={t('products.categories.title')} pending={pending}>
        <div className="space-y-3">
          {list.data && list.isError && <RefreshFailedNote onRetry={() => void list.refetch()} />}
          {rows}
          <form
            className="space-y-1"
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              add();
            }}
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draft}
                maxLength={NAME_MAX}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setAddError(null);
                }}
                aria-label={t('products.categories.new')}
                placeholder={t('products.categories.new')}
                aria-invalid={addError !== null || undefined}
                aria-describedby={addError ? addErrorId : undefined}
                className={FIELD_CLASS}
                disabled={create.isPending}
              />
              <Button type="submit" size="sm" disabled={!draft.trim() || create.isPending}>
                <Plus className="w-4 h-4" />
                {t('common.add')}
              </Button>
            </div>
            {addError && (
              <p id={addErrorId} className="text-xs text-red-600 dark:text-red-400">
                {addError}
              </p>
            )}
          </form>
        </div>
      </WorkshopDialog>

      {deleting && (
        <ActionConfirm
          title={t('products.categories.deleteTitle', { name: deleting.name })}
          body={t('products.categories.deleteBody', { count: deleting.products_count })}
          primaryLabel={t('common.delete')}
          danger
          send={async () => {
            await api.deleteProductCategory(deleting.id);
            onDeleted?.(deleting.id);
            refresh();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
