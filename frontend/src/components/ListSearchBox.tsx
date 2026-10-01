import { useRef } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X } from 'lucide-react';
import { useSearchHotkey } from '../hooks/useSearchHotkey';

/**
 * The search box of a Workshop list: icon, clear button, and the `/` hotkey
 * (spec workshop-lists, rule 23) — one component instead of four copies.
 * `value` / `onChange` are the page's `useSearchBox` pair; debounce and URL
 * stay there.
 *
 * `layout` (WS-13 E2 B06): `list` — a list page's box, 280 px (never wider than
 * its container), the whole row at a viewport of 760 px and narrower; `picker` —
 * the «Add to order» tabs', growing into the rest of its row and taking a row of
 * its own at 760 and narrower. Clearing gives the focus back to the box, and the
 * browser's own cancel cross is hidden — one clear button, not two.
 */
export function ListSearchBox({
  value,
  onChange,
  placeholder,
  layout = 'list',
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  layout?: 'list' | 'picker';
  /** The page's own handle on the field — «Reset» puts the focus back here (WS-13 E7 C04). */
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation();
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  useSearchHotkey(ref);
  // ⚠️ `max-[761px]`: Tailwind 4 writes `max-*` as `width < N`; the rule is «760 and narrower».
  const width =
    layout === 'picker' ? 'w-full min-w-0 flex-1 max-[761px]:basis-full' : 'w-[280px] max-w-full max-[761px]:w-full';
  return (
    <div className={`relative ${width}`}>
      <Search className="w-4 h-4 text-bambu-gray absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
      <input
        ref={ref}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full pl-9 pr-8 py-2 bg-bambu-dark border border-bambu-dark-tertiary rounded-lg text-white text-sm focus:border-bambu-green focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            ref.current?.focus();
          }}
          aria-label={t('list.search.clear')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-bambu-gray hover:text-white"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
