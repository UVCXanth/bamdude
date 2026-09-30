import { useTranslation } from 'react-i18next';
import type { LineMode, LinePurchasedPart, PartFigures } from '../../api/client';
import { VARIANT_CHIP } from './chips';

/** The amber chip of a variant part and a bought part (mockup `.m-varchip`). */
const CHIP_CLASS = `ml-1.5 ${VARIANT_CHIP}`;
const CELL = 'px-2.5 py-1.5';

/**
 * What one order line still needs, part by part (WS-13 E4 C01–C04).
 *
 * Every number is a server figure (`need` / `usable` / `in_progress` / `queued` /
 * `remaining` / `surplus`) — the table only decides which of them to make loud.
 * `remaining > 0` is the work left and is bold; `surplus > 0` is amber because it is
 * neither an error nor nothing: somebody printed more of a part than this line asks
 * for, which is either a spare or a plate that should have been sliced smaller.
 *
 * ⚠️ **The seven columns stay for either kind of line**, so two expanded lines do not
 * jump against each other: a parts line wants each part as a count (its «per unit» IS
 * the need), so its «per unit» cell says «—» rather than disappearing.
 *
 * ⚠️ **A per-unit count of 0 is data**: a part the line's configuration dropped but the
 * order printed — out of the kit, its prints all surplus. A part marked «not counted»
 * never arrives here; the server leaves it out.
 *
 * Bought parts follow the printed ones. How many were bought is the order's
 * procurement, not a line's — the row only says where to look.
 */
export function LinePartsTable({
  parts,
  purchased = [],
  mode,
}: {
  parts: PartFigures[];
  purchased?: LinePurchasedPart[];
  mode?: LineMode;
}) {
  const { t } = useTranslation();
  const perUnit = mode !== 'parts';

  if (parts.length === 0 && purchased.length === 0) {
    return <p className="text-sm text-bambu-gray py-2">{t('orders.parts.none')}</p>;
  }

  return (
    <table className="w-full text-[13px] my-1.5">
      <thead>
        <tr className="text-xs text-bambu-gray text-left">
          <th className={`font-normal ${CELL}`}>{t('orders.parts.name')}</th>
          <th className={`font-normal ${CELL}`}>{t('orders.parts.perUnit')}</th>
          <th className={`font-normal ${CELL}`}>{t('orders.parts.need')}</th>
          <th className={`font-normal ${CELL}`}>{t('orders.parts.usable')}</th>
          <th className={`font-normal ${CELL}`}>{t('orders.parts.inWorkQueued')}</th>
          <th className={`font-normal ${CELL}`}>{t('orders.parts.remaining')}</th>
          <th className={`font-normal ${CELL}`}>{t('orders.parts.surplus')}</th>
        </tr>
      </thead>
      <tbody>
        {parts.map((part) => (
          <tr key={part.part_id} className="border-t border-bambu-dark-tertiary text-white">
            <td className={CELL}>
              {part.name}
              {part.variant && <span className={CHIP_CLASS}>{t('orders.parts.variant')}</span>}
            </td>
            <td className={`${CELL} tabular-nums`}>
              {!perUnit ? (
                <span className="text-bambu-gray">—</span>
              ) : part.qty_per_unit === 0 ? (
                <span className="text-xs text-bambu-gray">{t('orders.parts.outOfKit')}</span>
              ) : (
                `× ${part.qty_per_unit}`
              )}
            </td>
            <td className={`${CELL} tabular-nums`}>{part.need}</td>
            <td className={`${CELL} tabular-nums`}>{part.usable}</td>
            <td className={`${CELL} tabular-nums`}>{`${part.in_progress} / ${part.queued ?? 0}`}</td>
            <td
              data-testid={`part-${part.part_id}-remaining`}
              className={`${CELL} tabular-nums ${part.remaining > 0 ? 'font-semibold' : ''}`}
            >
              {part.remaining}
            </td>
            <td
              data-testid={`part-${part.part_id}-surplus`}
              className={`${CELL} tabular-nums ${part.surplus > 0 ? 'text-amber-700 dark:text-amber-400' : ''}`}
            >
              {part.surplus}
            </td>
          </tr>
        ))}
        {purchased.map((part) => (
          <tr key={`bought-${part.part_id}`} className="border-t border-bambu-dark-tertiary text-bambu-gray-light">
            <td className={CELL}>
              {part.name}
              <span className={CHIP_CLASS}>{t('orders.parts.purchased')}</span>
              {part.variant && <span className={CHIP_CLASS}>{t('orders.parts.variant')}</span>}
            </td>
            <td className={`${CELL} tabular-nums`}>{`× ${part.per}`}</td>
            <td className={`${CELL} tabular-nums`}>{part.need}</td>
            <td colSpan={4} className={`${CELL} text-xs text-bambu-gray`}>
              {t('orders.parts.purchasedNote')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
