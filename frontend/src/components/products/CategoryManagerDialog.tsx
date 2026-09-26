import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import type { ProductCategory } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { Button } from '../Button';
import { ConfirmModal } from '../ConfirmModal';
import { Modal } from '../Modal';

const FIELD_CLASS =
  'w-full px-3 py-1.5 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none';

/**
 * Edit the product category directory (spec workshop-product-catalog, rule 20).
 *
 * A rename is one row — every product shows the new name. Deleting leaves the
 * category's products uncategorized, and the confirmation says how many.
 */
export function CategoryManagerDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { data: categories = [] } = useQuery({
    queryKey: ['product-categories'],
    queryFn: () => api.getProductCategories(),
  });
  const [draft, setDraft] = useState('');
  const [deleting, setDeleting] = useState<ProductCategory | null>(null);
  // A name being typed, by category id. A field with no entry shows the name
  // the server holds — so a blanked or refused rename falls back to it by itself.
  const [names, setNames] = useState<Record<number, string>>({});
  const forget = (id: number) =>
    setNames((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  // The list rows and an open product page read the category by join; the
  // panel's counts ride the list response.
  const refresh = () =>
    Promise.all(
      [['product-categories'], ['products'], ['product'], ['product-facets']].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
  const onError = (e: Error) => showToast(e.message, 'error');

  const create = useMutation({
    mutationFn: (name: string) => api.createProductCategory(name),
    onSuccess: () => {
      setDraft('');
      refresh();
    },
    onError,
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => api.renameProductCategory(id, name),
    // Held until the list has the new name, or the field would flash the old one.
    onSuccess: async (_saved, { id }) => {
      await refresh();
      forget(id);
    },
    onError: (e: Error, { id }) => {
      forget(id);
      onError(e);
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteProductCategory(id),
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
    onError,
  });

  const commitName = (category: ProductCategory) => {
    const typed = names[category.id];
    if (typed === undefined) return;
    const name = typed.trim();
    if (!name || name === category.name) forget(category.id);
    else rename.mutate({ id: category.id, name });
  };

  return (
    <Modal onClose={onClose} title={t('products.categories.title')} size="md">
      <div className="p-4 space-y-3">
        {categories.length === 0 && <p className="text-sm text-bambu-gray">{t('products.categories.empty')}</p>}
        <ul className="space-y-2">
          {categories.map((category) => (
            <li key={category.id} className="flex items-center gap-2">
              <input
                value={names[category.id] ?? category.name}
                onChange={(e) => {
                  const value = e.target.value;
                  setNames((prev) => ({ ...prev, [category.id]: value }));
                }}
                aria-label={t('products.categories.name')}
                className={FIELD_CLASS}
                onBlur={() => commitName(category)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
              <span className="text-xs text-bambu-gray tabular-nums w-8 text-right">{category.products_count}</span>
              <button
                type="button"
                aria-label={t('products.categories.delete', { name: category.name })}
                onClick={() => setDeleting(category)}
                className="p-1 text-bambu-gray hover:text-red-400"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (draft.trim()) create.mutate(draft.trim());
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={t('products.categories.new')}
            className={FIELD_CLASS}
          />
          <Button type="submit" disabled={!draft.trim() || create.isPending}>
            <Plus className="w-4 h-4" />
            {t('products.categories.add')}
          </Button>
        </form>
      </div>
      {deleting && (
        <ConfirmModal
          title={t('products.categories.deleteTitle')}
          message={t('products.categories.deleteBody', { count: deleting.products_count })}
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </Modal>
  );
}
