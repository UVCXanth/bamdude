import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type ListView = 'cards' | 'table';

export interface ListViewOption<V extends string> {
  value: V;
  icon: LucideIcon;
  label: string;
}

/**
 * The view switch every list of the Projects section shares (spec
 * workshop-lists, rule 12): N modes the page names, each an icon and a label.
 * At a viewport of 760 px and narrower the label hides (WS-13 E2 B04); the button
 * keeps its name through `aria-label`. `max-[761px]` because Tailwind 4 writes
 * `max-*` as `width < N`.
 * The choice is a preference — the page keeps it with `usePersistedState`.
 */
export function ListViewToggle<V extends string>({
  value,
  options,
  onChange,
}: {
  value: V;
  options: readonly ListViewOption<V>[];
  onChange: (view: V) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t('list.view.label')}
      className="flex rounded-lg border border-bambu-dark-tertiary overflow-hidden text-sm"
    >
      {options.map(({ value: mode, icon: Icon, label }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          aria-label={label}
          title={label}
          onClick={() => onChange(mode)}
          className={`flex items-center gap-1.5 px-3 py-1.5 ${value === mode ? 'bg-bambu-dark-tertiary text-white' : 'text-bambu-gray hover:text-white'}`}
        >
          <Icon className="w-4 h-4" aria-hidden="true" />
          <span className="max-[761px]:hidden">{label}</span>
        </button>
      ))}
    </div>
  );
}
