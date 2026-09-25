import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { useSearchHotkey } from '../hooks/useSearchHotkey';

/**
 * The search box of a Workshop list: icon, clear button, and the `/` hotkey
 * (spec workshop-lists, rule 23) — one component instead of four copies.
 * `value` / `onChange` are the page's `useSearchBox` pair; debounce and URL
 * stay there.
 */
export function ListSearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  useSearchHotkey(ref);
  return (
    <div className="relative">
      <Search className="w-4 h-4 text-bambu-gray absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="pl-9 pr-8 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={t('list.search.clear')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-bambu-gray hover:text-white"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
