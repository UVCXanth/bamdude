import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardPlus, Pencil, Trash2 } from 'lucide-react';
import type { Customer } from '../../api/client';
import { CardActionMenu, CardActionMenuItem } from '../CardActionMenu';
import type { CustomerAction, CustomerActionsHost } from './useCustomerActions';

const ICON: Record<CustomerAction, ReactNode> = {
  edit: <Pencil className="w-4 h-4" />,
  newOrder: <ClipboardPlus className="w-4 h-4" />,
  delete: <Trash2 className="w-4 h-4" />,
};

/**
 * The one menu of a customer (WS-13 E11 H02) — the table row, the card and the customer's
 * page render THIS, and every item is the page's action host: «Edit» · «New order» ·
 * «Delete», the dangerous one after a separator. An item the user may not take is not
 * offered; with none, there is no menu. The page's header shows «Edit» and «New order» as
 * buttons, so its menu leaves them out (`exclude`).
 */
export function CustomerActionMenu({
  customer,
  actions,
  exclude = [],
}: {
  customer: Customer;
  actions: CustomerActionsHost;
  exclude?: readonly CustomerAction[];
}) {
  const { t } = useTranslation();
  const offered = actions.available(customer).filter((action) => !exclude.includes(action));
  if (offered.length === 0) return null;
  return (
    <CardActionMenu
      label={t('customers.actions.menu', { name: customer.name })}
      testId={`customer-${customer.id}-menu`}
      width="max-content"
    >
      {(close) =>
        offered.map((action, index) => (
          <Fragment key={action}>
            {action === 'delete' && index > 0 && <div role="separator" className="my-1 border-t border-bambu-dark-tertiary" />}
            <CardActionMenuItem
              danger={action === 'delete'}
              onSelect={() => {
                close();
                actions.run(action, customer);
              }}
            >
              {ICON[action]}
              {t(`customers.actions.${action}`)}
            </CardActionMenuItem>
          </Fragment>
        ))
      }
    </CardActionMenu>
  );
}
