import type { TFunction } from 'i18next';
import type { LineConfiguration, LineMode } from '../../api/client';

/**
 * The caption under a line's product (spec workshop-product-variants, rule 26):
 * the options that differ from the standard and how many parts changed, from
 * the names the server sent — composed here, in the reader's language.
 *
 * A product without variants and without changes says nothing; one whose
 * choices are all standard says so.
 */
/** The accent a configuration caption takes when it says something other than «standard»
 *  — a kit that differs, or a line of loose parts (WS-13 E4 B02; the issue dialog too, E6). */
export const CONFIG_ACCENT_CLASS = 'text-amber-700 dark:text-amber-400';

/** Whether a line's kit differs from the product's standard: an option that is not the
 *  default, or a per-unit count that was changed. */
export function isNonStandardConfiguration(configuration: LineConfiguration | null | undefined): boolean {
  return (
    configuration != null &&
    (configuration.choices.some((c) => !c.is_default) || configuration.changed_parts.length > 0)
  );
}

export function lineConfigLabel(
  configuration: LineConfiguration | undefined,
  mode: LineMode | undefined,
  t: TFunction,
): string {
  if (mode === 'parts') return t('orders.lineConfig.partsOnly');
  const choices = configuration?.choices ?? [];
  const changed = configuration?.changed_parts ?? [];
  const bits = choices.filter((c) => !c.is_default).map((c) => `${c.group_name}: ${c.option_name}`);
  if (changed.length) bits.push(t('orders.lineConfig.changedParts', { count: changed.length }));
  if (bits.length) return bits.join(' · ');
  return choices.length ? t('orders.lineConfig.standard') : '';
}
