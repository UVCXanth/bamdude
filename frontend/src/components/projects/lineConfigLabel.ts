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
