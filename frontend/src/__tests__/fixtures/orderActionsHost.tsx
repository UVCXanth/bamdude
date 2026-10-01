import { useRef, type ReactNode } from 'react';
import { useOrderActions, type OrderActions } from '../../components/projects/orderActions/useOrderActions';

/**
 * A page-level order action host for a test (WS-13 E6 B01): what `OrdersPage` /
 * `CustomerPage` / `OrderPage` do — the host above the doors, its dialogs beside them.
 */
export function WithOrderActions({ children }: { children: (actions: OrderActions) => ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { run, create, dialogs } = useOrderActions({ fallbackFocusRef: heading });
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Test page
      </h1>
      {children({ run, create })}
      {dialogs}
    </>
  );
}

/** For a door whose actions a test does not exercise. */
export const NO_ACTIONS: OrderActions = { run: () => {}, create: () => {} };
