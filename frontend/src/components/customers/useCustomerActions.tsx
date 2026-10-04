import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import type { Customer } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { invalidateAfterDelete } from '../../utils/queryInvalidation';
import { useOrderActions } from '../projects/orderActions/useOrderActions';
import { ActionConfirm } from '../workshop/ActionConfirm';
import { CustomerModal } from './CustomerModal';

export type CustomerAction = 'edit' | 'newOrder' | 'delete';

/** What a page hands its doors — the row's menu, the card's, the customer page's header. */
export interface CustomerActionsHost {
  /** The actions this user may take, in the menu's order (H02). */
  available: (c: Customer) => CustomerAction[];
  run: (action: CustomerAction, c: Customer) => void;
  /** The form, the confirmation and the order form — mounted here and nowhere else. */
  host: ReactNode;
}

type Active = { kind: 'edit'; customer: Customer } | { kind: 'delete'; customer: Customer };

/**
 * The ONE host of a customer's actions (WS-13 E11 H01, after E8-F01): the list's rows and
 * cards and the customer's page all run through it — the same rights, the same
 * confirmation, the same invalidation wherever an action starts.
 *
 * «New order» is the order form with this customer chosen (`useOrderActions().create`),
 * which goes to the new order when it is saved. «Delete» says what the delete does with
 * the server's last figures (H03): the orders it unlinks, what happens to the active ones,
 * and — always — that issued dispatch notes keep the recipient's name.
 *
 * ⚠️ **It outlives its doors (E8-F08).** A dialog holds a snapshot of the customer it was
 * opened for; a re-read that drops the row changes nothing about it. When it closes, the
 * focus goes back to its opener while that is on the page, else to the page's heading —
 * after a delete always the heading, the row being gone (H05) — never BODY.
 */
export function useCustomerActions({
  context,
  fallbackFocusRef,
  onDeleted,
}: {
  context: 'list' | 'detail';
  fallbackFocusRef: RefObject<HTMLElement | null>;
  /** `detail` only: forget the customer's entry and go to the list. */
  onDeleted?: (c: Customer) => void;
}): CustomerActionsHost {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const orders = useOrderActions({ fallbackFocusRef });
  const [active, setActive] = useState<Active | null>(null);
  const opened = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const toHeading = useRef(false);

  const open = (next: Active) => {
    if (opener.current == null) {
      const focused = document.activeElement;
      opener.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    }
    setActive(next);
  };

  // The dialog has closed: the focus goes back to its opener while it is on the page, else
  // to the heading — late enough for the Modal's own return to have run (E6-B07).
  useEffect(() => {
    if (active) {
      opened.current = true;
      return;
    }
    if (!opened.current) return;
    opened.current = false;
    const back = opener.current;
    opener.current = null;
    const timer = window.setTimeout(() => {
      if (toHeading.current) {
        toHeading.current = false;
        fallbackFocusRef.current?.focus();
        return;
      }
      const now = document.activeElement;
      if (now != null && now !== document.body) return;
      const usable = back != null && back.isConnected && !back.closest('[inert]') && !(back as HTMLButtonElement).disabled;
      (usable ? back : fallbackFocusRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, fallbackFocusRef]);

  const available: CustomerActionsHost['available'] = () => {
    const out: CustomerAction[] = [];
    if (hasPermission('customers:update')) out.push('edit');
    if (hasPermission('orders:create')) out.push('newOrder');
    if (hasPermission('customers:delete')) out.push('delete');
    return out;
  };

  const run: CustomerActionsHost['run'] = (action, c) => {
    if (action === 'newOrder') {
      orders.create(c.id);
      return;
    }
    open({ kind: action, customer: c });
  };

  const remove = (c: Customer) => async () => {
    await api.deleteCustomer(c.id);
    // The row goes with the customer: the focus returns to the heading (H04, H05).
    toHeading.current = true;
    if (context === 'list') {
      invalidateAfterDelete(queryClient, 'customer', c.id);
    } else {
      invalidateAfterDelete(queryClient, 'customer');
      onDeleted?.(c);
    }
    showToast(t('customers.toast.deleted'));
  };

  const close = () => setActive(null);
  let dialog: ReactNode = null;
  if (active?.kind === 'edit') {
    dialog = <CustomerModal key={`edit-${active.customer.id}`} customer={active.customer} onClose={close} />;
  } else if (active?.kind === 'delete') {
    const { figures } = active.customer;
    dialog = (
      <ActionConfirm
        key={`delete-${active.customer.id}`}
        title={t('customers.confirm.deleteTitle')}
        subtitle={`${active.customer.code} · ${active.customer.name}`}
        body={
          <div className="space-y-2 text-sm text-bambu-gray-light">
            {figures != null && figures.projects > 0 && <p>{t('customers.confirm.orders', { count: figures.projects })}</p>}
            {figures != null && figures.active > 0 && <p>{t('customers.confirm.active', { count: figures.active })}</p>}
            <p>{t('customers.confirm.always')}</p>
          </div>
        }
        primaryLabel={t('customers.confirm.delete')}
        danger
        send={remove(active.customer)}
        onClose={close}
      />
    );
  }

  return {
    available,
    run,
    host: (
      <>
        {dialog}
        {orders.dialogs}
      </>
    ),
  };
}
