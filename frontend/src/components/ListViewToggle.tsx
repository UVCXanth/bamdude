import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type ListView = 'cards' | 'table';

export interface ListViewOption<V extends string> {
  value: V;
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  hint?: string;
}

/**
 * The shared view switch for lists throughout the app: N modes the page names,
 * each with an icon and a label.
 * At a viewport of 760 px and narrower the label hides (WS-13 E2 B04); the button
 * keeps its name through `aria-label`. `max-[761px]` because Tailwind 4 writes
 * `max-*` as `width < N`.
 * The page owns the choice and its persistence.
 */
export function ListViewToggle<V extends string>({
  value,
  options,
  onChange,
  label,
  inMenu = false,
}: {
  value: V;
  options: readonly ListViewOption<V>[];
  onChange: (view: V) => void;
  label?: string;
  inMenu?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={label ?? t('list.view.label')}
      className={`flex rounded-lg border border-bambu-dark-tertiary overflow-hidden text-sm ${inMenu ? 'w-full flex-col gap-1' : 'h-8 shrink-0 items-center'}`}
    >
      {options.map(({ value: mode, icon: Icon, label: optionLabel, disabled, hint }) => (
        <button
          key={mode}
          type="button"
          disabled={disabled}
          aria-disabled={disabled || undefined}
          aria-pressed={value === mode}
          aria-label={optionLabel}
          title={disabled ? (hint ?? optionLabel) : optionLabel}
          onClick={() => onChange(mode)}
          className={`flex items-center gap-1.5 px-3 font-medium transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white disabled:opacity-40 disabled:cursor-not-allowed ${inMenu ? 'min-h-8 w-full text-left' : 'h-full'} ${value === mode ? 'bg-bambu-green text-white' : 'text-bambu-gray hover:text-white hover:bg-bambu-dark-tertiary'}`}
        >
          <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span className={inMenu ? '' : 'max-[761px]:hidden'}>{optionLabel}</span>
        </button>
      ))}
    </div>
  );
}
