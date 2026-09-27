import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import type { Product, VariantGroup, VariantOption } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { invalidateOrderViews, invalidateProductCatalog } from '../../utils/queryInvalidation';
import { Button } from '../Button';
import { ConfirmModal } from '../ConfirmModal';

const FIELD_CLASS =
  'px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none disabled:opacity-60';
const ICON_BUTTON =
  'p-1.5 rounded-lg text-bambu-gray hover:text-red-400 hover:bg-bambu-dark transition-colors disabled:opacity-40 disabled:hover:text-bambu-gray disabled:hover:bg-transparent disabled:cursor-not-allowed';

type Deleting = { kind: 'group'; group: VariantGroup } | { kind: 'option'; group: VariantGroup; option: VariantOption };

/**
 * A product's variant groups (spec workshop-product-variants, rules 18, 24).
 *
 * The first option of a new group is its standard; the radio moves it. A
 * delete the server would refuse — the standard option, one an order line
 * chose, one parts are bound to — is shown disabled with the reason, read off
 * the counts the product response carries. Changing the standard changes no
 * saved order: every line recorded its choice.
 */
export function ProductVariants({ product, canEdit }: { product: Product; canEdit: boolean }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const groups = product.variant_groups ?? [];
  const [groupDraft, setGroupDraft] = useState({ name: '', options: '' });
  const [optionDrafts, setOptionDrafts] = useState<Record<number, string>>({});
  const [deleting, setDeleting] = useState<Deleting | null>(null);
  // A name being typed, keyed `g<id>` / `o<id>`. A field with no entry shows the
  // server's name — so a blanked or refused rename falls back to it by itself.
  const [names, setNames] = useState<Record<string, string>>({});
  const forget = (key: string) =>
    setNames((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['product', product.id] });
    invalidateProductCatalog(queryClient);
    // Order lines name the options they chose, and a new group adds a choice to each.
    invalidateOrderViews(queryClient);
  };
  const fail = (e: Error) => showToast(e.message, 'error');

  const createGroup = useMutation({
    mutationFn: (data: { name: string; options: string[] }) => api.createVariantGroup(product.id, data),
    onSuccess: () => {
      setGroupDraft({ name: '', options: '' });
      refresh();
    },
    onError: fail,
  });
  const updateGroup = useMutation({
    mutationFn: ({ group, data }: { group: VariantGroup; data: { name?: string; default_option_id?: number } }) =>
      api.updateVariantGroup(product.id, group.id, data),
    onSuccess: async (_p, { group }) => {
      await refresh();
      forget(`g${group.id}`);
    },
    onError: (e: Error, { group }) => {
      forget(`g${group.id}`);
      fail(e);
    },
  });
  const createOption = useMutation({
    mutationFn: ({ group, name }: { group: VariantGroup; name: string }) =>
      api.createVariantOption(product.id, group.id, name),
    onSuccess: (_p, { group }) => {
      setOptionDrafts((prev) => ({ ...prev, [group.id]: '' }));
      refresh();
    },
    onError: fail,
  });
  const updateOption = useMutation({
    mutationFn: ({ group, option, name }: { group: VariantGroup; option: VariantOption; name: string }) =>
      api.updateVariantOption(product.id, group.id, option.id, { name }),
    onSuccess: async (_p, { option }) => {
      await refresh();
      forget(`o${option.id}`);
    },
    onError: (e: Error, { option }) => {
      forget(`o${option.id}`);
      fail(e);
    },
  });
  const remove = useMutation({
    mutationFn: (target: Deleting) =>
      target.kind === 'group'
        ? api.deleteVariantGroup(product.id, target.group.id)
        : api.deleteVariantOption(product.id, target.group.id, target.option.id),
    onSuccess: () => {
      setDeleting(null);
      refresh();
    },
    onError: fail,
  });

  if (!canEdit && groups.length === 0) return null;

  const commitGroupName = (group: VariantGroup) => {
    const typed = names[`g${group.id}`];
    if (typed === undefined) return;
    const name = typed.trim();
    if (!name || name === group.name) forget(`g${group.id}`);
    else updateGroup.mutate({ group, data: { name } });
  };
  const commitOptionName = (group: VariantGroup, option: VariantOption) => {
    const typed = names[`o${option.id}`];
    if (typed === undefined) return;
    const name = typed.trim();
    if (!name || name === option.name) forget(`o${option.id}`);
    else updateOption.mutate({ group, option, name });
  };

  /** Why the server would refuse deleting this option, or null when it would not. */
  const optionRefusal = (group: VariantGroup, option: VariantOption): string | null => {
    if (option.id === group.default_option_id) return t('products.variants.isStandard');
    if (option.lines_count > 0) return t('products.variants.chosenInLines', { count: option.lines_count });
    if ((option.stock_count ?? 0) > 0) return t('products.variants.heldByStock', { count: option.stock_count });
    if (option.parts_count > 0) return t('products.variants.hasParts', { count: option.parts_count });
    return null;
  };
  const groupRefusal = (group: VariantGroup): string | null => {
    // A line holds exactly one choice per group, so the options' counts sum to its lines.
    const lines = group.options.reduce((sum, o) => sum + o.lines_count, 0);
    const parts = group.options.reduce((sum, o) => sum + o.parts_count, 0);
    const stock = group.options.reduce((sum, o) => sum + (o.stock_count ?? 0), 0);
    if (lines > 0) return t('products.variants.chosenInLines', { count: lines });
    if (stock > 0) return t('products.variants.heldByStock', { count: stock });
    if (parts > 0) return t('products.variants.hasParts', { count: parts });
    return null;
  };

  const renameField = (key: string, value: string, label: string, onCommit: () => void) => (
    <input
      value={names[key] ?? value}
      disabled={!canEdit}
      aria-label={label}
      onChange={(e) => {
        const typed = e.target.value;
        setNames((prev) => ({ ...prev, [key]: typed }));
      }}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className={`${FIELD_CLASS} min-w-[8rem]`}
    />
  );

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold text-white">{t('products.variants.title')}</h2>
        <p className="text-xs text-bambu-gray">{t('products.variants.hint')}</p>
      </div>
      {groups.length === 0 && <p className="text-sm text-bambu-gray">{t('products.variants.empty')}</p>}
      {groups.map((group) => {
        const groupBlock = groupRefusal(group);
        return (
          <div
            key={group.id}
            data-testid={`variant-group-${group.id}`}
            className="rounded-xl border border-bambu-dark-tertiary p-3 space-y-2"
          >
            <div className="flex items-center gap-2">
              {renameField(`g${group.id}`, group.name, t('products.variants.groupName'), () =>
                commitGroupName(group),
              )}
              {canEdit && (
                <button
                  type="button"
                  disabled={groupBlock !== null}
                  title={groupBlock ?? t('products.variants.deleteGroup', { name: group.name })}
                  aria-label={t('products.variants.deleteGroup', { name: group.name })}
                  onClick={() => setDeleting({ kind: 'group', group })}
                  className={ICON_BUTTON}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
            <ul className="space-y-1.5">
              {group.options.map((option) => {
                const block = optionRefusal(group, option);
                return (
                  <li key={option.id} className="flex items-center gap-2 flex-wrap">
                    <label className="inline-flex items-center gap-1.5 text-xs text-bambu-gray">
                      <input
                        type="radio"
                        name={`variant-standard-${group.id}`}
                        data-testid={`variant-option-${option.id}-standard`}
                        checked={option.id === group.default_option_id}
                        disabled={!canEdit}
                        aria-label={t('products.variants.makeStandard', { name: option.name })}
                        onChange={() => updateGroup.mutate({ group, data: { default_option_id: option.id } })}
                        className="accent-bambu-green"
                      />
                      {option.id === group.default_option_id && t('products.variants.standard')}
                    </label>
                    {renameField(`o${option.id}`, option.name, t('products.variants.optionName'), () =>
                      commitOptionName(group, option),
                    )}
                    <span className="text-xs text-bambu-gray tabular-nums">
                      {t('products.variants.inLines', { count: option.lines_count })} ·{' '}
                      {t('products.variants.boundParts', { count: option.parts_count })}
                    </span>
                    {canEdit && (
                      <button
                        type="button"
                        data-testid={`variant-option-${option.id}-delete`}
                        disabled={block !== null}
                        title={block ?? t('products.variants.deleteOption', { name: option.name })}
                        aria-label={t('products.variants.deleteOption', { name: option.name })}
                        onClick={() => setDeleting({ kind: 'option', group, option })}
                        className={ICON_BUTTON}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {canEdit && (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const name = (optionDrafts[group.id] ?? '').trim();
                  if (name) createOption.mutate({ group, name });
                }}
              >
                <input
                  value={optionDrafts[group.id] ?? ''}
                  onChange={(e) => {
                    const typed = e.target.value;
                    setOptionDrafts((prev) => ({ ...prev, [group.id]: typed }));
                  }}
                  aria-label={t('products.variants.newOption')}
                  placeholder={t('products.variants.newOption')}
                  className={`${FIELD_CLASS} w-40`}
                />
                <Button type="submit" size="sm" variant="secondary" disabled={!(optionDrafts[group.id] ?? '').trim()}>
                  <Plus className="w-4 h-4" />
                  {t('products.variants.addOption')}
                </Button>
              </form>
            )}
          </div>
        );
      })}
      {canEdit && (
        <form
          className="flex items-center gap-2 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const name = groupDraft.name.trim();
            const options = groupDraft.options
              .split(',')
              .map((o) => o.trim())
              .filter(Boolean);
            if (name && options.length) createGroup.mutate({ name, options });
          }}
        >
          <input
            value={groupDraft.name}
            onChange={(e) => {
              const typed = e.target.value;
              setGroupDraft((prev) => ({ ...prev, name: typed }));
            }}
            aria-label={t('products.variants.newGroup')}
            placeholder={t('products.variants.newGroup')}
            className={`${FIELD_CLASS} w-40`}
          />
          <input
            value={groupDraft.options}
            onChange={(e) => {
              const typed = e.target.value;
              setGroupDraft((prev) => ({ ...prev, options: typed }));
            }}
            aria-label={t('products.variants.newGroupOptions')}
            placeholder={t('products.variants.newGroupOptions')}
            className={`${FIELD_CLASS} flex-1 min-w-[12rem]`}
          />
          <Button
            type="submit"
            size="sm"
            disabled={!groupDraft.name.trim() || !groupDraft.options.trim() || createGroup.isPending}
          >
            <Plus className="w-4 h-4" />
            {t('products.variants.addGroup')}
          </Button>
        </form>
      )}
      {deleting && (
        <ConfirmModal
          title={t(deleting.kind === 'group' ? 'products.variants.deleteGroupTitle' : 'products.variants.deleteOptionTitle')}
          message={
            deleting.kind === 'group'
              ? t('products.variants.deleteGroupBody', { name: deleting.group.name })
              : t('products.variants.deleteOptionBody', { name: deleting.option.name })
          }
          confirmText={t('common.delete')}
          variant="danger"
          isLoading={remove.isPending}
          onConfirm={() => remove.mutate(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </section>
  );
}
