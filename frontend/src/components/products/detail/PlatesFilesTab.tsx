import { useState, type RefObject } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Folder, X } from 'lucide-react';
import { api } from '../../../api/client';
import type { PlateRecipe, Product, ProductFileGroup, ProductFolderRef } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useFocusWhenRowLeaves } from '../../../hooks/useFocusWhenRowLeaves';
import { useProductFileGroups } from '../../../hooks/useProductFileGroups';
import { getColorName } from '../../../utils/colors';
import { formatDuration } from '../../../utils/date';
import { invalidateProductFiles } from '../../../utils/queryInvalidation';
import { formatWeight } from '../../../utils/weight';
import { Button } from '../../Button';
import { ActionConfirm } from '../../workshop/ActionConfirm';
import { LoadFailedNote } from '../../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../../workshop/RefreshFailedNote';
import { ModelChip } from './ModelChip';

const HEAD = 'px-3 py-2 text-left text-xs font-normal text-bambu-gray';
const CELL = 'px-3 py-2 align-top';
const CHIP = 'inline-flex items-center rounded px-1.5 text-[11px] leading-5';
const AMBER = 'text-amber-700 dark:text-amber-400';
const LINK_BUTTON =
  'inline-flex items-center rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-tertiary px-3 py-1.5 text-sm font-medium text-white hover:bg-bambu-gray-dark';

type Unlinking = { kind: 'file'; file: ProductFileGroup; row: Element | null } | { kind: 'folder'; folder: ProductFolderRef; row: Element | null };

/** One plate of a file (E03): what it gives, time, filament, material and colour. */
function PlateRow({ plate }: { plate: PlateRecipe }) {
  const { t } = useTranslation();
  return (
    <tr data-testid={`plate-${plate.id}`} className="border-b border-bambu-dark-tertiary last:border-0">
      <td className={`${CELL} whitespace-nowrap text-white`}>
        {/* 0 is not a plate number: the file IS the recipe (a `.gcode`, a one-plate export). */}
        {plate.plate_index === 0
          ? t('products.detail.files.wholeFile')
          : t('products.detail.files.plateN', { index: plate.plate_index })}
      </td>
      <td className={CELL}>
        <span className="flex flex-wrap gap-1">
          {plate.yield.map((entry) => (
            <span key={`y-${entry.part_id}-${entry.name}`} className={`${CHIP} bg-bambu-green/15 text-bambu-green`}>
              {`${entry.name} × ${entry.count}`}
            </span>
          ))}
          {/* An object no part claims is shown, not hidden: the product under-counts what the
              plate prints until somebody adds a part (or an alias) with that name. */}
          {plate.unassigned.map((entry) => (
            <span
              key={`u-${entry.name_key}`}
              title={t('products.detail.files.notInComposition')}
              className={`${CHIP} border border-dashed border-bambu-gray/40 text-bambu-gray`}
            >
              {`${entry.name_key} × ${entry.count}`}
            </span>
          ))}
        </span>
      </td>
      <td className={`${CELL} whitespace-nowrap tabular-nums`}>
        {plate.print_time_seconds != null ? formatDuration(plate.print_time_seconds) : '—'}
      </td>
      <td className={`${CELL} whitespace-nowrap tabular-nums`}>
        {plate.filament_used_grams != null ? formatWeight(plate.filament_used_grams) : '—'}
      </td>
      <td className={CELL}>
        <span className="inline-flex flex-wrap items-center gap-1">
          <span>{plate.materials.join(', ') || '—'}</span>
          {plate.colors.map((color) => (
            <span
              key={color}
              title={getColorName(color)}
              style={{ backgroundColor: color }}
              className="inline-block h-2.5 w-2.5 rounded-full border border-bambu-gray/60"
            />
          ))}
        </span>
      </td>
    </tr>
  );
}

/**
 * The «Plates and files» tab of the product page (WS-13 E9 E01–E05).
 *
 * One card per linked file from `GET /products/{id}/files` (`useProductFileGroups`, the
 * re-read dialog's own question) in the server's order — named by name, the files the
 * reader may not open after them as «A file you cannot open», with their plates and
 * numbers and no folder or link; there is no «N more» (R10). The linked folders come in
 * the same answer (A03), so the tab asks nothing of `/library/*`.
 *
 * A file is unlinked by the link that holds it NOW (R01): one inside a linked folder has no
 * unlink of its own — the server keeps no history of how a file joined, and unlinking such
 * a file would answer 200 and change nothing — it says which folder holds it, and goes
 * with that folder. Every unlink asks first and says what it takes (`ActionConfirm`).
 *
 * «Link a file…» and every link into the File Manager are for somebody who reads the
 * library (`library:read_all` / `read_own`) — and, for the button, may change the product.
 */
export function PlatesFilesTab({
  product,
  headingRef,
  onReread,
}: {
  product: Pick<Product, 'id'>;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onReread: () => void;
}) {
  const { t } = useTranslation();
  const { hasPermission, hasAnyPermission } = useAuth();
  const canEdit = hasPermission('projects:update');
  const library = hasAnyPermission('library:read_all', 'library:read_own');
  const queryClient = useQueryClient();
  const groups = useProductFileGroups(product.id);
  const [unlinking, setUnlinking] = useState<Unlinking | null>(null);
  const keepFocusWhenRowLeaves = useFocusWhenRowLeaves(headingRef);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['product', product.id] });
    invalidateProductFiles(queryClient, product.id);
    queryClient.invalidateQueries({ queryKey: ['library-files'] });
  };

  let body;
  if (!groups.data) {
    body = groups.isError ? (
      <LoadFailedNote message={t('products.detail.files.loadFailed')} onRetry={() => groups.refetch()} />
    ) : (
      <p className="text-sm text-bambu-gray">{t('common.loading')}</p>
    );
  } else {
    const { files, folders } = groups.data;
    body = (
      <>
        {groups.isError && <RefreshFailedNote onRetry={() => groups.refetch()} />}
        {files.length === 0 ? (
          <div data-testid="product-files-empty" className="space-y-1 py-6 text-center">
            <p className="text-white">{t('products.detail.files.empty')}</p>
            {library ? (
              <Link to="/files" className="text-sm text-bambu-green hover:underline">
                {t('products.detail.files.emptyHint')}
              </Link>
            ) : (
              <p className="text-sm text-bambu-gray">{t('products.detail.files.emptyHint')}</p>
            )}
          </div>
        ) : (
          files.map((file) => (
            <section
              key={file.library_file_id}
              data-testid={`product-file-${file.library_file_id}`}
              className="space-y-2 rounded-xl border border-bambu-dark-tertiary p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  {file.hidden ? (
                    <b className="font-medium italic text-bambu-gray">{t('products.detail.files.hiddenFile')}</b>
                  ) : (
                    <b className="font-semibold text-white wrap-anywhere">{file.filename}</b>
                  )}
                  {!file.hidden && file.folder_name && (
                    <small className="block text-xs text-bambu-gray wrap-anywhere">{file.folder_name}</small>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {file.sliced_any ? (
                    file.printer_model ? (
                      <ModelChip model={file.printer_model} />
                    ) : (
                      <span className={`${CHIP} bg-bambu-dark-tertiary text-bambu-gray-light`}>{t('products.detail.files.sliced')}</span>
                    )
                  ) : (
                    <span className={`${CHIP} bg-amber-500/15 ${AMBER}`}>{t('products.detail.files.unsliced')}</span>
                  )}
                  {file.in_linked_folder ? (
                    <small className="text-xs text-bambu-gray">
                      {file.hidden || !file.folder_name
                        ? t('products.detail.files.viaHiddenFolder')
                        : t('products.detail.files.viaFolder', { name: file.folder_name })}
                    </small>
                  ) : (
                    canEdit && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(e) =>
                          setUnlinking({ kind: 'file', file, row: e.currentTarget.closest('section') })
                        }
                      >
                        {t('products.detail.files.unlinkFile')}
                      </Button>
                    )
                  )}
                </div>
              </div>
              {file.plates.length === 0 ? (
                <p className="text-xs text-bambu-gray">{t('products.detail.files.noPlates')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-bambu-dark-tertiary">
                        <th className={HEAD}>{t('products.detail.files.plate')}</th>
                        <th className={HEAD}>{t('products.detail.files.gives')}</th>
                        <th className={HEAD}>{t('products.detail.files.time')}</th>
                        <th className={HEAD}>{t('products.detail.files.filament')}</th>
                        <th className={HEAD}>{t('products.detail.files.material')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {file.plates.map((plate) => (
                        <PlateRow key={plate.id} plate={plate} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))
        )}
        {folders.length > 0 && (
          <div data-testid="product-folders" className="flex flex-wrap items-center gap-2 pt-1">
            <small className="text-xs text-bambu-gray">{t('products.detail.files.folders')}</small>
            {folders.map((folder) => {
              const name = folder.name ?? t('products.detail.files.hiddenFolder');
              const label = (
                <>
                  <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className={folder.name ? 'wrap-anywhere' : 'italic'}>{name}</span>
                </>
              );
              return (
                <span
                  key={folder.folder_id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-bambu-dark-tertiary px-2.5 py-0.5 text-xs text-bambu-gray-light"
                >
                  {library && folder.name ? (
                    <Link to={`/files?folder=${folder.folder_id}`} className="inline-flex items-center gap-1.5 hover:text-white">
                      {label}
                    </Link>
                  ) : (
                    label
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={t('products.detail.files.unlinkFolder', { name })}
                      title={t('products.detail.files.unlinkFolderTitle')}
                      onClick={(e) => setUnlinking({ kind: 'folder', folder, row: e.currentTarget.closest('span') })}
                      className="text-bambu-gray hover:text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <small className="text-xs text-bambu-gray">{t('products.detail.files.hint')}</small>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onReread}>
              {t('products.detail.menu.reread')}
            </Button>
            {library && (
              <Link to="/files" title={t('products.detail.files.linkHint')} className={LINK_BUTTON}>
                {t('products.detail.files.link')}
              </Link>
            )}
          </div>
        )}
      </div>

      {body}

      {unlinking?.kind === 'file' && (
        <ActionConfirm
          title={t('products.detail.files.unlinkFile')}
          body={
            <div className="space-y-2">
              <p>
                {unlinking.file.hidden
                  ? t('products.detail.files.unlinkHiddenFileBody', { id: unlinking.file.library_file_id })
                  : t('products.detail.files.unlinkFileBody', { name: unlinking.file.filename })}
              </p>
              <p className="text-bambu-gray">{t('products.detail.files.unlinkFileEffects')}</p>
            </div>
          }
          primaryLabel={t('products.detail.files.unlink')}
          danger
          send={async () => {
            await api.unlinkProductFile(product.id, unlinking.file.library_file_id);
            invalidate();
            // The card — and the button the focus goes back to — leaves with the re-read.
            keepFocusWhenRowLeaves(unlinking.row);
          }}
          onClose={() => setUnlinking(null)}
        />
      )}
      {unlinking?.kind === 'folder' && (
        <ActionConfirm
          title={t('products.detail.files.unlinkFolderTitle')}
          body={
            <div className="space-y-2">
              <p>
                {unlinking.folder.name
                  ? t('products.detail.files.unlinkFolderBody', { name: unlinking.folder.name })
                  : t('products.detail.files.unlinkHiddenFolderBody', { id: unlinking.folder.folder_id })}
              </p>
              <p className="text-bambu-gray">{t('products.detail.files.unlinkFolderEffects')}</p>
            </div>
          }
          primaryLabel={t('products.detail.files.unlink')}
          danger
          size="md"
          send={async () => {
            await api.unlinkProductFolder(product.id, unlinking.folder.folder_id);
            invalidate();
            keepFocusWhenRowLeaves(unlinking.row);
          }}
          onClose={() => setUnlinking(null)}
        />
      )}
    </div>
  );
}
