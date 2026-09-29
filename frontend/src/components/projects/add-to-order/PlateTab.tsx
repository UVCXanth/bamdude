import { useCallback, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileBox } from 'lucide-react';
import { api } from '../../../api/client';
import { useSearchBox } from '../../../hooks/useSearchBox';
import { formatDuration } from '../../../utils/date';
import { formatWeight } from '../../../utils/weight';
import { ListSearchBox } from '../../ListSearchBox';
import { PaginationBar } from '../../PaginationBar';
import { MAX_LINE_QTY } from './addToOrderState';
import type { PlatePick } from './addToOrderState';

const PAGE_SIZE = 24;

/**
 * «One-off from a file» (spec workshop-add-to-order, rule 22): a server search
 * over the whole library on the left, the picked file's plates on the right.
 * The added line is a one-off product made of that plate (or the one already
 * made of it). No `file_type` filter: a sliced `.gcode.3mf` is typed `gcode`
 * by its name, and whether a file can be planned is the server's call.
 */
export function PlateTab({ pick, onPickChange }: { pick: PlatePick; onPickChange: (next: PlatePick) => void }) {
  const { t } = useTranslation();
  const [q, setQState] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(PAGE_SIZE);
  const setQ = useCallback((value: string) => {
    setQState(value);
    setPage(1);
  }, []);
  const { typed, setTyped } = useSearchBox(q, setQ);

  const params = {
    recursive: true,
    page,
    ...(perPage === -1 ? { all: true } : { per_page: perPage }),
    ...(q ? { q } : {}),
  };
  const { data } = useQuery({
    queryKey: ['library-files', 'add-to-order', params],
    queryFn: () => api.getLibraryFilesPaged(params),
    placeholderData: keepPreviousData,
  });
  const files = data?.items ?? [];

  const fileId = pick?.fileId ?? null;
  const { data: plates, isLoading: platesLoading } = useQuery({
    queryKey: ['library-file-plates', fileId],
    queryFn: () => api.getLibraryFilePlates(fileId as number),
    enabled: fileId != null,
  });

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2 min-w-0">
        <ListSearchBox value={typed} onChange={setTyped} placeholder={t('orders.add.plate.search')} layout="picker" />
        <div className="rounded-lg border border-bambu-dark-tertiary">
          <ul className="divide-y divide-bambu-dark-tertiary max-h-96 overflow-y-auto">
            {files.map((file) => (
              <li key={file.id}>
                <button
                  type="button"
                  aria-pressed={fileId === file.id}
                  onClick={() => onPickChange({ fileId: file.id, filename: file.filename, plateIndex: null, copies: 1 })}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${
                    fileId === file.id ? 'bg-bambu-green/15 text-white' : 'text-bambu-gray hover:text-white'
                  }`}
                >
                  <FileBox className="w-4 h-4 flex-shrink-0" aria-hidden />
                  <span className="truncate">{file.filename}</span>
                </button>
              </li>
            ))}
            {data && files.length === 0 && (
              <li className="p-4 text-center text-sm text-bambu-gray">{t('orders.add.plate.noFiles')}</li>
            )}
          </ul>
          <PaginationBar
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
      </div>

      <div className="space-y-3 min-w-0">
        {pick == null ? (
          <p className="text-sm text-bambu-gray">{t('orders.add.plate.pickFile')}</p>
        ) : platesLoading ? null : (plates?.plates ?? []).length === 0 ? (
          <p className="text-sm text-amber-400">{t('orders.add.plate.sliceFirst')}</p>
        ) : (
          <>
            <div role="radiogroup" aria-label={t('orders.add.plate.plates')} className="space-y-1">
              {(plates?.plates ?? []).map((p) => {
                const detail = [
                  p.print_time_seconds != null ? formatDuration(p.print_time_seconds) : null,
                  p.filament_used_grams != null ? formatWeight(p.filament_used_grams) : null,
                ]
                  .filter(Boolean)
                  .join(' · ');
                return (
                  <label
                    key={p.index}
                    className="flex items-start gap-2 rounded-lg border border-bambu-dark-tertiary px-3 py-2 cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="add-to-order-plate"
                      checked={pick.plateIndex === p.index}
                      onChange={() => onPickChange({ ...pick, plateIndex: p.index })}
                      className="accent-bambu-green mt-1"
                    />
                    <span className="min-w-0 text-sm">
                      <span className="block text-white">
                        {[t('orders.add.plate.plate', { n: p.index }), p.name].filter(Boolean).join(' · ')}
                      </span>
                      <span className="block text-xs text-bambu-gray">
                        {t('orders.add.plate.objects', { count: p.object_count ?? p.objects.length })}
                      </span>
                      {detail && <span className="block text-xs text-bambu-gray">{detail}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
            <label className="flex items-center gap-2 text-sm text-white">
              {t('orders.add.plate.copies')}
              <input
                type="number"
                min={1}
                max={MAX_LINE_QTY}
                value={pick.copies}
                onChange={(e) =>
                  onPickChange({
                    ...pick,
                    copies: Math.min(MAX_LINE_QTY, Math.max(1, Math.floor(Number(e.target.value)) || 1)),
                  })
                }
                className="w-24 px-2 py-1 bg-bambu-dark border border-bambu-dark-tertiary rounded text-white"
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}
