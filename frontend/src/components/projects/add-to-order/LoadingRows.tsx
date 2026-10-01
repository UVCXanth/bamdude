import { useTranslation } from 'react-i18next';

/**
 * A picker list's cold read (WS-13 E5 C07, D07, E03): placeholder rows where the
 * rows will be, and the word for a screen reader. `colSpan` — inside a table body;
 * without it — an item of a list.
 */
export function LoadingRows({ colSpan }: { colSpan?: number }) {
  const { t } = useTranslation();
  const body = (
    <div role="status" aria-busy="true" className="space-y-2 p-3">
      <span className="sr-only">{t('common.loading')}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden="true" className="h-10 animate-pulse rounded-lg bg-bambu-dark-tertiary/40" />
      ))}
    </div>
  );
  return colSpan != null ? (
    <tr>
      <td colSpan={colSpan} className="p-0">
        {body}
      </td>
    </tr>
  ) : (
    <li>{body}</li>
  );
}
