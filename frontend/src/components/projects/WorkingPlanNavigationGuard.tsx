import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { UNSAFE_DataRouterContext, useBlocker, type Location } from 'react-router';
import { useTranslation } from 'react-i18next';
import { WorkingPlanNavigationDecision } from './workingPlanNavigation';

const NavigationOwners = createContext<((confirm: () => boolean, orderId?: number) => () => void) | null>(null);

function keepsEditor(current: Location, next: Location, orderId?: number) {
  if (current.pathname !== next.pathname) return false;
  const before = new URLSearchParams(current.search), after = new URLSearchParams(next.search);
  before.delete('section'); after.delete('section');
  if (current.pathname !== '/projects') { before.delete('tab'); after.delete('tab'); }
  // Selecting a tab on the workspace's implicit first order also names it.
  if (orderId && after.get('order') === String(orderId) && (!before.get('order') || before.get('order') === String(orderId))) {
    before.delete('order'); after.delete('order');
  }
  before.sort(); after.sort();
  return before.toString() === after.toString();
}

/** React Router supports one blocker; all mounted editors share that owner. */
export function WorkingPlanNavigationProvider({ children }: { children: ReactNode }) {
  const owners = useRef(new Map<() => boolean, number | undefined>());
  const [count, setCount] = useState(0);
  const register = useCallback((confirm: () => boolean, orderId?: number) => {
    owners.current.set(confirm, orderId);
    setCount(owners.current.size);
    return () => { owners.current.delete(confirm); setCount(owners.current.size); };
  }, []);
  const confirm = useCallback(() => [...owners.current.keys()].every(leave => leave()), []);
  const shouldBlock = useCallback((current: Location, next: Location) =>
    [...owners.current.values()].some(id => !keepsEditor(current, next, id)), []);
  return <NavigationOwners.Provider value={register}><WorkingPlanNavigationDecision.Provider value={confirm}>
    <RouteGuard dirty={count > 0} confirm={confirm} shouldBlock={shouldBlock} />{children}
  </WorkingPlanNavigationDecision.Provider></NavigationOwners.Provider>;
}

/** Local input may be discarded explicitly; leaving never launches an async save. */
export function WorkingPlanNavigationGuard({ dirty, onLeaveGuard, orderId }: {
  dirty: boolean;
  orderId?: number;
  onLeaveGuard?: (guard: (() => boolean) | null) => void;
}) {
  const { t } = useTranslation();
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const register = useContext(NavigationOwners);
  const confirm = useCallback(() => !dirty || window.confirm(t('workingPlan.leaveConfirm')), [dirty, t]);
  useEffect(() => {
    if (dirty && register) return register(confirm, orderId);
  }, [dirty, register, confirm, orderId]);
  useEffect(() => {
    onLeaveGuard?.(confirm);
    return () => onLeaveGuard?.(null);
  }, [confirm, onLeaveGuard]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty]);
  return dataRouter && !register ? <RouteGuard dirty={dirty} confirm={confirm} /> : null;
}

function RouteGuard({ dirty, confirm, shouldBlock = (current, next) => !keepsEditor(current, next) }: {
  dirty: boolean; confirm: () => boolean; shouldBlock?: (current: Location, next: Location) => boolean;
}) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && shouldBlock(currentLocation, nextLocation));
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (confirm()) blocker.proceed();
    else blocker.reset();
  }, [blocker, confirm]);
  return null;
}
