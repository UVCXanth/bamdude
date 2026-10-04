import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Ban,
  CheckCircle2,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  PackageCheck,
  PackagePlus,
  Pencil,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '../../../contexts/AuthContext';
import { CardActionMenu, CardActionMenuItem } from '../../CardActionMenu';
import { orderMenuItems, type OrderAction } from './orderMenu';
import type { OrderRef } from './orderRef';
import type { OrderActions, RunExtra } from './useOrderActions';

const ICONS: Record<OrderAction, LucideIcon> = {
  open: ExternalLink,
  edit: Pencil,
  duplicate: Copy,
  fulfil: PackageCheck,
  bank: PackagePlus,
  complete: CheckCircle2,
  cancel: Ban,
  reopen: RotateCcw,
  cover: ImageIcon,
  delete: Trash2,
};

/**
 * The order's action menu (WS-13 E6 B02–B03) — one trigger, «Order actions <code>»,
 * the same items wherever an order is shown. No allowed item, no trigger.
 */
export function OrderActionMenu({
  order,
  context,
  actions,
  extra,
  testId,
}: {
  order: OrderRef;
  context: 'detail' | 'list';
  actions: OrderActions;
  /** What the door has beyond the ref — passed to every action it runs. */
  extra?: RunExtra;
  testId?: string;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const items = orderMenuItems(
    order,
    {
      update: hasPermission('orders:update'),
      create: hasPermission('orders:create'),
      remove: hasPermission('orders:delete'),
    },
    context,
  );
  if (items.length === 0) return null;

  return (
    <CardActionMenu
      label={t('orders.actions.menu', { code: order.code })}
      testId={testId}
      width="max-content"
      estimatedHeight={36 * items.length + 16}
    >
      {(close) =>
        items.map((item) => {
          const Icon = ICONS[item.action];
          return (
            <Fragment key={item.action}>
              {item.separatorBefore && <div role="separator" className="my-1 border-t border-bambu-dark-tertiary" />}
              <CardActionMenuItem
                danger={item.danger}
                onSelect={() => {
                  close();
                  actions.run(item.action, order, extra);
                }}
              >
                <Icon className="w-4 h-4" />
                {t(`orders.actions.${item.action}`)}
              </CardActionMenuItem>
            </Fragment>
          );
        })
      }
    </CardActionMenu>
  );
}
