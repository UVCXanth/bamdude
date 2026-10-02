import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import type { Order, OrderListItem } from '../../../api/client';
import { BankSurplusDialog } from '../BankSurplusDialog';
import { DuplicateOrderModal } from '../DuplicateOrderModal';
import { OrderModal } from '../OrderModal';
import { OrderCoverDialog } from '../OrderCover';
import { FulfilmentDialog } from '../fulfilment/FulfilmentDialog';
import type { FulfilmentMode } from '../fulfilment/fulfilmentState';
import type { OrderAction } from './orderMenu';
import { isOrderDetail as isDetail, type OrderRef } from './orderRef';
import { OrderStatusConfirm, type OrderConfirmKind } from './OrderStatusConfirm';

/** What a door can add to an action: the full source it has, the issue dialog's start. */
export interface RunExtra {
  mode?: FulfilmentMode;
  complete?: boolean;
  /** The full detail or the list row the door has — the dialogs that need more than the ref read it. */
  order?: Order | OrderListItem;
  /** Set by a view that observes the order's own query: it forgets the entry when it unmounts. */
  onDeleted?: () => void;
}

/** What a page hands down: every door calls these, nothing else. */
export interface OrderActions {
  run: (action: OrderAction, ref: OrderRef, extra?: RunExtra) => void;
  create: (defaultCustomerId?: number | null) => void;
}

type Active =
  | { kind: 'create'; defaultCustomerId: number | null }
  | { kind: 'edit'; ref: OrderRef; order: Order | OrderListItem | undefined }
  | { kind: 'duplicate'; ref: OrderRef }
  | { kind: 'fulfil'; ref: OrderRef; mode: FulfilmentMode; complete: boolean }
  | { kind: 'confirm'; which: OrderConfirmKind; ref: OrderRef; onDeleted?: () => void }
  | { kind: 'bank'; ref: OrderRef; order: Order | undefined }
  | { kind: 'cover'; order: Order };

/**
 * The ONE host of an order's dialogs (WS-13 E6 B01): the form, the duplicate, the
 * issue dialog, the cover, and the lifecycle confirmations — mounted here and nowhere
 * else, called by a PAGE (`OrdersPage`, `CustomerPage`, `OrderPage`), never by a row
 * or a view.
 *
 * ⚠️ **It outlives its doors (R02).** An action holds a snapshot of the order it was
 * opened for; a refetch that drops the row, a workspace that moves to another order
 * or an emptied list changes nothing about the open dialog. When the last dialog
 * closes and the element that opened it has gone — or is about to, after a delete —
 * focus lands on the page's own heading (`fallbackFocusRef`, B07) — never on BODY.
 *
 * ⚠️ **The host remembers who opened the FIRST dialog (B07).** A Modal records its
 * opener when it mounts; one that replaces another in the same commit — the form after
 * its reading shell, «Stock & issue» after its own, a confirmation after the form —
 * finds the old panel already gone and records BODY. So the element that was focused
 * when an action started (a menu gives focus back to its trigger before it runs one) is
 * kept here until the chain ends, and gets focus back while it is still on the page.
 */
export function useOrderActions({
  fallbackFocusRef,
  onDeleted,
}: {
  fallbackFocusRef: RefObject<HTMLElement | null>;
  onDeleted?: (id: number) => void;
}): OrderActions & { dialogs: ReactNode } {
  const navigate = useNavigate();
  const [active, setActive] = useState<Active | null>(null);
  const opened = useRef(false);
  // The element focused when the first dialog of a chain opened — kept until the chain ends.
  const opener = useRef<HTMLElement | null>(null);
  // A delete takes the order's row away: the heading gets the focus whatever the Modal gave back.
  const toHeading = useRef(false);

  const open = (next: Active) => {
    if (opener.current == null) {
      const focused = document.activeElement;
      opener.current = focused instanceof HTMLElement && focused !== document.body ? focused : null;
    }
    setActive(next);
  };

  // The last dialog has closed: focus goes back to the element that opened the chain
  // while it is still on the page, else to the page's heading — never BODY. Late enough
  // for the Modal's own return to have run (and for the page to be live again).
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

  const run: OrderActions['run'] = (action, ref, extra = {}) => {
    switch (action) {
      case 'open':
        navigate(`/projects/${ref.id}`);
        return;
      case 'edit':
        open({ kind: 'edit', ref, order: extra.order });
        return;
      case 'duplicate':
        open({ kind: 'duplicate', ref });
        return;
      case 'fulfil':
        open({ kind: 'fulfil', ref, mode: extra.mode ?? 'all', complete: extra.complete ?? false });
        return;
      case 'complete':
        open({ kind: 'fulfil', ref, mode: 'all', complete: true });
        return;
      case 'bank':
        open({ kind: 'bank', ref, order: isDetail(extra.order) ? extra.order : undefined });
        return;
      case 'cancel':
      case 'reopen':
        open({ kind: 'confirm', which: action, ref });
        return;
      case 'delete':
        open({ kind: 'confirm', which: 'delete', ref, onDeleted: extra.onDeleted });
        return;
      case 'cover':
        if (isDetail(extra.order)) open({ kind: 'cover', order: extra.order });
        return;
    }
  };

  const create: OrderActions['create'] = (defaultCustomerId = null) =>
    open({ kind: 'create', defaultCustomerId: defaultCustomerId ?? null });

  const close = () => setActive(null);

  let dialogs: ReactNode = null;
  if (active?.kind === 'create') {
    dialogs = <OrderModal order={null} defaultCustomerId={active.defaultCustomerId} onClose={close} />;
  } else if (active?.kind === 'edit') {
    // The detail hands its full order over; a list row is read in full by the form (C07).
    dialogs = (
      <OrderModal
        order={isDetail(active.order) ? active.order : undefined}
        orderId={isDetail(active.order) ? undefined : active.ref.id}
        onClose={close}
        // The form's status is a step of its own, run here with the order as saved (C06) — and
        // only while the order as saved still allows it: somebody may have closed it meanwhile.
        onStatusAction={(saved, next) => {
          const fromActive = saved.status === 'active';
          if (next === 'active' ? fromActive : !fromActive) return;
          run(next === 'completed' ? 'complete' : next === 'cancelled' ? 'cancel' : 'reopen', saved);
        }}
      />
    );
  } else if (active?.kind === 'duplicate') {
    dialogs = <DuplicateOrderModal order={active.ref} onClose={close} />;
  } else if (active?.kind === 'fulfil') {
    dialogs = <FulfilmentDialog order={active.ref} mode={active.mode} complete={active.complete} onClose={close} />;
  } else if (active?.kind === 'confirm') {
    dialogs = (
      <OrderStatusConfirm
        kind={active.which}
        order={active.ref}
        onClose={close}
        onDeleted={active.onDeleted}
        onPageDeleted={(id) => {
          // The trigger the Modal gives focus back to is about to leave with the row (B07).
          toHeading.current = true;
          onDeleted?.(id);
        }}
      />
    );
  } else if (active?.kind === 'bank') {
    dialogs = <BankSurplusDialog order={active.ref} detail={active.order} onClose={close} />;
  } else if (active?.kind === 'cover') {
    dialogs = <OrderCoverDialog order={active.order} onClose={close} />;
  }

  return { run, create, dialogs };
}
