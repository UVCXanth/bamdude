import { useCallback, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Layers } from 'lucide-react';
import { api, withMediaToken } from '../../../api/client';
import type { LibraryFileListItem, LibraryFolderTree } from '../../../api/client';
import type { PlateMetadata } from '../../../types/plates';
import { useAuth } from '../../../contexts/AuthContext';
import { useSearchBox } from '../../../hooks/useSearchBox';
import { isPrintable } from '../../../lib/fileTags';
import { formatDuration } from '../../../utils/date';
import { formatWeight } from '../../../utils/weight';
import { Button } from '../../Button';
import { ListSearchBox } from '../../ListSearchBox';
import { PaginationBar } from '../../PaginationBar';
import { RefreshFailedNote } from '../../workshop/RefreshFailedNote';
import { WorkshopField, WorkshopFormGrid } from '../../workshop/WorkshopFormGrid';
import { MODEL_CHIP } from '../chips';
import { MAX_LINE_QTY, plateFileOf } from './addToOrderState';
import type { PlatePick } from './addToOrderState';
import { CountInput } from './CountInput';
import { platesReadable, usePlatesOf } from './platesQuery';
import { LoadingRows } from './LoadingRows';

const PAGE_SIZE = 24;

/**
 * «One-off from a file» (spec workshop-add-to-order, rule 22; WS-13 E5 E — the
 * mockup's `addFileTab`): a server search over the whole library on the left, the
 * picked file's plates on the right. The added line is a one-off product made of
 * that plate (or the one already made of it).
 *
 * ⚠️ Three questions, three answers (E5 R01), all the server's: can the file's TYPE
 * be planned (`plan_eligible`, the rule the batch refuses by), is it SLICED (the
 * `gcode` tag, `isPrintable`), and does it HAVE plates (`/plates`). An unsliced
 * 3MF may list plates in its metadata — it still gets «slice it first» and no plate
 * choice; a raw `.gcode` has no plates and is not «unsliced». This is the picker's
 * policy, not a new refusal of the server.
 *
 * Without the right to read the library the tab explains and reads nothing (R04);
 * what a reader with `read_own` sees is the server's ownership, not a client filter.
 */
export function PlateTab({ pick, onPickChange }: { pick: PlatePick; onPickChange: (next: PlatePick) => void }) {
  const { t } = useTranslation();
  const { hasAnyPermission } = useAuth();
  if (!hasAnyPermission('library:read_all', 'library:read_own')) {
    return <p className="text-sm text-bambu-gray">{t('orders.add.plate.noAccess')}</p>;
  }
  return <LibraryPlatePicker pick={pick} onPickChange={onPickChange} />;
}

/** `folder id → name` over the whole tree. */
function folderNames(tree: LibraryFolderTree[]): Map<number, string> {
  const out = new Map<number, string>();
  const walk = (nodes: LibraryFolderTree[]) => {
    for (const node of nodes) {
      out.set(node.id, node.name);
      walk(node.children ?? []);
    }
  };
  walk(tree);
  return out;
}

function LibraryPlatePicker({ pick, onPickChange }: { pick: PlatePick; onPickChange: (next: PlatePick) => void }) {
  const { t } = useTranslation();
  const [q, setQState] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(PAGE_SIZE);
  const setQ = useCallback((value: string) => {
    setQState(value);
    setPage(1);
  }, []);
  const { typed, setTyped } = useSearchBox(q, setQ);

  // The whole library: without a folder the server lists the root's files alone unless
  // `include_root` is off (`recursive` means nothing without a folder).
  const params = {
    include_root: false,
    page,
    ...(perPage === -1 ? { all: true } : { per_page: perPage }),
    ...(q ? { q } : {}),
  };
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['library-files', 'add-to-order', params],
    queryFn: () => api.getLibraryFilesPaged(params),
    placeholderData: keepPreviousData,
  });
  const files = data?.items ?? [];
  const { data: tree, isSuccess: treeRead } = useQuery({
    queryKey: ['library-folders'],
    queryFn: () => api.getLibraryFolders(),
  });
  const names = useMemo(() => folderNames(tree ?? []), [tree]);

  return (
    <div className="space-y-3">
      <p className="my-2.5 text-[13px] text-bambu-gray">{t('orders.add.help.plate')}</p>
      <div className="grid min-h-[260px] rounded-lg border border-bambu-dark-tertiary min-[1101px]:grid-cols-[340px_1fr]">
        {/* `max-[1100px]:` is `< 1100` in Tailwind 4: the one-column rule is «1100 and narrower». */}
        <div className="min-w-0 border-b border-bambu-dark-tertiary min-[1101px]:border-r min-[1101px]:border-b-0">
          <div className="p-3">
            <ListSearchBox value={typed} onChange={setTyped} placeholder={t('orders.add.plate.search')} layout="picker" />
          </div>
          {isError && data && (
            <div className="px-3">
              <RefreshFailedNote onRetry={() => refetch()} />
            </div>
          )}
          <ul className="max-h-[380px] overflow-y-auto border-t border-bambu-dark-tertiary">
            {files.map((file) => (
              <li key={file.id}>
                <FileRow
                  file={file}
                  chosen={pick?.file.id === file.id}
                  folder={file.folder_id == null ? t('orders.add.plate.root') : treeRead ? names.get(file.folder_id) : undefined}
                  // A new file resets the plate, never the copies (E5 R08); the chosen file
                  // clicked again changes nothing (review M4).
                  onPick={() => {
                    if (pick?.file.id === file.id) return;
                    onPickChange({ file: plateFileOf(file), plateIndex: null, copies: pick?.copies ?? 1 });
                  }}
                />
              </li>
            ))}
            {isPending && <LoadingRows />}
            {isError && !data && (
              <li className="p-4 text-center text-sm">
                <span className="text-amber-700 dark:text-amber-400">{t('orders.add.plate.filesFailed')}</span>{' '}
                <Button size="sm" variant="ghost" onClick={() => refetch()}>
                  {t('common.retry')}
                </Button>
              </li>
            )}
            {data && files.length === 0 && (
              <li className="p-4 text-center text-sm text-bambu-gray">
                {q ? t('orders.add.plate.noFiles') : t('orders.add.plate.emptyLibrary')}
              </li>
            )}
          </ul>
          <PaginationBar
            variant="bare"
            page={page}
            totalPages={data?.meta.last_page ?? 1}
            perPage={perPage}
            total={data?.meta.total ?? 0}
            onPageChange={setPage}
            onPerPageChange={(n) => {
              setPerPage(n);
              setPage(1);
            }}
            items={t('orders.add.plate.noun')}
          />
        </div>
        <div className="min-w-0 p-4">
          <PlatePane pick={pick} onPickChange={onPickChange} />
        </div>
      </div>
    </div>
  );
}

function FileRow({
  file,
  chosen,
  folder,
  onPick,
}: {
  file: LibraryFileListItem;
  chosen: boolean;
  /** `undefined` — the folder tree is not read (yet, or at all): the segment is left out. */
  folder: string | undefined;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  const eligible = file.plan_eligible ?? false;
  const printable = isPrintable(file);
  // R01: a type that cannot be planned, a file not sliced, a sliced file's model —
  // and nothing for a sliced file whose model is unknown (it is not «not sliced»).
  const state = !eligible ? (
    <span className="text-amber-700 dark:text-amber-400">
      {t('orders.add.plate.notPlannable', { type: file.file_type.toUpperCase() })}
    </span>
  ) : !printable ? (
    <span className="text-amber-700 dark:text-amber-400">{t('orders.add.plate.notSliced')}</span>
  ) : file.sliced_for_model ? (
    <span className={MODEL_CHIP}>{file.sliced_for_model}</span>
  ) : null;
  return (
    <button
      type="button"
      aria-pressed={chosen}
      onClick={onPick}
      className={`w-full border-b border-bambu-dark-tertiary px-4 py-3.5 text-left text-sm last:border-b-0 ${
        chosen ? 'bg-bambu-green/10 shadow-[inset_3px_0_0_var(--accent)] text-white' : 'text-white hover:bg-bambu-dark-tertiary/50'
      }`}
    >
      <span className="block font-semibold [overflow-wrap:anywhere]">{file.filename}</span>
      <span className="mt-0.5 flex flex-wrap items-center gap-x-1 text-xs text-bambu-gray">
        {folder !== undefined && <span>{folder}</span>}
        {folder !== undefined && state && <span aria-hidden>·</span>}
        {state}
      </span>
    </button>
  );
}

/** The right pane — the table of states of E5 R01, then the plates and the copies. */
function PlatePane({ pick, onPickChange }: { pick: PlatePick; onPickChange: (next: PlatePick) => void }) {
  const { t } = useTranslation();
  const file = pick?.file ?? null;
  const printable = platesReadable(file);
  // The dialog reads the same query to drop a chosen plate the answer no longer has (V01).
  const { data, isPending, isError, refetch } = usePlatesOf(file);

  if (pick == null || file == null) return <p className="text-sm text-bambu-gray">{t('orders.add.plate.pickFile')}</p>;
  if (!file.planEligible) return <p className="text-sm text-amber-700 dark:text-amber-400">{t('orders.add.plate.typeRefused')}</p>;
  if (!printable) return <p className="text-sm text-amber-700 dark:text-amber-400">{t('orders.add.plate.sliceFirst')}</p>;
  if (isPending) return <p className="text-sm text-bambu-gray">{t('orders.add.plate.reading')}</p>;
  if (isError && !data) {
    return (
      <p className="flex items-center gap-2 text-sm">
        <span className="text-amber-700 dark:text-amber-400">{t('orders.add.plate.platesFailed')}</span>
        <Button size="sm" variant="ghost" onClick={() => refetch()}>
          {t('common.retry')}
        </Button>
      </p>
    );
  }
  const plates = data?.plates ?? [];
  if (plates.length === 0) return <p className="text-sm text-bambu-gray">{t('orders.add.plate.noPlates')}</p>;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-white">{t('orders.add.plate.plates')}</h3>
      <div role="radiogroup" aria-label={t('orders.add.plate.plates')} className="space-y-2">
        {plates.map((p) => (
          <PlateOption
            // A plate is its file's: the same number in another file is another picture (V02).
            key={`${file.id}:${p.index}`}
            fileId={file.id}
            plate={p}
            checked={pick.plateIndex === p.index}
            onChoose={() => onPickChange({ ...pick, plateIndex: p.index })}
          />
        ))}
      </div>
      {/* E08: a field of the form grid under the plates, its label over it. */}
      <WorkshopFormGrid>
        <WorkshopField label={t('orders.add.plate.copies')} htmlFor="add-to-order-plate-copies">
          <CountInput
            id="add-to-order-plate-copies"
            value={pick.copies}
            min={1}
            max={MAX_LINE_QTY}
            onCommit={(copies) => onPickChange({ ...pick, copies })}
            ariaLabel={t('orders.add.plate.copies')}
          />
        </WorkshopField>
      </WorkshopFormGrid>
    </div>
  );
}

/**
 * «clip × 2, big × 1» — from `printable_objects` (one entry per instance), else from
 * `objects`: the same order of sources `product_composition.plate_key_counts` reads.
 */
function objectCounts(plate: PlateMetadata): string {
  const printable = plate.printable_objects ? Object.values(plate.printable_objects) : [];
  const names = printable.length > 0 ? printable : plate.objects;
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${name} × ${n}`).join(', ');
}

function PlateOption({
  fileId,
  plate,
  checked,
  onChoose,
}: {
  fileId: number;
  plate: PlateMetadata;
  checked: boolean;
  onChoose: () => void;
}) {
  const { t } = useTranslation();
  // The picture that failed, by its address: another address — another file's plate, or a
  // new picture of this one — is tried, never taken for the failed one (E5-V02).
  const src = plate.has_thumbnail && plate.thumbnail_url ? withMediaToken(plate.thumbnail_url) : null;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const materials = [...new Set((plate.filaments ?? []).map((f) => f.type).filter(Boolean))].join(', ');
  const weight = plate.filament_used_grams != null ? `${formatWeight(plate.filament_used_grams)}${materials ? ` ${materials}` : ''}` : materials;
  const detail = [
    objectCounts(plate),
    plate.print_time_seconds != null ? formatDuration(plate.print_time_seconds) : null,
    weight || null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 ${
        checked ? 'border-bambu-green bg-bambu-green/10' : 'border-bambu-dark-tertiary'
      }`}
    >
      <input type="radio" name={`add-to-order-plate-${fileId}`} checked={checked} onChange={onChoose} className="mt-3 accent-bambu-green" />
      {src && src !== failedSrc ? (
        // The picture is a protected media path: the token rides in the URL (media invariant).
        <img
          src={src}
          alt=""
          onError={() => setFailedSrc(src)}
          className="h-10 w-10 flex-shrink-0 rounded-lg bg-bambu-dark-tertiary object-contain"
        />
      ) : (
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-bambu-dark-tertiary">
          <Layers className="h-[18px] w-[18px] text-bambu-gray" aria-hidden />
        </span>
      )}
      <span className="min-w-0 text-sm">
        <span className="block font-medium text-white">
          {[t('orders.add.plate.plate', { n: plate.index }), plate.name].filter(Boolean).join(' · ')}
        </span>
        {detail && <span className="block text-xs text-bambu-gray">{detail}</span>}
      </span>
    </label>
  );
}
